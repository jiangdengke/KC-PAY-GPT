'use strict';

const express = require('express');
const runtimeLog = require('../utils/runtime-log');
const { getSystemMetrics } = require('../utils/system-metrics');
const { forwardAsyncErrors } = require('../middleware/async-handler');

function maskAdminDataSecrets(data) {
    const masked = { ...data };
    if (masked.config && Array.isArray(masked.config.card_pool)) {
        masked.config = {
            ...masked.config,
            card_pool: masked.config.card_pool.map((card) => ({
                ...card,
                number: card.number ? `****${String(card.number).slice(-4)}` : '',
                cvc: card.cvc ? '***' : ''
            }))
        };
    }
    if (masked.telegram && masked.telegram.bot_token) {
        masked.telegram = {
            ...masked.telegram,
            bot_token: `${String(masked.telegram.bot_token).slice(0, 10)}…`
        };
    }
    return masked;
}

function createAdminTasksRouter({
    store,
    ensureStoreReady,
    taskHub,
    requireSecondaryAuth,
    handleActivationRequest
}) {
    const router = forwardAsyncErrors(express.Router());

    router.get('/data', async (req, res) => {
        try {
            await ensureStoreReady();
            const data = maskAdminDataSecrets(await store.getAdminData());
            const system = await getSystemMetrics();
            data.runtime = {
                active_activation_jobs: taskHub.getTotalActiveJobs(),
                active_foreground_jobs: taskHub.getActiveForegroundJobsCount(),
                system
            };
            return res.json(data);
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/task-logs', async (req, res) => {
        try {
            await ensureStoreReady();
            const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
            const tasks = await store.listAdminTaskLogs(limit);
            return res.json({ success: true, tasks });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/task-logs/:jobKey', async (req, res) => {
        try {
            await ensureStoreReady();
            const jobKey = decodeURIComponent(String(req.params.jobKey || '').trim());
            if (!jobKey) {
                return res.status(400).json({ success: false, message: '缺少任务标识' });
            }
            const task = await store.getAdminTaskLogDetail(jobKey);
            if (!task) {
                return res.status(404).json({ success: false, message: '未找到该任务记录' });
            }
            const runtimeEntries = runtimeLog.tail(15000).filter((entry) => entry.jobKey === jobKey);
            return res.json({ success: true, task, runtimeEntries });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.delete('/task-logs/:jobKey', async (req, res) => {
        try {
            await ensureStoreReady();
            const jobKey = decodeURIComponent(String(req.params.jobKey || '').trim());
            if (!jobKey) {
                return res.status(400).json({ success: false, message: '缺少任务标识' });
            }
            const { deleted } = await store.deleteTaskLogByJobKey(jobKey);
            if (!deleted) {
                return res.status(404).json({ success: false, message: '未找到该任务记录' });
            }
            return res.json({ success: true, message: '任务记录已删除' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/activation-manual-holds', async (req, res) => {
        try {
            await ensureStoreReady();
            const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
            const holds = await store.listActivationManualHolds(limit);
            return res.json({
                success: true,
                holds: holds.map((hold) => ({
                    id: Number(hold.id),
                    accountEmail: hold.account_email || '',
                    planType: hold.plan_type || 'plus',
                    failedJobKey: hold.failed_job_key || '',
                    cdkCode: hold.cdk_code || '',
                    reason: hold.reason || '',
                    createdAt: hold.created_at,
                    updatedAt: hold.updated_at
                }))
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/activation-manual-holds/:id/resolve', async (req, res) => {
        try {
            await ensureStoreReady();
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ success: false, message: '人工审核记录编号无效' });
            }
            const resolved = await store.resolveActivationManualHold(id, req.admin?.email || 'admin');
            if (!resolved) {
                return res.status(404).json({ success: false, message: '记录不存在或已解除' });
            }
            return res.json({ success: true, message: '人工审核已解除，该卡密可重新提交' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/sessions', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 12));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const search = String(req.query.search || '').trim().slice(0, 120);
            return res.json(await store.listSessions({ limit, offset, search }));
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/sessions/:jobKey', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const session = await store.getSessionByJobKey(req.params.jobKey);
            if (!session) {
                return res.status(404).json({ success: false, message: 'Session 记录不存在' });
            }
            return res.json({ success: true, session });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/runtime-logs', (req, res) => {
        try {
            const wantTail = String(req.query.tail || '') === '1' || String(req.query.tail || '') === 'true';
            const after = Math.max(0, parseInt(String(req.query.after || '0'), 10) || 0);
            const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit || '500'), 10) || 500));
            const entries = wantTail ? runtimeLog.tail(limit) : runtimeLog.after(after, limit);
            const nextAfter = entries.length ? entries[entries.length - 1].id : after;
            return res.json({ success: true, entries, nextAfter });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/runtime-logs/clear', (req, res) => {
        try {
            runtimeLog.clear();
            runtimeLog.push({ jobKey: '', level: 'system', source: 'server', text: '🧹 运行日志已手动清空' });
            return res.json({ success: true, message: '运行日志已清空' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/trigger-activation', handleActivationRequest);

    return router;
}

module.exports = {
    maskAdminDataSecrets,
    createAdminTasksRouter
};
