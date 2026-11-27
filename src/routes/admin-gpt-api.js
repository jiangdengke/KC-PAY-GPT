'use strict';

const express = require('express');
const { CANONICAL_PLAN_TYPES, getPlanLabel } = require('../config/plan-registry');
const adminAuth = require('../security/admin-auth');
const gptApi = require('../services/gpt-api-client');
const orbitcard = require('../services/orbitcard-client');
const { sendTelegramTest } = require('../services/telegram-notify');
const { forwardAsyncErrors } = require('../middleware/async-handler');

const GPT_API_SECRET_TARGETS = [
    { urlField: 'base_url', secretFields: ['api_key'], label: '代充 API 地址' },
    { urlField: 'orbitcard_base_url', secretFields: ['orbitcard_api_key', 'orbitcard_api_secret'], label: 'Orbitcard 地址' }
];

function createAdminGptApiRouter({ store, ensureStoreReady, taskHub, requireSecondaryAuth }) {
    const router = forwardAsyncErrors(express.Router());

    router.get('/gpt-api', async (req, res) => {
        try {
            await ensureStoreReady();
            const cfg = await store.getGptApiConfig();
            return res.json({
                success: true,
                config: {
                    enabled: cfg.enabled,
                    base_url: cfg.base_url,
                    api_key_saved: Boolean(cfg.api_key),
                    api_key_preview: gptApi.maskApiKey(cfg.api_key),
                    plan_key: cfg.plan_key,
                    plan_mappings: cfg.plan_mappings,
                    orbitcard_reuse_limits: cfg.orbitcard_reuse_limits,
                    orbitcard_safety_margins: cfg.orbitcard_safety_margins,
                    country: cfg.country,
                    currency: cfg.currency,
                    payment_region: cfg.payment_region,
                    card_source: cfg.card_source,
                    orbitcard_base_url: cfg.orbitcard_base_url,
                    orbitcard_api_key_saved: Boolean(cfg.orbitcard_api_key),
                    orbitcard_api_key_preview: orbitcard.maskApiKey(cfg.orbitcard_api_key),
                    orbitcard_api_secret_configured: Boolean(cfg.orbitcard_api_secret),
                    orbitcard_api_secret_preview: orbitcard.maskApiKey(cfg.orbitcard_api_secret),
                    orbitcard_product_code: cfg.orbitcard_product_code || ''
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/gpt-api', async (req, res) => {
        try {
            await ensureStoreReady();
            const body = req.body || {};
            const redirectError = adminAuth.findSavedSecretRedirect(body, await store.getGptApiConfig(), GPT_API_SECRET_TARGETS);
            if (redirectError) {
                return res.status(400).json({ success: false, message: redirectError });
            }
            await store.saveGptApiConfig({
                enabled: Boolean(body.enabled),
                base_url: body.base_url,
                api_key: body.api_key,
                plan_key: body.plan_key,
                plan_mappings: body.plan_mappings,
                orbitcard_reuse_limits: body.orbitcard_reuse_limits,
                orbitcard_safety_margins: body.orbitcard_safety_margins,
                country: body.country,
                currency: body.currency,
                payment_region: body.payment_region,
                card_source: body.card_source,
                orbitcard_base_url: body.orbitcard_base_url,
                orbitcard_api_key: body.orbitcard_api_key,
                orbitcard_api_secret: body.orbitcard_api_secret
            });
            return res.json({ success: true, message: '第三方代充 API 配置已保存' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/gpt-api/test', async (req, res) => {
        try {
            await ensureStoreReady();
            const body = req.body || {};
            const saved = await store.getGptApiConfig();
            const redirectError = adminAuth.findSavedSecretRedirect(body, saved, GPT_API_SECRET_TARGETS);
            if (redirectError) {
                return res.status(400).json({ success: false, message: redirectError });
            }
            const merged = {
                base_url: String(body.base_url || '').trim() || saved.base_url,
                api_key: String(body.api_key || '').trim() || saved.api_key,
                plan_key: String(body.plan_key || '').trim() || saved.plan_key,
                plan_mappings: { ...saved.plan_mappings, ...(body.plan_mappings || {}) },
                card_source: String(body.card_source || '').trim() || saved.card_source,
                payment_region: String(body.payment_region ?? '').trim().toUpperCase() || saved.payment_region,
                orbitcard_base_url: String(body.orbitcard_base_url || '').trim() || saved.orbitcard_base_url,
                orbitcard_api_key: String(body.orbitcard_api_key || '').trim() || saved.orbitcard_api_key,
                orbitcard_api_secret: String(body.orbitcard_api_secret || '').trim() || saved.orbitcard_api_secret
            };
            const result = await gptApi.testConnection(merged);
            if (!result.success) {
                return res.status(400).json({ success: false, message: result.error || '连接失败' });
            }
            return res.json({
                success: true,
                message: result.message,
                plans: result.plans,
                balance: result.balance,
                account: result.account || null,
                configured_plan: result.configuredPlan || null,
                plan_mappings: result.planMappings || null,
                card_source: result.cardSource || null,
                card_source_message: result.cardSourceMessage || null
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/gpt-api/status', async (req, res) => {
        try {
            await ensureStoreReady();
            const cfg = await store.getGptApiConfig();
            if (!cfg.api_key) {
                return res.status(400).json({ success: false, message: '尚未配置第三方代充 API Key' });
            }
            const [plansResult, balanceResult, recentOrders] = await Promise.all([
                gptApi.fetchPlans(cfg),
                gptApi.queryBalance(cfg),
                store.listRecentGptApiOrders(10)
            ]);
            if (!plansResult.success) {
                return res.status(400).json({ success: false, message: `套餐查询失败: ${plansResult.error || '未知错误'}` });
            }
            const orders = recentOrders.map((order) => ({
                job_key: order.job_key,
                cdk_code: order.cdk_code,
                status: order.status,
                message: order.message,
                updated_at: order.updated_at,
                order_id: order.gpt_api_order_id,
                task_id: order.gpt_api_task_id,
                topup_code: order.gpt_api_topup_code || null
            }));
            return res.json({
                success: true,
                gpt_plans: plansResult.gptPlans,
                credit_plans: plansResult.creditPlans,
                balance: balanceResult.success ? balanceResult.data : null,
                account: plansResult.account || balanceResult.account || null,
                configured_plan: plansResult.configuredPlan || cfg.plan_key || null,
                plan_mappings: plansResult.planMappings || null,
                card_source: plansResult.cardSource || null,
                card_source_message: plansResult.cardSourceMessage || null,
                balance_error: balanceResult.success ? null : balanceResult.error,
                recent_orders: orders
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/orbitcard/products', async (req, res) => {
        try {
            await ensureStoreReady();
            const cfg = await store.getGptApiConfig();
            if (!cfg.orbitcard_api_key || !cfg.orbitcard_api_secret) {
                return res.status(400).json({ success: false, message: '请先配置 Orbitcard API Key 和 Secret' });
            }
            const planType = CANONICAL_PLAN_TYPES.includes(String(req.query.plan || '').trim())
                ? String(req.query.plan).trim()
                : 'plus';
            const result = await orbitcard.getProductCode({
                base_url: cfg.orbitcard_base_url,
                api_key: cfg.orbitcard_api_key,
                api_secret: cfg.orbitcard_api_secret
            });
            if (!result.success) {
                return res.status(502).json({ success: false, message: `Orbitcard 产品目录查询失败: ${result.error || '未知错误'}` });
            }
            const strategyCatalog = orbitcard.buildProductStrategyCatalog(result.data, {
                reuseLimits: cfg.orbitcard_reuse_limits,
                safetyMargins: cfg.orbitcard_safety_margins
            });
            const products = strategyCatalog.products.map((product) => ({
                ...product,
                amount: product.plans[planType]?.amount ?? null,
                plan_price: product.plans[planType]?.plan_price ?? null,
                currency: product.plans[planType]?.currency || 'USD',
                max_usage_count: product.plans[planType]?.max_usage_count ?? null
            }));
            return res.json({
                success: true,
                plan_type: planType,
                selected_product_code: cfg.orbitcard_product_code || '',
                fetched_at: new Date().toISOString(),
                automatic: strategyCatalog.automatic,
                reuse_limits: cfg.orbitcard_reuse_limits,
                safety_margins: cfg.orbitcard_safety_margins,
                products
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/orbitcard/product-strategy', async (req, res) => {
        try {
            await ensureStoreReady();
            const cfg = await store.getGptApiConfig();
            const productCode = String(req.body?.product_code || '').trim();
            const reuseLimits = { ...cfg.orbitcard_reuse_limits };
            const safetyMargins = { ...cfg.orbitcard_safety_margins };

            for (const planType of CANONICAL_PLAN_TYPES) {
                if (!Object.prototype.hasOwnProperty.call(req.body?.reuse_limits || {}, planType)) continue;
                const value = Number(req.body.reuse_limits[planType]);
                if (!Number.isInteger(value) || value < 1 || value > 20) {
                    return res.status(400).json({ success: false, message: `${planType} 的一卡几冲必须是 1-20 的整数` });
                }
                reuseLimits[planType] = value;
            }
            for (const planType of CANONICAL_PLAN_TYPES) {
                if (!Object.prototype.hasOwnProperty.call(req.body?.safety_margins || {}, planType)) continue;
                const value = Number(req.body.safety_margins[planType]);
                if (!Number.isFinite(value) || value < 0 || value > 100) {
                    return res.status(400).json({ success: false, message: `${planType} 的开卡安全余量必须是 0-100 的数字` });
                }
                safetyMargins[planType] = value;
            }
            if (productCode) {
                if (!cfg.orbitcard_api_key || !cfg.orbitcard_api_secret) {
                    return res.status(400).json({ success: false, message: '请先配置 Orbitcard API Key 和 Secret' });
                }
                const result = await orbitcard.getProductCode({
                    base_url: cfg.orbitcard_base_url,
                    api_key: cfg.orbitcard_api_key,
                    api_secret: cfg.orbitcard_api_secret
                });
                if (!result.success) {
                    return res.status(502).json({ success: false, message: `Orbitcard 产品目录查询失败: ${result.error || '未知错误'}` });
                }
                const selectable = CANONICAL_PLAN_TYPES.some((planType) => (
                    orbitcard.getProductSelectionsForPlan(result.data, planType, {
                        preferredProductCode: productCode,
                        reuseLimits,
                        safetyMargins
                    }).length > 0
                ));
                if (!selectable) {
                    return res.status(400).json({ success: false, message: '所选产品已不可用或缺少有效套餐价格，请刷新上游库存后重新选择' });
                }
            }
            await store.setAppConfigValue('orbitcard_product_code', productCode);
            await store.setAppConfigValue('orbitcard_next_product_code', '');
            for (const planType of CANONICAL_PLAN_TYPES) {
                await store.setAppConfigValue(`orbitcard_reuse_limit_${planType}`, reuseLimits[planType]);
                await store.setAppConfigValue(`orbitcard_safety_margin_${planType}`, safetyMargins[planType]);
            }
            return res.json({
                success: true,
                product_code: productCode,
                reuse_limits: reuseLimits,
                safety_margins: safetyMargins,
                message: productCode ? 'Orbitcard 后续开卡产品与复用上限已保存' : '已恢复自动按优先级开卡，复用上限已保存'
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get('/orbitcard/usage', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const requestedPageSize = Number.parseInt(String(req.query.page_size || req.query.limit || ''), 10);
            const requestedPage = Number.parseInt(String(req.query.page || ''), 10);
            const pageSize = Number.isInteger(requestedPageSize) ? Math.max(1, Math.min(100, requestedPageSize)) : 20;
            let page = Number.isInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
            const filters = {
                keyword: String(req.query.keyword || '').trim().slice(0, 80),
                planType: String(req.query.plan_type || '').trim(),
                cardStatus: String(req.query.card_status || '').trim(),
                rechargeStatus: String(req.query.recharge_status || '').trim()
            };
            let total = await store.countOrbitcardUsage(filters);
            let totalPages = Math.max(1, Math.ceil(total / pageSize));
            page = Math.min(page, totalPages);
            let offset = (page - 1) * pageSize;
            let cards = await store.listOrbitcardUsage(pageSize, offset, filters);

            if (String(req.query.refresh || '') === '1' && cards.length) {
                const cfg = await store.getGptApiConfig();
                if (cfg.card_source !== 'orbitcard') {
                    return res.status(400).json({ success: false, message: '当前卡源不是 Orbitcard' });
                }
                const orbitCfg = {
                    base_url: cfg.orbitcard_base_url,
                    api_key: cfg.orbitcard_api_key,
                    api_secret: cfg.orbitcard_api_secret
                };
                const providerList = await orbitcard.getCardList(orbitCfg, { status: '' });
                const providerCardIds = providerList.success
                    ? providerList.data.map((providerCard) => providerCard.cardId)
                    : [];
                const providerCardIdSet = new Set(providerCardIds.map((cardId) => Number(cardId)));
                if (providerList.success) {
                    await store.markMissingOrbitcardCards(providerCardIds);
                    total = await store.countOrbitcardUsage(filters);
                    totalPages = Math.max(1, Math.ceil(total / pageSize));
                    page = Math.min(page, totalPages);
                    offset = (page - 1) * pageSize;
                    cards = await store.listOrbitcardUsage(pageSize, offset, filters);
                }
                await Promise.all(cards.map(async (card) => {
                    if (providerList.success && !providerCardIdSet.has(Number(card.cardId))) {
                        card.status = 'PROVIDER_DELETED';
                        card.providerStatus = 'DELETED';
                        card.balance = null;
                        card.balanceCurrency = '';
                        card.balanceError = '上游卡列表中不存在';
                        return;
                    }
                    const summary = await orbitcard.getCardSummary(orbitCfg, card.cardId);
                    if (!summary.success) {
                        card.balanceError = summary.error || '余额查询失败';
                        return;
                    }
                    card.providerStatus = summary.data.status || '';
                    if (summary.data.balance == null) {
                        card.balanceError = '上游未提供单卡余额';
                        return;
                    }
                    card.balance = summary.data.balance;
                    card.balanceCurrency = summary.data.currency || 'USD';
                    card.balanceError = '';
                    await store.updateOrbitcardCardBalance(card.cardId, {
                        balance: card.balance,
                        currency: card.balanceCurrency,
                        providerStatus: card.providerStatus
                    });
                    card.balanceUpdatedAt = new Date().toISOString();
                }));
                if (!providerList.success) {
                    cards.forEach((card) => {
                        card.providerSyncError = providerList.error || '上游卡列表查询失败';
                    });
                }
            }
            return res.json({ success: true, cards, total, page, pageSize });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/orbitcard/sync', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const cfg = await store.getGptApiConfig();
            if (!cfg.orbitcard_api_key || !cfg.orbitcard_api_secret) {
                return res.status(400).json({ success: false, message: '请先配置 Orbitcard API Key 和 Secret' });
            }
            const orbitCfg = {
                base_url: cfg.orbitcard_base_url,
                api_key: cfg.orbitcard_api_key,
                api_secret: cfg.orbitcard_api_secret
            };
            const providerList = await orbitcard.getCardList(orbitCfg, { status: '' });
            if (!providerList.success) {
                return res.status(502).json({
                    success: false,
                    message: `Orbitcard 卡片列表查询失败: ${providerList.error || '未知错误'}`
                });
            }

            const syncedCards = [];
            const detailFailures = [];
            for (const providerCard of providerList.data) {
                let detail = null;
                try {
                    const detailResult = await orbitcard.getCardDetail(orbitCfg, providerCard.cardId);
                    if (detailResult.success) {
                        detail = detailResult.data;
                    } else {
                        detailFailures.push({
                            cardId: providerCard.cardId,
                            error: detailResult.error || '卡片详情查询失败'
                        });
                    }
                } catch (error) {
                    detailFailures.push({
                        cardId: providerCard.cardId,
                        error: error.message || '卡片详情查询失败'
                    });
                }

                syncedCards.push({
                    ...providerCard,
                    cardNumber: detail?.cardNumber || '',
                    cardExpiry: detail?.expiry || '',
                    cardCvc: detail?.cvc || '',
                    cardHolder: detail?.holder || ''
                });
            }

            const syncResult = await store.syncOrbitcardCards(syncedCards);
            await store.markMissingOrbitcardCards(providerList.data.map((card) => card.cardId));
            return res.json({
                success: true,
                total: syncResult.total,
                inserted: syncResult.inserted,
                updated: syncResult.updated,
                detailFailures,
                message: detailFailures.length
                    ? `已同步 ${syncResult.total} 张卡，其中 ${detailFailures.length} 张未获取完整卡资料`
                    : `已同步 ${syncResult.total} 张卡台卡片`
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/orbitcard/cards/:cardId/restore', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const cardId = Number(req.params.cardId);
            if (!Number.isInteger(cardId) || cardId <= 0) {
                return res.status(400).json({ success: false, message: '卡片编号无效' });
            }
            const cfg = await store.getGptApiConfig();
            if (cfg.card_source !== 'orbitcard') {
                return res.status(400).json({ success: false, message: '当前卡源不是 Orbitcard' });
            }
            const localCards = await store.listOrbitcardUsage(500);
            const localCard = localCards.find((card) => Number(card.cardId) === cardId);
            if (!localCard) {
                return res.status(404).json({ success: false, message: '本地没有这张 Orbitcard 记录' });
            }
            if (String(localCard.status || '').toUpperCase() !== 'RETIRED') {
                return res.status(409).json({ success: false, message: '只有已退役卡片可以手动恢复' });
            }
            if (localCard.inUse) {
                return res.status(409).json({ success: false, message: '卡片当前正在使用，不能恢复' });
            }
            if (Number(localCard.usageCount || 0) >= Number(localCard.maxUsageCount || 1)) {
                return res.status(409).json({ success: false, message: '卡片已达到使用上限，不能恢复' });
            }
            const orbitCfg = {
                base_url: cfg.orbitcard_base_url,
                api_key: cfg.orbitcard_api_key,
                api_secret: cfg.orbitcard_api_secret
            };
            const upstream = await orbitcard.setCardStatus(orbitCfg, cardId, 'ACTIVE', `admin-restore-${cardId}-${Date.now()}`);
            if (!upstream.success) {
                return res.status(502).json({ success: false, message: `Orbitcard 解冻失败: ${upstream.error || '未知错误'}` });
            }
            const restored = await store.restoreOrbitcardCard(cardId);
            if (!restored) {
                return res.status(409).json({ success: false, message: '卡片已达到使用上限，不能恢复' });
            }
            return res.json({ success: true, message: '卡片已解冻并恢复可用' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/orbitcard/cards/:cardId/plan', requireSecondaryAuth, async (req, res) => {
        try {
            await ensureStoreReady();
            const cardId = Number(req.params.cardId);
            const planType = String(req.body?.plan_type || '').trim();
            if (!Number.isInteger(cardId) || cardId <= 0) {
                return res.status(400).json({ success: false, message: '卡片编号无效' });
            }
            if (!CANONICAL_PLAN_TYPES.includes(planType)) {
                return res.status(400).json({ success: false, message: '套餐类型无效' });
            }
            const cfg = await store.getGptApiConfig();
            if (cfg.card_source !== 'orbitcard') {
                return res.status(400).json({ success: false, message: '当前卡源不是 Orbitcard' });
            }
            const requestedMaxUsageCount = req.body?.max_usage_count;
            const hasCustomMaxUsageCount = requestedMaxUsageCount !== undefined
                && requestedMaxUsageCount !== null
                && String(requestedMaxUsageCount).trim() !== '';
            const maxUsageCount = hasCustomMaxUsageCount
                ? Number(requestedMaxUsageCount)
                : orbitcard.getPlanReuseLimit(planType, cfg.orbitcard_reuse_limits);
            if (!Number.isInteger(maxUsageCount) || maxUsageCount < 1 || maxUsageCount > 20) {
                return res.status(400).json({ success: false, message: '单卡使用上限必须是 1-20 的整数' });
            }
            const result = await store.assignOrbitcardCardPlan(cardId, planType, maxUsageCount);
            if (result.success) {
                return res.json({
                    success: true,
                    planType,
                    maxUsageCount,
                    message: `卡片已绑定 ${getPlanLabel(planType)} 套餐，单卡上限 ${maxUsageCount} 次`
                });
            }
            const errorMessages = {
                invalid: '卡片参数无效',
                invalid_plan: '套餐类型无效',
                not_found: '本地没有这张 Orbitcard 记录',
                in_use: '卡片当前正在使用，暂时不能修改套餐',
                usage_exceeded: `卡片当前已使用 ${maxUsageCount} 次，单卡上限不能低于已用次数`
            };
            return res.status(result.reason === 'not_found' ? 404 : 409).json({
                success: false,
                message: errorMessages[result.reason] || '绑定套餐失败'
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/config', async (req, res) => {
        try {
            await ensureStoreReady();
            const nextConfig = { ...(req.body || {}) };
            if (nextConfig.maintenance_mode) {
                nextConfig.maintenance_mode_drain = taskHub.getTotalActiveJobs() > 0;
            } else {
                nextConfig.maintenance_mode_drain = false;
            }
            await store.saveConfig(nextConfig);
            return res.json({ success: true, message: '系统配置已保存' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/telegram', async (req, res) => {
        try {
            await ensureStoreReady();
            const body = req.body || {};
            await store.saveTelegramConfig({
                bot_token: body.bot_token,
                admin_chat_id: body.admin_chat_id,
                group_chat_id: body.group_chat_id,
                notify_admin: Boolean(body.notify_admin),
                notify_group: Boolean(body.notify_group),
                on_success: Boolean(body.on_success),
                on_failure: Boolean(body.on_failure),
                on_card_pool_empty: Boolean(body.on_card_pool_empty)
            });
            return res.json({ success: true, message: 'Telegram 通知配置已保存' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post('/telegram/test', async (req, res) => {
        try {
            await ensureStoreReady();
            const result = await sendTelegramTest(store, req.body || {});
            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }
            return res.json({ success: true, message: result.message });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
}

module.exports = { createAdminGptApiRouter };
