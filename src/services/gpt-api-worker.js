'use strict';

const {
    CANONICAL_PLAN_TYPES,
    requireReadablePlanType,
    getPlanLabel
} = require('../config/plan-registry');
const {
    extractEmailFromSession,
    getActivationAccountKey
} = require('../utils/session-parser');
const {
    GPT_API_CUSTOMER_FAILURE_MESSAGE,
    GPT_API_CUSTOMER_TIMEOUT_MESSAGE,
    getManualReviewMessage,
    sleep: defaultSleep
} = require('../utils/task-messages');
const defaultGptApi = require('./gpt-api-client');
const defaultOrbitcard = require('./orbitcard-client');
const { syncAndAutoAssignOrbitcardCards } = require('./orbitcard-sync');
const { buildGptApiFailureDiagnostic, classifyGptApiFailure } = require('./gpt-api-failure');

const MAX_CARD_SWAP_RETRIES = 1;
const GPT_API_TERMINAL_SUCCESS = new Set(['success', 'succeeded', 'completed', 'paid', 'active', '开通成功', '成功']);
const GPT_API_TERMINAL_FAILED = new Set(['failed', 'declined', 'canceled', 'cancelled', 'error', 'expired', 'rejected', '失败', '取消']);

function isSuccessGptApiStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    return [...GPT_API_TERMINAL_SUCCESS].some((kw) => s.includes(kw.toLowerCase()));
}

function isTerminalGptApiStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    if (!s) return false;
    if (isSuccessGptApiStatus(s)) return true;
    return [...GPT_API_TERMINAL_FAILED].some((kw) => s.includes(kw.toLowerCase()));
}

function mapGptApiPlanKey(planType, cfg = {}, gptApi = defaultGptApi) {
    const type = requireReadablePlanType(planType);
    if (!CANONICAL_PLAN_TYPES.includes(type)) {
        throw new Error(`当前仅支持 ChatGPT Plus 开通，不支持 ${getPlanLabel(type)}`);
    }
    if (gptApi.isDesolateOpenProtocol(cfg)) {
        return gptApi.resolveOpenPlanCode(type, cfg);
    }
    const configured = String(cfg.plan_key || '').trim();
    if (configured && !['plus', 'chatgptplusplan'].includes(configured.toLowerCase())) {
        return configured;
    }
    return type;
}

function sanitizeGptApiRaw(data, openProtocol, responseMeta = null, gptApi = defaultGptApi) {
    if (!openProtocol) return data;
    return gptApi.normalizeOpenOrderSummary(data, responseMeta);
}

function parseCardExpiry(value) {
    const raw = String(value || '').trim();
    const isoMatch = raw.match(/^(\d{4})[-/]((?:0?[1-9])|1[0-2])(?:[-/]\d{1,2})?$/);
    if (isoMatch) return { month: Number(isoMatch[2]), year: Number(isoMatch[1]) };
    const match = raw.match(/^(0?[1-9]|1[0-2])\s*\/?\s*(\d{2}|\d{4})$/);
    if (!match) throw new Error('银行卡有效期格式错误，应为 MMYY、MM/YY 或 MM/YYYY');
    const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return { month: Number(match[1]), year };
}

