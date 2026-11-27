'use strict';

const express = require('express');
const adminAuth = require('../security/admin-auth');
const { forwardAsyncErrors } = require('../middleware/async-handler');

function createExternalRouter({ store, ensureStoreReady }) {
    const router = forwardAsyncErrors(express.Router());

    router.post('/cards/push', async (req, res) => {
        try {
            await ensureStoreReady();
            const providedKey = String(req.headers['x-api-key'] || '').trim();
            if (!providedKey) {
                return res.status(401).json({ success: false, error: '缺少 X-API-Key 请求头' });
            }
            const storedKey = await store.getAppConfigValue('external_card_api_key', '');
            if (!storedKey || !adminAuth.safeEqualString(providedKey, storedKey)) {
                return res.status(401).json({ success: false, error: '无效的 API Key' });
            }

            const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
            if (cards.length === 0) {
                return res.status(400).json({ success: false, error: '缺少 cards 数组或为空' });
            }
            if (cards.length > 500) {
                return res.status(400).json({ success: false, error: '单次导入上限 500 条' });
            }

            const result = await store.importCards(cards);
            return res.json({ success: true, ...result });
        } catch (error) {
            if (error.message === '单次导入上限 500 条') {
                return res.status(400).json({ success: false, error: error.message });
            }
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
}

module.exports = { createExternalRouter };
