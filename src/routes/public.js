'use strict';

const path = require('path');
const express = require('express');
const { requireCanonicalPlanType, getPlanLabel } = require('../config/plan-registry');
const {
    parseSessionJson,
    normalizeSessionToken,
    buildStoredSessionPayload,
    validateAccessToken,
    extractSessionPreview,
    extractEmailFromSession
} = require('../utils/session-parser');
const {
    sanitizeCustomerTaskMessage,
    getRemainingCooldownMinutes
} = require('../utils/task-messages');
const gptApi = require('../services/gpt-api-client');
const {
    validateSessionTokenForQuery,
    querySubscriptionBySession
} = require('../services/subscription-check');
const { forwardAsyncErrors } = require('../middleware/async-handler');

function getPlanTypeLabel(planType) {
    return getPlanLabel(planType, { full: true });
}

function createPublicRouter({
    store,
    ensureStoreReady,
    security,
    taskHub,
    runGptApiWorker,
    publicDir
}) {
    const router = forwardAsyncErrors(express.Router());

    async function handleActivationRequest(req, res) {
        const rawSession = String(req.body?.session || req.body?.token || '').trim();
        const sessionJson = parseSessionJson(rawSession);
        const token = normalizeSessionToken(rawSession);
        const cdk = String(req.body?.cdk || '').trim();
        const clientIp = security.getClientIp(req);
        console.log(`[Activation] 收到开通请求 path=${req.path} cdk=${cdk} session_json=${Boolean(sessionJson)} token_len=${token.length}`);

        if (!token) {
            return res.status(400).json({ success: false, message: '缺少 Session JSON 或 AccessToken' });
        }
        if (!cdk) {
            return res.status(400).json({ success: false, message: '缺少 CDK' });
        }
        const tokenCheck = validateAccessToken(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        try {
            await ensureStoreReady();
            const maintenanceModeState = await store.getMaintenanceModeState();
            if (maintenanceModeState.enabled) {
                return res.status(503).json({ success: false, message: '系统维护中，请稍后再试' });
            }
            const maxConcurrentActivations = await store.getMaxConcurrentActivations();
            if (taskHub.getActiveForegroundJobsCount() >= maxConcurrentActivations) {
                return res.status(429).json({ success: false, message: '当前任务过多，请稍后再试' });
            }

            const cdkDetails = await store.verifyCdkDetails(cdk);
            const runningTask = cdkDetails ? await store.getRunningTaskByCdk(cdk) : null;
            if (runningTask) {
                return res.json({
                    success: true,
                    jobKey: runningTask.job_key,
                    message: sanitizeCustomerTaskMessage(runningTask.message)
                        || '该 CDK 正在开通中，已为您恢复等待进度'
                });
            }
            const manualHold = cdkDetails ? await store.getActivationManualHold(cdk) : null;
            if (manualHold) {
                return res.status(409).json({
                    success: false,
                    code: 'manual_review_required',
                    manualReview: true,
                    message: '该卡密上一次开通失败，已转人工确认，请联系客服处理后再试'
                });
            }
            if (!cdkDetails || cdkDetails.used_at || cdkDetails.type !== '自助') {
                return res.status(403).json({ success: false, message: 'CDK 无效、已使用或非自助激活码' });
            }

            const rawPlanType = String(cdkDetails.plan_type || 'plus').trim();
            let planType;
            try {
                planType = requireCanonicalPlanType(rawPlanType, 'plan_type');
            } catch (_) {
                return res.status(400).json({
                    success: false,
                    message: '当前仅支持 ChatGPT Plus 激活码开通，该卡密套餐已停售，请联系客服处理'
                });
            }

            const cdkCooldownMinutes = getRemainingCooldownMinutes(cdkDetails.cooldown_until);
            if (cdkCooldownMinutes > 0) {
                return res.status(403).json({
                    success: false,
                    message: `该卡密连续失败次数过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`
                });
            }

            if (clientIp) {
                const ipAttemptLimit = await store.getActivationAttemptLimit('ip', clientIp);
                const ipCooldownMinutes = getRemainingCooldownMinutes(ipAttemptLimit?.cooldown_until);
                if (ipCooldownMinutes > 0) {
                    return res.status(403).json({
                        success: false,
                        message: `当前 IP 连续失败次数过多，请冷静 ${ipCooldownMinutes} 分钟后再试`
                    });
                }
            }

            const gptApiConfig = await store.getGptApiConfig();
            if (!gptApiConfig.enabled || !gptApiConfig.api_key) {
                return res.status(503).json({
                    success: false,
                    message: '第三方代充 API 未启用或未配置 API Key，请先在后台「系统配置」中完成配置'
                });
            }

            if (gptApiConfig.card_source === 'local') {
                const hasCard = await store.hasAvailableCard();
                if (!hasCard) {
                    security.fireTelegramNotification('card_pool_empty', {
                        email: extractEmailFromSession(rawSession),
                        planType,
                        cdk,
                        message: '银行卡池暂无可用卡片，任务未启动'
                    });
                    return res.status(503).json({
                        success: false,
                        message: '银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试'
                    });
                }
            }

            const lockSuccess = await store.markCdkUsed(cdk);
            if (!lockSuccess) {
                return res.status(403).json({ success: false, message: 'CDK 不可用或正在被他人使用' });
            }

            const storedSession = buildStoredSessionPayload(rawSession, sessionJson, token);
            const task = await store.createTaskLog({
                tokenPreview: extractSessionPreview(storedSession),
                sessionPayload: storedSession,
                cdkCode: cdk,
                phone: null,
                cardLast4: null,
                status: 'running',
                progress: 3
            });

            taskHub.logTask(task.jobKey, `任务已创建，CDK=${cdk} mode=gpt-api card_source=${gptApiConfig.card_source}`);
            taskHub.reserveForegroundSlot(task.jobKey);

            runGptApiWorker({
                task,
                token,
                session: JSON.parse(storedSession),
                cdk,
                planType,
                clientIp
            }).catch((error) => {
                console.error(`[GPT API Worker] ${task.jobKey}:`, error);
            });

            return res.json({
                success: true,
                jobKey: task.jobKey,
                message: '任务已启动，正在为您开通中...'
            });
        } catch (error) {
            try { await store.markCdkUnused(cdk); } catch (_) { /* ignore */ }
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    async function queryCdkStatus(cdk) {
        const cdkData = await store.verifyCdkDetails(cdk);
        if (!cdkData) {
            return {
                cdk,
                status: '未找到',
                type: null,
                planType: null,
                planLabel: null,
                createdAt: null,
                jobKey: null,
                usedAt: null,
                accountEmail: null
            };
        }

        const runningTask = await store.getRunningTaskByCdk(cdk);
        const latestTask = await store.getLatestTaskByCdk(cdk);
        const status = runningTask ? '开通中' : (cdkData.used_at ? '已使用' : '未使用');
        const planType = cdkData.plan_type || 'plus';
        const accountEmail = extractEmailFromSession(latestTask?.session_payload)
            || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(latestTask?.token_preview || '').trim())
                ? String(latestTask.token_preview).trim()
                : null);
        return {
            cdk,
            status,
            type: cdkData.type || '自助',
            planType,
            planLabel: getPlanTypeLabel(planType),
            createdAt: cdkData.created_at,
            jobKey: runningTask?.job_key || null,
            usedAt: cdkData.used_at
                ? new Date(cdkData.used_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
                : null,
            accountEmail
        };
    }

    router.get('/subscription', (req, res) => {
        res.sendFile(path.join(publicDir, 'subscription.html'));
    });

    router.get('/api/public/runtime', async (req, res) => {
        try {
            await ensureStoreReady();
            const maxConcurrentActivations = await store.getMaxConcurrentActivations();
            return res.json({
                success: true,
                runtime: {
                    active_foreground_jobs: taskHub.getActiveForegroundJobsCount(),
                    max_foreground_jobs: Math.max(1, Number(maxConcurrentActivations || 1))
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/api/public/subscription/check', async (req, res) => {
        if (!security.enforcePublicCdkQuota(req, res, 'subscription')) {
            return;
        }
        try {
            const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
            if (!rawSession) {
                return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
            }

            const token = normalizeSessionToken(rawSession);
            const tokenCheck = validateSessionTokenForQuery(token);
            if (!tokenCheck.valid) {
                return res.status(400).json({ success: false, message: tokenCheck.message });
            }

            const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
            const result = await querySubscriptionBySession(token, {
                timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                    ? timezoneOffsetMin
                    : -new Date().getTimezoneOffset(),
                email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
            });

            if (!result.ok) {
                return res.status(result.statusCode || 502).json({
                    success: false,
                    message: result.error || '查询订阅失败'
                });
            }

            return res.json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post(
        '/api/run-process',
        (req, res, next) => (security.enforcePublicCdkQuota(req, res, 'activation') ? next() : undefined),
        handleActivationRequest
    );

    router.post('/api/verify-cdk', async (req, res) => {
        const rawCdk = req.body?.cdk;
        const cdk = (typeof rawCdk === 'string' || typeof rawCdk === 'number') ? String(rawCdk).trim() : '';
        const clientIp = security.getClientIp(req);
        if (!cdk) {
            return res.status(400).json({ success: false, message: '请输入 CDK' });
        }
        if (!security.enforcePublicCdkQuota(req, res, 'lookup')) {
            return;
        }

        try {
            await ensureStoreReady();
            const cdkData = await store.verifyCdkDetails(cdk);
            const runningTask = cdkData ? await store.getRunningTaskByCdk(cdk) : null;
            if (cdkData && runningTask) {
                return res.json({
                    success: true,
                    data: {
                        type: cdkData.type || '自助',
                        plan_type: cdkData.plan_type || 'plus',
                        plan_label: getPlanTypeLabel(cdkData.plan_type || 'plus'),
                        status: 'processing',
                        jobKey: runningTask.job_key,
                        message: sanitizeCustomerTaskMessage(runningTask.message) || '当前 CDK 正在开通中'
                    }
                });
            }
            const manualHold = cdkData ? await store.getActivationManualHold(cdk) : null;
            if (manualHold) {
                return res.status(409).json({
                    success: false,
                    code: 'manual_review_required',
                    manualReview: true,
                    message: '该卡密上一次开通失败，已转人工确认，请联系客服处理后再试'
                });
            }
            if (cdkData && !cdkData.used_at) {
                const rawPlanType = String(cdkData.plan_type || 'plus').trim();
                try {
                    requireCanonicalPlanType(rawPlanType, 'plan_type');
                } catch (_) {
                    return res.status(400).json({
                        success: false,
                        message: '当前仅支持 ChatGPT Plus 激活码开通，该卡密套餐已停售，请联系客服处理'
                    });
                }
                if (cdkData.type === '自助') {
                    const cdkCooldownMinutes = getRemainingCooldownMinutes(cdkData.cooldown_until);
                    if (cdkCooldownMinutes > 0) {
                        return res.status(403).json({
                            success: false,
                            message: `该卡密连续失败次数过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`
                        });
                    }
                    if (clientIp) {
                        const ipAttemptLimit = await store.getActivationAttemptLimit('ip', clientIp);
                        const ipCooldownMinutes = getRemainingCooldownMinutes(ipAttemptLimit?.cooldown_until);
                        if (ipCooldownMinutes > 0) {
                            return res.status(403).json({
                                success: false,
                                message: `当前 IP 连续失败次数过多，请冷静 ${ipCooldownMinutes} 分钟后再试`
                            });
                        }
                    }
                }
                return res.json({
                    success: true,
                    data: {
                        type: cdkData.type || '自助',
                        plan_type: cdkData.plan_type || 'plus',
                        plan_label: getPlanTypeLabel(cdkData.plan_type || 'plus')
                    }
                });
            }

            return res.status(403).json({ success: false, message: cdkData?.used_at ? '该 CDK 已使用' : '无效 CDK' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/api/cdk/query', async (req, res) => {
        const cdk = String(req.query.cdk || '').trim();
        if (!cdk) {
            return res.status(400).json({ success: false, message: '请输入查询激活码' });
        }
        if (!security.enforcePublicCdkQuota(req, res, 'lookup')) {
            return;
        }

        try {
            await ensureStoreReady();
            const data = await queryCdkStatus(cdk);
            if (data.status === '未找到') {
                return res.status(404).json({ success: false, message: '未找到该激活码记录' });
            }
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/api/cdk/query-batch', async (req, res) => {
        const rawCodes = Array.isArray(req.body?.cdks)
            ? req.body.cdks.join('\n')
            : String(req.body?.cdks || req.body?.codes || '');
        const cdks = [...new Set(rawCodes
            .split(/[\s,，;；]+/)
            .map((code) => code.trim())
            .filter(Boolean))];
        if (!cdks.length) {
            return res.status(400).json({ success: false, message: '请输入要查询的卡密，每行一个' });
        }
        if (cdks.length > 100) {
            return res.status(400).json({ success: false, message: '一次最多查询 100 个卡密' });
        }
        if (!security.enforcePublicCdkQuota(req, res, 'lookup', cdks.length)) {
            return;
        }

        try {
            await ensureStoreReady();
            const results = await Promise.all(cdks.map((cdk) => queryCdkStatus(cdk)));
            const summary = results.reduce((counts, item) => {
                const key = item.status === '未找到'
                    ? 'notFound'
                    : item.status === '未使用'
                        ? 'unused'
                        : item.status === '开通中'
                            ? 'processing'
                            : 'used';
                counts[key] += 1;
                return counts;
            }, { total: results.length, unused: 0, processing: 0, used: 0, notFound: 0 });
            return res.json({ success: true, data: { summary, results } });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/api/task-status/:jobKey', async (req, res) => {
        const jobKey = String(req.params.jobKey || '').trim();
        if (!jobKey || jobKey.length > 128) {
            return res.status(400).json({ success: false, message: '缺少有效任务编号' });
        }

        try {
            await ensureStoreReady();
            const task = await store.getTaskStatus(jobKey);
            if (!task) {
                return res.status(404).json({ success: false, message: '未找到该任务' });
            }
            let captcha = taskHub.activeTaskCaptchas.get(jobKey) || null;
            if (!captcha && task.gpt_api_captcha) {
                try {
                    const parsed = JSON.parse(task.gpt_api_captcha);
                    captcha = parsed && typeof parsed === 'object' ? parsed : null;
                } catch (_) { /* ignore */ }
            }
            return res.json({
                success: true,
                data: {
                    jobKey,
                    status: task.status,
                    message: sanitizeCustomerTaskMessage(task.message || ''),
                    progress: Number(task.progress || 0),
                    cdkCode: task.cdk_code || null,
                    phone: task.phone || null,
                    cardLast4: task.card_last4 || null,
                    captcha,
                    isTerminal: taskHub.TERMINAL_TASK_STATUSES.has(task.status)
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/api/task-captcha/:jobKey', async (req, res) => {
        const jobKey = String(req.params.jobKey || '').trim();
        if (!jobKey || jobKey.length > 128) {
            return res.status(400).type('text/plain').send('缺少有效任务编号');
        }

        try {
            await ensureStoreReady();
            const task = await store.getTaskStatus(jobKey);
            if (!task || task.status !== 'running' || !task.gpt_api_order_id) {
                return res.status(409).type('text/plain').send('当前任务不需要人机验证，请返回原页面查看最新状态');
            }

            let storedCaptcha = null;
            try {
                storedCaptcha = task.gpt_api_captcha ? JSON.parse(task.gpt_api_captcha) : null;
            } catch (_) { /* ignore */ }
            const storedStage = String(storedCaptcha?.stage || '').trim().toLowerCase();
            const storedStatus = String(storedCaptcha?.status || '').trim().toLowerCase();
            if (storedStage !== 'awaiting_captcha' && storedStatus !== 'pending') {
                return res.status(409).type('text/plain').send('当前任务不需要人机验证，请返回原页面查看最新状态');
            }

            const cfg = await store.getGptApiConfig();
            if (!cfg.enabled || !cfg.api_key || !gptApi.isDesolateOpenProtocol(cfg)) {
                return res.status(409).type('text/plain').send('当前任务没有可用的验证入口');
            }

            const result = await gptApi.queryOrder(cfg, task.gpt_api_order_id);
            const captcha = result.success ? result.captcha : null;
            const stage = String(result.stage || '').trim().toLowerCase();
            const captchaStatus = String(captcha?.status || '').trim().toLowerCase();
            const pending = stage === 'awaiting_captcha' || captchaStatus === 'pending';
            if (!pending || !captcha?.url) {
                return res.status(409).type('text/plain').send('验证入口暂未就绪，请返回原页面稍后重试');
            }

            let target = null;
            try {
                target = new URL(String(captcha.url));
            } catch (_) {
                return res.status(502).type('text/plain').send('验证入口格式无效，请联系客服处理');
            }
            if (target.protocol !== 'https:') {
                return res.status(502).type('text/plain').send('验证入口不安全，请联系客服处理');
            }

            taskHub.activeTaskCaptchas.set(jobKey, { ...captcha, stage: stage || null });
            res.setHeader('Cache-Control', 'no-store');
            return res.redirect(302, target.toString());
        } catch (error) {
            taskHub.logTask(jobKey, `获取人机验证入口失败: ${error.message}`, 'warn');
            return res.status(502).type('text/plain').send('验证入口获取失败，请返回原页面稍后重试');
        }
    });

    router.get('/api/cdk/download', (req, res) => {
        res.status(410).send('成品号下载功能已移除，仅支持自助开通');
    });

    return {
        router,
        handleActivationRequest
    };
}

module.exports = { createPublicRouter };