function createGptApiWorker({
    store,
    gptApi = defaultGptApi,
    orbitcard = defaultOrbitcard,
    activeTaskCaptchas,
    broadcastToTask,
    notifyTaskOutcome,
    logTask,
    releaseForegroundSlot,
    getTotalActiveJobs,
    sleep = defaultSleep,
    env = process.env,
    logger = console
}) {
    const getPlanTypeLabel = (planType) => getPlanLabel(planType, { full: true });

    return async function runGptApiWorker({ task, token, session, cdk, planType }) {
        const { jobKey } = task;
        let sessionPayload = session && typeof session === 'object'
            ? session
            : { access_token: token };
        const accountEmail = extractEmailFromSession(sessionPayload) || '';
        const accountKey = getActivationAccountKey(sessionPayload, token);
        let shouldRollbackCdk = true;
        let reservedCard = null;
        let reservedOrbitcard = null;
        let orbitcardRechargeRecorded = false;
        let activeRechargeJobKey = jobKey;
        let submittedToProvider = false;
        let activeOrderId = '';
        let activeOrderStatus = '';
        let activeRaw = null;
        let activeResponseMeta = null;
        let activePollCount = 0;
        let activeOpenProtocol = false;
        let failureDiagnostic = null;
        const failedOrbitcardIds = new Set();
        const failedLocalCardIds = new Set();

        const releaseOrRetireCurrentCard = async ({ retire = false } = {}) => {
            if (reservedOrbitcard) {
                const orbitcardId = reservedOrbitcard.orbitcard_id;
                reservedOrbitcard = null;
                if (retire) {
                    await store.retireOrbitcardCard(orbitcardId).catch(() => { });
                } else {
                    await store.releaseOrbitcardCard(orbitcardId).catch(() => { });
                }
                return;
            }
            if (reservedCard) {
                const localCardId = reservedCard.id;
                reservedCard = null;
                if (retire && typeof store.markCardExhausted === 'function') {
                    await store.markCardExhausted(localCardId).catch(() => { });
                } else {
                    await store.releaseCard(localCardId).catch(() => { });
                }
            }
        };

        const setProgress = async (status, progress, message, extra = {}) => {
            const hasCaptcha = Object.prototype.hasOwnProperty.call(extra, 'captcha');
            const { captcha, ...taskExtra } = extra;
            if (hasCaptcha) {
                if (captcha) activeTaskCaptchas.set(jobKey, captcha);
                else activeTaskCaptchas.delete(jobKey);
            }
            await store.updateTaskLog(jobKey, {
                status,
                progress,
                message,
                ...taskExtra,
                ...(hasCaptcha ? {
                    gptApiCaptcha: JSON.stringify(captcha ? { ...captcha, url: null } : null)
                } : {})
            });
            const update = {
                type: status === 'running' ? 'progress' : 'status',
                jobKey,
                status,
                progress,
                message,
                cdkCode: cdk
            };
            if (hasCaptcha) update.captcha = captcha ?? null;
            broadcastToTask(jobKey, update);
        };

        try {
            const cfg = await store.getGptApiConfig();
            if (!cfg.enabled) {
                const err = new Error('第三方代充 API 未启用，请在后台「系统配置」中开启并填写 API 地址与 Key');
                err.failureStage = 'pre_submit';
                throw err;
            }
            if (!cfg.api_key) {
                const err = new Error('第三方代充 API Key 未配置');
                err.failureStage = 'pre_submit';
                throw err;
            }

            const openProtocol = gptApi.isDesolateOpenProtocol(cfg);
            activeOpenProtocol = openProtocol;
            const apiPlanKey = mapGptApiPlanKey(planType, cfg, gptApi);
            await setProgress('running', 10, '正在检查 Session 格式...');
            const inspect = await gptApi.inspectPay(cfg, {
                planKey: apiPlanKey,
                session: sessionPayload
            });
            if (!inspect.success) {
                const statusText = inspect.status ? ` (HTTP ${inspect.status})` : '';
                const detail = [
                    inspect.error,
                    inspect.reason,
                    inspect.upstreamStatus ? `upstream ${inspect.upstreamStatus}` : ''
                ].filter(Boolean).join(' / ');
                const inspectError = new Error(`Session 格式或有效期检查失败${statusText}: ${detail || 'session_invalid'}`);
                inspectError.code = 'inspect_failed';
                inspectError.failureStage = 'pre_submit';
                throw inspectError;
            }
            logTask(jobKey, openProtocol
                ? `Desolate Open Session 格式检查通过，套餐代码 ${apiPlanKey}`
                : 'Session 本地格式／有效期检查通过；上游将于代充任务中验证登录状态');

            const cardSource = String(cfg.card_source || 'local').trim().toLowerCase();

            for (let attempt = 0; attempt <= MAX_CARD_SWAP_RETRIES; attempt += 1) {
                reservedCard = null;
                reservedOrbitcard = null;
                orbitcardRechargeRecorded = false;
                submittedToProvider = false;
                activeRechargeJobKey = attempt === 0 ? jobKey : `${jobKey}-r${attempt}`;
                activeOrderId = '';
                activeOrderStatus = '';
                activeRaw = null;
                activeResponseMeta = null;
                activePollCount = 0;
                failureDiagnostic = null;

                // Session 检查通过后才创建／锁定卡源资产，避免无效 Session 占用卡片。
                let newCard = null;
                let activeCardId = null;
                let activeCardLast4 = '';

                if (cardSource === 'orbitcard') {
                    const orbitCfg = {
                        base_url: cfg.orbitcard_base_url,
                        api_key: cfg.orbitcard_api_key,
                        api_secret: cfg.orbitcard_api_secret
                    };
                    const requestedProductCode = String(cfg.orbitcard_product_code || '').trim();
                    const reuseLimits = cfg.orbitcard_reuse_limits || null;
                    const safetyMargins = cfg.orbitcard_safety_margins || null;
                    const reuseLimit = orbitcard.getPlanReuseLimit(planType, reuseLimits);

                    await setProgress('running', attempt === 0 ? 12 : 16, attempt === 0 ? '正在准备支付方式...' : '正在切换备用支付方式...');
                    const cardList = await orbitcard.getCardList(orbitCfg);
                    if (!cardList.success) {
                        const err = new Error(`Orbitcard 卡列表查询失败: ${cardList.error}`);
                        err.failureStage = 'pre_submit';
                        throw err;
                    }
                    const reusableCards = cardList.data.filter((card) => (
                        !orbitcard.isBlockedCardProduct(card)
                        && !failedOrbitcardIds.has(Number(card.cardId ?? card.card_id ?? card.id))
                    ));
                    reservedOrbitcard = await store.reserveOrbitcardCard(reusableCards, `gptapi_${activeRechargeJobKey}`, {
                        planType,
                        maxUsageCount: reuseLimit
                    });

                    await setProgress('running', attempt === 0 ? 14 : 18, '正在准备支付信息...');
                    let selection = null;
                    let createdOrbitcard = false;
                    if (!reservedOrbitcard) {
                        const autoCreateCard = Boolean(cfg.orbitcard_auto_create_card);
                        if (!autoCreateCard) {
                            logTask(jobKey, '本地暂无已绑定可用卡，自动开卡已关闭，正在同步卡台新卡并按余额推算...');
                            try {
                                const syncRes = await syncAndAutoAssignOrbitcardCards({
                                    store,
                                    orbitcard,
                                    cfg,
                                    providerCards: reusableCards,
                                    fetchDetails: false,
                                    markMissing: false
                                });
                                if (syncRes?.success && syncRes.autoAssigned > 0) {
                                    logTask(jobKey, `自动同步卡台完成：新绑定 ${syncRes.autoAssigned} 张 Plus 卡`);
                                }
                            } catch (syncError) {
                                logTask(jobKey, `自动同步卡台新卡失败: ${syncError.message}`, 'warn');
                            }
                            reservedOrbitcard = await store.reserveOrbitcardCard(reusableCards, `gptapi_${activeRechargeJobKey}`, {
                                planType,
                                maxUsageCount: reuseLimit
                            });
                            if (!reservedOrbitcard) {
                                const exhaustedError = new Error(
                                    attempt > 0
                                        ? `前一张 Orbitcard 卡被拒已退役，且同步卡台后已无其他可用 ${getPlanTypeLabel(planType)} 备用卡，请前往第三方卡台手动开卡`
                                        : `Orbitcard 自动开卡已关闭，同步卡台后仍无可用 ${getPlanTypeLabel(planType)} 卡片，请前往第三方卡台手动开卡`
                                );
                                exhaustedError.code = 'card_pool_exhausted';
                                exhaustedError.skipManualHold = true;
                                exhaustedError.failureStage = 'pre_submit';
                                exhaustedError.customerMessage = attempt > 0
                                    ? '当前支付通道卡片异常且暂无备用卡，原卡密已自动退回，请稍后重试或联系客服'
                                    : '当前暂无可用卡片，请稍后再试或联系客服';
                                throw exhaustedError;
                            }
                        } else {
                            const productResult = await orbitcard.getProductCode(orbitCfg);
                            if (!productResult.success) {
                                const err = new Error(`Orbitcard 产品目录查询失败: ${productResult.error}`);
                                err.failureStage = 'pre_submit';
                                throw err;
                            }
                            if (requestedProductCode) {
                                const requestedSelection = orbitcard.getProductSelectionsForPlan(productResult.data, planType, {
                                    preferredProductCode: requestedProductCode,
                                    reuseLimits,
                                    safetyMargins
                                });
                                if (!requestedSelection.length) {
                                    const err = new Error(`指定的 Orbitcard 产品 ${requestedProductCode} 当前不可用或缺少 ${getPlanTypeLabel(planType)} 套餐价格，请重新选择`);
                                    err.failureStage = 'pre_submit';
                                    throw err;
                                }
                            }
                            const selections = orbitcard.getProductSelectionsForPlan(
                                productResult.data,
                                planType,
                                requestedProductCode
                                    ? { preferredProductCode: requestedProductCode, reuseLimits, safetyMargins }
                                    : { reuseLimits, safetyMargins }
                            );
                            if (!selections.length) {
                                const err = new Error('Orbitcard 当前没有可开卡产品库存');
                                err.failureStage = 'pre_submit';
                                throw err;
                            }

                            let createdCardId = null;
                            let lastCreateError = '';
                            let unresolvedCreateOrder = '';
                            let unresolvedCreateResponse = false;
                            for (let candidateIndex = 0; candidateIndex < selections.length; candidateIndex += 1) {
                                const candidate = selections[candidateIndex];
                                selection = candidate;
                                const channelLabel = candidate.channel
                                    ? `渠道 ${candidate.channel} ${candidate.network || '卡'} BIN ${candidate.product.bin || candidate.product.productCode}`
                                    : candidate.product.productCode;
                                logTask(jobKey, `为 ${getPlanTypeLabel(planType)} 创建卡（${channelLabel}，首充 ${candidate.amount} USD，最多使用 ${candidate.maxUsageCount} 次）...`);
                                const createResult = await orbitcard.createCardUntilReady(orbitCfg, {
                                    productCode: candidate.product.productCode,
                                    amount: candidate.amount,
                                    quantity: 1,
                                    idempotencyKey: `orbitcard-${activeRechargeJobKey}-${candidateIndex + 1}`
                                }, {
                                    maxAttempts: 25,
                                    pollIntervalMs: 5000,
                                    onPending: async ({ attempt: pollAttempt, maxAttempts, orderNo, status }) => {
                                        if (pollAttempt === 1 || pollAttempt % 3 === 0) {
                                            logTask(jobKey, `Orbitcard 开卡订单等待确认 order=${orderNo || '-'} status=${status || '-'} poll=${pollAttempt}/${maxAttempts}`);
                                            await setProgress('running', 14, '正在等待支付方式准备完成...');
                                        }
                                    }
                                });
                                if (createResult.success) {
                                    createdCardId = createResult.cardId || orbitcard.extractCreatedCardId(createResult.data);
                                    break;
                                }
                                lastCreateError = createResult.error || '未知错误';
                                if (createResult.pending || createResult.ambiguous) {
                                    unresolvedCreateResponse = true;
                                    unresolvedCreateOrder = createResult.orderNo || '';
                                    logTask(jobKey, `Orbitcard 开卡订单尚未确认 order=${unresolvedCreateOrder || '-'} status=${createResult.createStatus || '-'}，停止切换产品`, 'warn');
                                    break;
                                }
                                if (!createResult.status) break;
                                if (candidateIndex < selections.length - 1) {
                                    const next = selections[candidateIndex + 1];
                                    logTask(jobKey, `Orbitcard ${channelLabel} 开卡失败，切换备用产品 ${next.product.productCode}: ${lastCreateError}`, 'warn');
                                }
                            }
                            if (!createdCardId) {
                                if (unresolvedCreateResponse) {
                                    const orderLabel = unresolvedCreateOrder ? `（订单 ${unresolvedCreateOrder}）` : '';
                                    const err = new Error(`Orbitcard 开卡结果仍待确认${orderLabel}，请勿解除审核或重新提交，待上游确认后再处理`);
                                    err.failureStage = 'runtime_error';
                                    throw err;
                                }
                                const err = new Error(`Orbitcard 开卡失败: ${lastCreateError || '当前渠道产品均不可用'}`);
                                err.failureStage = 'pre_submit';
                                throw err;
                            }

                            reservedOrbitcard = await store.reserveOrbitcardCard(
                                [{ card_id: createdCardId, status: 'ACTIVE' }],
                                `gptapi_${activeRechargeJobKey}`,
                                {
                                    planType,
                                    maxUsageCount: selection.maxUsageCount,
                                    initialAmount: selection.amount,
                                    persistMetadata: true
                                }
                            );
                            if (!reservedOrbitcard) {
                                const err = new Error('Orbitcard 新卡已创建，但本地锁定失败，请联系管理员核对卡片状态');
                                err.failureStage = 'runtime_error';
                                throw err;
                            }
                            createdOrbitcard = true;
                        }
                    }

                    const detail = await orbitcard.getCardDetail(orbitCfg, reservedOrbitcard.orbitcard_id);
                    if (!detail.success) {
                        await releaseOrRetireCurrentCard({ retire: createdOrbitcard });
                        const err = new Error(detail.error || 'Orbitcard 卡详情查询失败');
                        err.failureStage = 'pre_submit';
                        throw err;
                    }
                    const expiry = parseCardExpiry(detail.data.expiry);
                    newCard = {
                        number: detail.data.cardNumber,
                        exp_month: expiry.month,
                        exp_year: expiry.year,
                        cvc: detail.data.cvc,
                        name: detail.data.holder || 'API User',
                        country: cfg.country || 'PH'
                    };
                    activeCardId = Number(reservedOrbitcard.orbitcard_id);
                    activeCardLast4 = reservedOrbitcard.last4 || detail.data.cardNumber.slice(-4);
                    await store.updateTaskLog(jobKey, { cardLast4: activeCardLast4 });
                    const maxUsageCount = Number(reservedOrbitcard.max_usage_count || selection?.maxUsageCount || reuseLimit || 1);
                    const recorded = await store.createOrbitcardRecharge({
                        cardId: reservedOrbitcard.orbitcard_id,
                        jobKey: activeRechargeJobKey,
                        planType,
                        cardLast4: activeCardLast4,
                        accountEmail,
                        useNumber: Number(reservedOrbitcard.usage_count || 0) + 1,
                        maxUsageCount,
                        initialAmount: reservedOrbitcard.initial_amount || selection?.amount || null
                    });
                    if (!recorded) {
                        await releaseOrRetireCurrentCard({ retire: false });
                        const err = new Error('Orbitcard 用卡记录写入失败，任务未提交');
                        err.failureStage = 'pre_submit';
                        throw err;
                    }
                    orbitcardRechargeRecorded = true;
                    logTask(jobKey, `第三方 API ${createdOrbitcard ? '新建' : '复用'} Orbitcard 卡 product=${selection?.product?.productCode || reservedOrbitcard.plan_type || planType} ...${activeCardLast4}（第 ${Number(reservedOrbitcard.usage_count || 0) + 1}/${maxUsageCount} 次${attempt > 0 ? '，自动换卡重试' : ''}）`);
                } else {
                    reservedCard = await store.reserveCard(`gptapi_${activeRechargeJobKey}`);
                    if (reservedCard && failedLocalCardIds.has(Number(reservedCard.id))) {
                        await releaseOrRetireCurrentCard({ retire: false });
                    }
                    if (!reservedCard) {
                        const exhaustedError = new Error(
                            attempt > 0
                                ? '前一张银行卡支付被拒，本地卡池已无其他可用备用卡'
                                : '银行卡池暂无可用卡片，请在后台「银行卡池」导入银行卡后再试'
                        );
                        exhaustedError.code = 'card_pool_exhausted';
                        exhaustedError.skipManualHold = true;
                        exhaustedError.failureStage = 'pre_submit';
                        exhaustedError.customerMessage = attempt > 0
                            ? '当前支付通道卡片异常且暂无备用卡，原卡密已自动退回，请稍后重试或联系客服'
                            : '当前暂无可用卡片，请稍后再试或联系客服';
                        throw exhaustedError;
                    }
                    const expiry = parseCardExpiry(reservedCard.card_expiry);
                    newCard = {
                        number: reservedCard.card_number,
                        exp_month: expiry.month,
                        exp_year: expiry.year,
                        cvc: reservedCard.card_cvc,
                        name: reservedCard.card_holder || 'API User',
                        country: cfg.country || 'PH'
                    };
                    activeCardId = Number(reservedCard.id);
                    activeCardLast4 = String(reservedCard.card_number || '').slice(-4);
                    logTask(jobKey, `第三方 API 使用本地卡池卡 ...${activeCardLast4}${attempt > 0 ? '（自动换卡重试）' : ''}`);
                }

                await setProgress('running', 20, attempt === 0 ? '正在提交开通订单...' : '已切换备用支付方式，正在重新提交订单...');
                const idempotencyKey = attempt === 0 ? `gpt-api-${jobKey}` : `gpt-api-${jobKey}-r${attempt}`;
                const clientRef = attempt === 0 ? `kc-cdk-${cdk}-${jobKey}` : `kc-cdk-${cdk}-${jobKey}-r${attempt}`;
                submittedToProvider = true;
                const submit = await gptApi.submitPay(cfg, {
                    planKey: apiPlanKey,
                    session: sessionPayload,
                    country: cfg.country,
                    currency: cfg.currency,
                    paymentRegion: cfg.payment_region,
                    newCard,
                    clientRef,
                    idempotencyKey
                });

                if (!submit.success) {
                    const statusText = submit.status ? ` (HTTP ${submit.status})` : '';
                    const businessCodeText = submit.businessCode != null ? ` (businessCode ${submit.businessCode})` : '';
                    const detail = submit.error || gptApi.extractProviderMessage(submit.data);
                    const submitError = new Error(`代充提交失败${statusText}${businessCodeText}: ${detail || '未知错误'}`);
                    submitError.failureStage = 'submit_rejected';
                    submitError.status = submit.status;
                    submitError.businessCode = submit.businessCode;
                    submitError.providerMessage = detail;
                    submitError.gptApiRequestId = submit.requestId;
                    submitError.gptApiResponseMeta = submit.responseMeta;
                    if (openProtocol) {
                        submitError.gptApiRaw = JSON.stringify(sanitizeGptApiRaw({
                            ...(submit.data && typeof submit.data === 'object' ? submit.data : {}),
                            ...(submit.businessCode != null ? { code: submit.businessCode } : {})
                        }, true, {
                            ...(submit.responseMeta || {}),
                            status: submit.status ?? submit.responseMeta?.status ?? null
                        }, gptApi));
                    }
                    throw submitError;
                }

                const orderId = submit.orderId || submit.taskId || submit.id;
                activeOrderId = String(orderId || '');
                activeResponseMeta = submit.responseMeta || null;
                const taskId = submit.taskId || null;
                if (!orderId) {
                    const providerMessage = submit.message || gptApi.extractProviderMessage(submit.data);
                    const noOrderErr = new Error(`代充提交成功但未返回订单号${providerMessage ? `: ${providerMessage}` : ''}`);
                    noOrderErr.failureStage = 'runtime_error';
                    throw noOrderErr;
                }

                const submittedPayload = submit.data && typeof submit.data === 'object'
                    ? { ...submit.data, ...(submit.message ? { _providerMessage: submit.message } : {}) }
                    : submit.data;
                await setProgress('running', 35, submit.message || '订单已创建，正在等待处理...', {
                    gptApiOrderId: orderId,
                    gptApiTaskId: taskId,
                    gptApiRaw: JSON.stringify(sanitizeGptApiRaw(submittedPayload, openProtocol, submit.responseMeta, gptApi)),
                    gptApiTopupCode: submit.topupCode
                });
                if (orbitcardRechargeRecorded) {
                    await store.updateOrbitcardRecharge(activeRechargeJobKey, { status: 'processing', orderId });
                }

                let finalStatus = 'running';
                let finalMessage = '订单正在处理中';
                let terminalSessionUpdate = null;
                let lastRaw = submit.data;
                let lastResponseMeta = submit.responseMeta || null;
                const configuredMaxPolls = env.GPT_API_MAX_POLLS;
                const openPollSafetyCap = Number(configuredMaxPolls);
                const maxPolls = openProtocol
                    ? (String(configuredMaxPolls ?? '').trim() !== '' && Number.isFinite(openPollSafetyCap) && openPollSafetyCap >= 0
                        ? Math.floor(openPollSafetyCap)
                        : null)
                    : Number(configuredMaxPolls || 120);
                const configuredPollIntervalMs = Number(env.GPT_API_POLL_INTERVAL_MS || 5000);
                const pollIntervalMs = Number.isFinite(configuredPollIntervalMs) ? Math.max(0, configuredPollIntervalMs) : 5000;
                let nextPollDelayMs = pollIntervalMs;
                let pollCount = 0;
                let captchaRequired = false;
                let captchaId = '';
                let timedOut = false;
                let internalFailureMessage = '';

                while (maxPolls == null || pollCount < maxPolls) {
                    pollCount += 1;
                    await sleep(nextPollDelayMs);

                    let queryRes = null;
                    if (taskId) {
                        queryRes = await gptApi.queryTask(cfg, taskId);
                    }
                    if (!queryRes || !queryRes.success || !queryRes.rawStatus) {
                        queryRes = await gptApi.queryOrder(cfg, orderId);
                    }

                    activePollCount = pollCount;
                    if (!queryRes || !queryRes.success) {
                        activeResponseMeta = queryRes?.responseMeta || activeResponseMeta;
                        activeOrderStatus = String(queryRes?.rawStatus || activeOrderStatus || '');
                        logTask(jobKey, `状态轮询第 ${pollCount} 次失败: ${queryRes?.error || '未知错误'}`, 'warn');
                        if (openProtocol) {
                            nextPollDelayMs = gptApi.getGptOrderPollDelayMs({
                                pollCount,
                                baseDelayMs: pollIntervalMs,
                                maxDelayMs: 60000,
                                status: queryRes?.status,
                                retryAfterMs: Number(queryRes?.status) === 429 ? queryRes?.retryAfterMs : null,
                                captchaPending: captchaRequired
                            });
                        } else {
                            nextPollDelayMs = Math.min(60000, Math.max(pollIntervalMs, Number(queryRes?.retryAfterMs || 0)));
                        }
                        continue;
                    }

                    lastRaw = queryRes.data;
                    activeRaw = lastRaw;
                    lastResponseMeta = queryRes.responseMeta || null;
                    activeResponseMeta = lastResponseMeta || activeResponseMeta;
                    activeOrderStatus = String(queryRes.rawStatus || activeOrderStatus || '');
                    const providerMessage = queryRes.message || gptApi.extractProviderMessage(lastRaw);
                    let sessionUpdate = null;
                    if (openProtocol && lastRaw?.session && typeof lastRaw.session === 'object') {
                        sessionPayload = {
                            ...sessionPayload,
                            ...lastRaw.session,
                            user: { ...(sessionPayload.user || {}), ...(lastRaw.session.user || {}) },
                            account: { ...(sessionPayload.account || {}), ...(lastRaw.session.account || {}) }
                        };
                        sessionUpdate = JSON.stringify(sessionPayload);
                    }
                    const rawStatus = String(queryRes.rawStatus || '').toLowerCase();
                    if (providerMessage && lastRaw && typeof lastRaw === 'object') {
                        lastRaw = { ...lastRaw, _providerMessage: providerMessage };
                    }
                    logTask(jobKey, `订单查询第 ${pollCount} 次：status=${rawStatus || '-'}${providerMessage ? `，message=${providerMessage}` : ''}`);
                    const stage = String(queryRes.stage || lastRaw?.stage || '').trim().toLowerCase();
                    const captcha = queryRes.captcha || gptApi.extractCaptcha(lastRaw);
                    const captchaStatus = String(captcha?.status || '').trim().toLowerCase();
                    const isCaptchaPending = stage === 'awaiting_captcha' || captchaStatus === 'pending';
                    if (isCaptchaPending) {
                        captchaRequired = true;
                        const nextCaptchaId = String(captcha?.id || '').trim();
                        if (nextCaptchaId && nextCaptchaId !== captchaId) {
                            captchaId = nextCaptchaId;
                            logTask(jobKey, `订单需要人机验证 captcha=${captchaId} url=${captcha?.url ? 'ready' : 'pending'}`);
                        }
                    } else if (stage === 'captcha_submitted' || captchaStatus === 'submitted') {
                        captchaRequired = false;
                    } else if (!captcha) {
                        captchaRequired = false;
                    }
                    const taskCaptcha = captcha
                        ? { ...captcha, stage: stage || null }
                        : (stage === 'awaiting_captcha'
                            ? { id: captchaId || null, status: 'pending', url: null, expiresAt: null, stage }
                            : (stage === 'captcha_submitted' && captchaId
                                ? { id: captchaId, status: 'submitted', url: null, expiresAt: null, stage }
                                : null));

                    if (openProtocol) {
                        nextPollDelayMs = gptApi.getGptOrderPollDelayMs({
                            pollCount,
                            baseDelayMs: pollIntervalMs,
                            maxDelayMs: 60000,
                            status: rawStatus,
                            captchaPending: isCaptchaPending
                        });
                    } else {
                        nextPollDelayMs = pollIntervalMs;
                    }
                    const progress = Math.min(95, 40 + pollCount);

                    const isTerminal = openProtocol
                        ? rawStatus === 'succeeded' || rawStatus === 'failed'
                        : isTerminalGptApiStatus(rawStatus);
                    if (isTerminal) {
                        const businessResult = lastRaw && typeof lastRaw.result === 'object' ? lastRaw.result : {};
                        const succeeded = openProtocol
                            ? rawStatus === 'succeeded'
                            : (businessResult.ok === false ? false : isSuccessGptApiStatus(rawStatus));
                        const failureDetail = openProtocol
                            ? (lastRaw?.failureMessage || lastRaw?.failureCode || rawStatus || 'unknown')
                            : (businessResult.error || lastRaw?.error || businessResult.status || rawStatus || 'unknown');
                        internalFailureMessage = `第三方代充失败: ${failureDetail}`;
                        terminalSessionUpdate = sessionUpdate;
                        if (!succeeded) {
                            logTask(jobKey, `订单终态失败 status=${rawStatus} detail=${failureDetail}`, 'warn');
                        }
                        failureDiagnostic = succeeded
                            ? null
                            : buildGptApiFailureDiagnostic({
                                openProtocol,
                                raw: lastRaw,
                                businessResult,
                                rawStatus,
                                providerReason: openProtocol
                                    ? (lastRaw?.failureMessage || lastRaw?.message)
                                    : (businessResult?.error || lastRaw?.error || businessResult?.errorMessage || lastRaw?.message),
                                providerCode: openProtocol
                                    ? lastRaw?.failureCode
                                    : (businessResult?.errorCode || businessResult?.error_code || lastRaw?.errorCode),
                                orderId,
                                status: rawStatus,
                                requestId: queryRes.requestId,
                                responseMeta: lastResponseMeta,
                                pollCount
                            });
                        finalStatus = succeeded ? 'success' : 'failed';
                        finalMessage = succeeded
                            ? (openProtocol && lastRaw?.subscriptionCancelled === false
                                ? '开通成功，但自动续订取消状态未确认，请到目标账户账单页核对'
                                : '开通成功')
                            : GPT_API_CUSTOMER_FAILURE_MESSAGE;
                        break;
                    }

                    await setProgress('running', progress, gptApi.formatProgressMessage(lastRaw, pollCount), {
                        captcha: taskCaptcha,
                        ...(sessionUpdate ? { sessionPayload: sessionUpdate } : {})
                    });
                }

                if (finalStatus === 'running') {
                    timedOut = true;
                    finalStatus = 'failed';
                    finalMessage = GPT_API_CUSTOMER_TIMEOUT_MESSAGE;
                    failureDiagnostic = buildGptApiFailureDiagnostic({
                        openProtocol,
                        raw: lastRaw || activeRaw,
                        rawStatus: activeOrderStatus,
                        orderId: activeOrderId,
                        status: activeOrderStatus,
                        responseMeta: lastResponseMeta || activeResponseMeta,
                        pollCount,
                        timeout: true
                    });
                }

                const terminalRawExtra = {
                    gptApiRaw: JSON.stringify(sanitizeGptApiRaw(lastRaw, openProtocol, lastResponseMeta, gptApi)),
                    gptApiTopupCode: gptApi.extractTopupCode(lastRaw),
                    captcha: null,
                    ...(terminalSessionUpdate ? { sessionPayload: terminalSessionUpdate } : {})
                };

                if (finalStatus === 'success') {
                    shouldRollbackCdk = false;
                    await store.resetCdkFailure(cdk);
                    if (reservedOrbitcard) {
                        const orbitcardId = reservedOrbitcard.orbitcard_id;
                        const usage = await store.recordOrbitcardCardUsage(orbitcardId);
                        const maxUsageCount = Number(
                            reservedOrbitcard.max_usage_count || orbitcard.getPlanReuseLimit(planType, cfg.orbitcard_reuse_limits) || 1
                        );
                        await releaseOrRetireCurrentCard({ retire: usage.usageCount >= maxUsageCount });
                    } else if (reservedCard) {
                        await store.recordCardUsage(reservedCard.id);
                        await releaseOrRetireCurrentCard({ retire: false });
                    }
                    await setProgress('success', 100, finalMessage, terminalRawExtra);
                    if (orbitcardRechargeRecorded) {
                        await store.updateOrbitcardRecharge(activeRechargeJobKey, { status: 'success', orderId, message: finalMessage });
                    }
                    notifyTaskOutcome({ event: 'success', email: accountEmail, planType, cdk, jobKey, message: finalMessage });
                    break;
                }

                // 4 级失败分流：customer_definite / card_declined / ambiguous
                const classification = classifyGptApiFailure({
                    stage: timedOut ? 'timeout' : 'terminal',
                    diagnostic: failureDiagnostic,
                    timeout: timedOut
                });

                if (classification.category === 'card_declined') {
                    if (cardSource === 'orbitcard' && Number.isInteger(activeCardId) && activeCardId > 0) {
                        failedOrbitcardIds.add(activeCardId);
                    } else if (cardSource !== 'orbitcard' && Number.isInteger(activeCardId) && activeCardId > 0) {
                        failedLocalCardIds.add(activeCardId);
                    }
                    await releaseOrRetireCurrentCard({ retire: true });
                    if (orbitcardRechargeRecorded) {
                        await store.updateOrbitcardRecharge(activeRechargeJobKey, {
                            status: 'failed',
                            orderId,
                            message: failureDiagnostic?.reason || classification.customerMessage
                        });
                    }
                    const canSwapRetry = classification.allowCardSwap && attempt < MAX_CARD_SWAP_RETRIES;
                    notifyTaskOutcome({
                        event: 'failure',
                        email: accountEmail,
                        planType,
                        cdk,
                        jobKey,
                        message: canSwapRetry
                            ? `卡片 ...${activeCardLast4 || '****'} 支付被拒已退役，正在自动切换备用卡重试`
                            : classification.customerMessage,
                        diagnostic: failureDiagnostic
                    });
                    if (canSwapRetry) {
                        logTask(
                            jobKey,
                            `卡片 ...${activeCardLast4 || '****'} 支付被拒（${failureDiagnostic?.reason || 'card_declined'}），已退役该卡并自动切换备用卡重试（第 ${attempt + 1}/${MAX_CARD_SWAP_RETRIES} 次）`,
                            'warn'
                        );
                        await setProgress('running', 16, '支付通道切换中，正在自动重试...', { captcha: null });
                        continue;
                    }
                    finalMessage = classification.customerMessage;
                    await setProgress('failed', 99, finalMessage, terminalRawExtra);
                    break;
                }

                if (classification.category === 'customer_definite') {
                    await releaseOrRetireCurrentCard({ retire: false });
                    finalMessage = classification.customerMessage;
                    logTask(jobKey, `明确为账号/验证类失败（${classification.summaryTag}），已释放卡片回池并退回 CDK，无需转人工`, 'warn');
                    await setProgress('failed', 99, finalMessage, terminalRawExtra);
                    if (orbitcardRechargeRecorded) {
                        await store.updateOrbitcardRecharge(activeRechargeJobKey, { status: 'failed', orderId, message: finalMessage });
                    }
                    notifyTaskOutcome({
                        event: 'failure',
                        email: accountEmail,
                        planType,
                        cdk,
                        jobKey,
                        message: finalMessage,
                        diagnostic: failureDiagnostic
                    });
                    break;
                }

                // ambiguous（轮询超时 / 未识别原因的终态失败）：保留人工确认防双花 + 暂停/退役该卡待核对
                finalMessage = timedOut
                    ? GPT_API_CUSTOMER_TIMEOUT_MESSAGE
                    : getManualReviewMessage(classification.customerMessage || finalMessage);
                const holdReason = timedOut
                    ? (failureDiagnostic?.reason || finalMessage)
                    : (internalFailureMessage || failureDiagnostic?.reason || finalMessage);
                await store.createActivationManualHold({
                    accountKey,
                    accountEmail,
                    planType,
                    failedJobKey: jobKey,
                    cdkCode: cdk,
                    reason: holdReason
                });
                await releaseOrRetireCurrentCard({ retire: true });
                await setProgress('failed', 99, finalMessage, terminalRawExtra);
                if (orbitcardRechargeRecorded) {
                    await store.updateOrbitcardRecharge(activeRechargeJobKey, { status: 'failed', orderId, message: finalMessage });
                }
                notifyTaskOutcome({
                    event: 'failure',
                    email: accountEmail,
                    planType,
                    cdk,
                    jobKey,
                    message: finalMessage,
                    diagnostic: failureDiagnostic
                });
                break;
            }
        } catch (error) {
            logger.error(`[GPT API Task Error] ${jobKey}:`, error);
            if (error?.code === 'card_pool_exhausted' && error?.skipManualHold) {
                await releaseOrRetireCurrentCard({ retire: false });
                const customerFailureMessage = error.customerMessage || '当前暂无可用卡片，请稍后再试或联系客服';
                logTask(jobKey, `卡池无可用卡片: ${error.message}`, 'warn');
                await store.updateTaskLog(jobKey, {
                    status: 'failed',
                    message: customerFailureMessage,
                    progress: 0,
                    cdkCode: cdk,
                    gptApiCaptcha: 'null'
                });
                broadcastToTask(jobKey, {
                    type: 'status',
                    jobKey,
                    status: 'failed',
                    message: customerFailureMessage,
                    cdkCode: cdk,
                    progress: 0,
                    captcha: null
                });
                notifyTaskOutcome({
                    event: 'card_pool_empty',
                    email: accountEmail,
                    planType,
                    cdk,
                    jobKey,
                    message: error.message
                });
                return;
            }
            const catchStage = error?.failureStage || (!submittedToProvider ? 'pre_submit' : 'runtime_error');
            const catchFailureDiagnostic = buildGptApiFailureDiagnostic({
                openProtocol: activeOpenProtocol,
                raw: (() => {
                    try { return error?.gptApiRaw ? JSON.parse(error.gptApiRaw) : activeRaw; } catch (_) { return activeRaw; }
                })(),
                rawStatus: activeOrderStatus,
                orderId: activeOrderId,
                status: activeOrderStatus,
                requestId: error?.gptApiRequestId,
                responseMeta: error?.gptApiResponseMeta || activeResponseMeta,
                pollCount: activePollCount,
                providerCode: error?.businessCode,
                error
            });
            const catchClassification = classifyGptApiFailure({
                stage: catchStage,
                diagnostic: catchFailureDiagnostic,
                error,
                status: error?.status,
                businessCode: error?.businessCode
            });
            const customerFailureMessage = catchClassification.customerMessage;

            if (catchClassification.requiresManualHold) {
                const manualReviewMessage = getManualReviewMessage(error.message);
                await store.createActivationManualHold({
                    accountKey,
                    accountEmail,
                    planType,
                    failedJobKey: jobKey,
                    cdkCode: cdk,
                    reason: manualReviewMessage
                }).catch((holdError) => {
                    logger.warn(`[GPT API Task] 人工审核记录写入失败: ${holdError.message}`);
                });
            }
            logTask(
                jobKey,
                `第三方代充任务异常 [${catchClassification.category}${catchClassification.requiresManualHold ? '/转人工' : '/自动退回'}]: ${error.message}`,
                'error'
            );
            await releaseOrRetireCurrentCard({ retire: catchClassification.retireCard });
            if (orbitcardRechargeRecorded) {
                await store.updateOrbitcardRecharge(activeRechargeJobKey, { status: 'failed', message: error.message });
            }
            await store.updateTaskLog(jobKey, {
                status: 'failed',
                message: customerFailureMessage,
                progress: 0,
                cdkCode: cdk,
                gptApiRaw: error.gptApiRaw || null,
                gptApiCaptcha: 'null'
            });
            broadcastToTask(jobKey, {
                type: 'status',
                jobKey,
                status: 'failed',
                message: customerFailureMessage,
                cdkCode: cdk,
                progress: 0,
                captcha: null
            });
            notifyTaskOutcome({
                event: 'failure',
                email: accountEmail,
                planType,
                cdk,
                jobKey,
                message: customerFailureMessage,
                diagnostic: catchFailureDiagnostic
            });
        } finally {
            activeTaskCaptchas.delete(jobKey);
            releaseForegroundSlot(jobKey);
            if (shouldRollbackCdk) {
                await store.markCdkUnused(cdk).catch(() => { });
                logTask(jobKey, `CDK ${cdk} 已回滚为未使用`);
            }
            if (getTotalActiveJobs() === 0) {
                const maintenanceModeState = await store.getMaintenanceModeState();
                if (maintenanceModeState.enabled && maintenanceModeState.drain) {
                    await store.setMaintenanceModeState(true, false);
                }
            }
        }
    };
}

module.exports = {
    createGptApiWorker,
    mapGptApiPlanKey,
    sanitizeGptApiRaw,
    parseCardExpiry,
    isSuccessGptApiStatus,
    isTerminalGptApiStatus
};
