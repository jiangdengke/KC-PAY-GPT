'use strict';

const express = require('express');
const { normalizeSessionToken, extractEmailFromSession } = require('../utils/session-parser');
const {
    validateSessionTokenForQuery,
    querySubscriptionBySession,
    cancelAutoRenew,
    resumeAutoRenew
} = require('../services/subscription-check');
const { forwardAsyncErrors } = require('../middleware/async-handler');

function createAdminSubscriptionRouter({ store, ensureStoreReady }) {
    const router = forwardAsyncErrors(express.Router());

    async function getOptionalProxy() {
        try {
            await ensureStoreReady();
            return await store.getActiveProxy();
        } catch (_) {
            return '';
        }
    }

    router.post('/subscription/cancel-auto-renew', async (req, res) => {
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
            const result = await cancelAutoRenew(token, {
                timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                    ? timezoneOffsetMin
                    : -new Date().getTimezoneOffset(),
                email: extractEmailFromSession(rawSession) || tokenCheck.email || '',
                proxy: await getOptionalProxy()
            });

            if (!result.ok) {
                return res.status(result.statusCode || 502).json({
                    success: false,
                    message: result.error || '取消自动续费失败'
                });
            }

            return res.json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/subscription/enable-auto-renew', async (req, res) => {
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
            const result = await resumeAutoRenew(token, {
                timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                    ? timezoneOffsetMin
                    : -new Date().getTimezoneOffset(),
                email: extractEmailFromSession(rawSession) || tokenCheck.email || '',
                proxy: await getOptionalProxy()
            });

            if (!result.ok) {
                return res.status(result.statusCode || 502).json({
                    success: false,
                    message: result.error || '开启自动续费失败'
                });
            }

            return res.json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/subscription/batch-renewal-status', async (req, res) => {
        try {
            await ensureStoreReady();
            const jobKeys = Array.isArray(req.body?.job_keys)
                ? req.body.job_keys.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50)
                : [];
            if (!jobKeys.length) {
                return res.json({ success: true, data: {} });
            }

            const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
            const offset = Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset();
            const proxy = await getOptionalProxy();
            const concurrency = 3;
            const results = {};
            let cursor = 0;

            async function queryJobRenewalStatus(jobKey) {
                const session = await store.getSessionByJobKey(jobKey);
                if (!session?.session_payload) {
                    results[jobKey] = { ok: false, error: '无完整 Session' };
                    return;
                }

                const rawSession = String(session.session_payload || '').trim();
                const token = normalizeSessionToken(rawSession);
                const tokenCheck = validateSessionTokenForQuery(token);
                if (!tokenCheck.valid) {
                    results[jobKey] = { ok: false, error: tokenCheck.message };
                    return;
                }

                const queryResult = await querySubscriptionBySession(token, {
                    timezoneOffsetMin: offset,
                    email: extractEmailFromSession(rawSession) || tokenCheck.email || '',
                    proxy
                });
                if (!queryResult.ok) {
                    results[jobKey] = { ok: false, error: queryResult.error || '查询失败' };
                    return;
                }

                const data = queryResult.data || {};
                results[jobKey] = {
                    ok: true,
                    email: data.email || '',
                    autoRenew: data.autoRenew || '—',
                    autoRenewRaw: data.autoRenewRaw,
                    hasActiveSubscription: Boolean(data.hasActiveSubscription),
                    subscriptionChannel: data.subscriptionChannel || ''
                };
            }

            async function worker() {
                while (cursor < jobKeys.length) {
                    const index = cursor;
                    cursor += 1;
                    await queryJobRenewalStatus(jobKeys[index]);
                }
            }

            await Promise.all(Array.from({ length: Math.min(concurrency, jobKeys.length) }, () => worker()));
            return res.json({ success: true, data: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
}

module.exports = { createAdminSubscriptionRouter };
