'use strict';

const crypto = require('crypto');
const express = require('express');
const { requireCanonicalPlanType } = require('../config/plan-registry');
const adminAuth = require('../security/admin-auth');
const { testProxyUrl, normalizeProxyLines } = require('../services/proxy-pool');
const { forwardAsyncErrors } = require('../middleware/async-handler');

const CDK_PREFIX = 'KC-';
const CDK_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CDK_RANDOM_LENGTH = 15;

function randomCdkSuffix() {
    let out = '';
    for (let i = 0; i < CDK_RANDOM_LENGTH; i += 1) {
        out += CDK_CHARSET[crypto.randomInt(CDK_CHARSET.length)];
    }
    return out;
}

function createCdks(count) {
    const safeCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 100);
    const results = new Set();
    while (results.size < safeCount) {
        results.add(`${CDK_PREFIX}${randomCdkSuffix()}`);
    }
    return [...results];
}

function createAdminAssetsRouter({ store, ensureStoreReady, requireSecondaryAuth }) {
    const router = forwardAsyncErrors(express.Router());

    // ─── Local Card Pool ──────────────────────────────────────────────────

    router.get('/cards', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const cards = await store.listCardAssets();
            return res.json({ success: true, cards });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/cards/import', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
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

    router.delete('/cards/:id', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const cardId = Number(req.params.id);
            if (!cardId || !Number.isFinite(cardId)) {
                return res.status(400).json({ success: false, error: '无效的卡片 ID' });
            }
            const deleted = await store.deleteCardAssetById(cardId);
            if (!deleted) {
                return res.status(404).json({ success: false, error: '卡片不存在' });
            }
            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ─── Proxy Pool ───────────────────────────────────────────────────────

    router.get('/proxies', async (req, res) => {
        try {
            await ensureStoreReady();
            const proxies = await store.listProxyAssets();
            return res.json({ success: true, proxies });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/proxies', async (req, res) => {
        try {
            await ensureStoreReady();
            const input = req.body?.proxies ?? req.body?.proxy_url ?? req.body?.proxy ?? '';
            const result = await store.addProxyAssets(input);
            if (!result.success) {
                return res.status(400).json(result);
            }
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.put('/proxies/:id', async (req, res) => {
        try {
            await ensureStoreReady();
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_active')) {
                const result = await store.setProxyAssetActive(req.params.id, Boolean(req.body.is_active));
                if (!result.success) {
                    return res.status(404).json(result);
                }
                return res.json(result);
            }
            return res.status(400).json({ success: false, error: '缺少可更新字段' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/proxies/:id/test', async (req, res) => {
        try {
            await ensureStoreReady();
            const row = await store.getProxyAssetById(req.params.id);
            if (!row) {
                return res.status(404).json({ success: false, error: '代理不存在' });
            }
            const result = await testProxyUrl(row.proxy_url);
            await store.updateProxyAssetCheck(row.id, result);
            return res.json({ success: true, id: row.id, ...result });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.delete('/proxies/:id', async (req, res) => {
        try {
            await ensureStoreReady();
            const result = await store.deleteProxyAsset(req.params.id);
            if (!result.success) {
                return res.status(404).json(result);
            }
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/proxy/test', async (req, res) => {
        try {
            await ensureStoreReady();
            const ids = Array.isArray(req.body?.ids)
                ? req.body.ids.map((id) => Number(id)).filter((id) => id > 0)
                : [];
            const rawProxies = normalizeProxyLines(
                req.body?.proxies || req.body?.proxy || req.body?.proxy_url || []
            );
            const persist = req.body?.persist !== false;

            let targets = [];
            if (ids.length) {
                const saved = await store.listProxyAssets();
                const map = new Map(saved.map((item) => [item.id, item]));
                targets = ids.map((id) => {
                    const row = map.get(id);
                    return row ? { id, proxy_url: row.proxy_url } : null;
                }).filter(Boolean);
            } else {
                targets = rawProxies.map((proxyUrl) => ({ id: null, proxy_url: proxyUrl }));
            }

            if (!targets.length) {
                return res.status(400).json({ success: false, message: '未提供代理 URL 或 ID' });
            }
            if (targets.length > 50) {
                return res.status(400).json({ success: false, message: '一次最多测试 50 条代理' });
            }

            const results = await Promise.all(targets.map(async (target) => {
                const result = await testProxyUrl(target.proxy_url);
                if (persist && target.id) {
                    await store.updateProxyAssetCheck(target.id, result);
                }
                return { id: target.id, proxy_url: target.proxy_url, ...result };
            }));

            return res.json({ success: true, results });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ─── CDK Management ───────────────────────────────────────────────────

    router.get('/cdks', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            return res.json(await store.listCdks());
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/cdks/generate', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            let planType;
            try {
                planType = requireCanonicalPlanType(req.body?.plan_type || 'plus');
            } catch (error) {
                return res.status(400).json({ success: false, message: error.message });
            }
            const newCdks = createCdks(req.body?.count);
            const result = await store.insertCdks(newCdks, { type: '自助', plan_type: planType });
            return res.json({
                success: true,
                message: `成功生成 ${result.insertedCount} 个自助 CDK`,
                cdks: newCdks,
                insertedCount: result.insertedCount,
                plan_type: planType
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/cdks/import', requireSecondaryAuth, async (req, res) => {
        const cdks = Array.isArray(req.body?.cdks) ? req.body.cdks : [];
        if (cdks.length === 0) {
            return res.status(400).json({ success: false, message: '请提供要导入的卡密' });
        }
        const weakCdks = adminAuth.findWeakCdkCodes(cdks);
        if (weakCdks.length > 0) {
            const preview = weakCdks.slice(0, 5).join('、');
            return res.status(400).json({
                success: false,
                message: `有 ${weakCdks.length} 个卡密少于 ${adminAuth.MIN_IMPORTED_CDK_LENGTH} 位，容易被猜中，已拒绝整批导入：${preview}${weakCdks.length > 5 ? ' 等' : ''}`
            });
        }

        try {
            await ensureStoreReady();
            let planType;
            try {
                planType = requireCanonicalPlanType(req.body?.plan_type || 'plus');
            } catch (error) {
                return res.status(400).json({ success: false, message: error.message });
            }
            const summary = await store.insertCdks(cdks, { plan_type: planType });
            return res.json({
                success: true,
                message: `导入完成，新增 ${summary.insertedCount} 个，重复 ${summary.duplicateCount} 个`,
                ...summary
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/cdks/:cdk/ship', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const updated = await store.markCdkShipped(req.params.cdk);
            if (!updated) {
                return res.status(404).json({ success: false, message: 'CDK 不存在' });
            }
            return res.json({ success: true, message: 'CDK 已标记出库' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.delete('/cdks/:cdk', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            await store.deleteCdk(req.params.cdk);
            return res.json({ success: true, message: 'CDK 已删除' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
}

module.exports = {
    createCdks,
    createAdminAssetsRouter
};
