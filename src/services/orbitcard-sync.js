'use strict';

const defaultOrbitcard = require('./orbitcard-client');

const DEFAULT_ORBITCARD_AUTO_SYNC_INTERVAL_MS = 3 * 60 * 1000;
const MIN_ORBITCARD_AUTO_SYNC_INTERVAL_MS = 30 * 1000;
const DEFAULT_ORBITCARD_AUTO_SYNC_INITIAL_DELAY_MS = 15 * 1000;

/**
 * 同步 Orbitcard 卡片列表，并为未绑定套餐的 ACTIVE 非禁用卡按余额自动推算可充 Plus 次数。
 * - admin 同步（fetchDetails = true）：拉全量状态、拉卡详情（含敏感卡资料）与余额、标记上游已删卡。
 * - 下单兜底 / 定时轻量同步（fetchDetails = false）：拉上游 ACTIVE 列表，不碰明文卡号/CVV，仅对本地未绑定且缺余额的卡补查摘要余额。
 */
async function syncAndAutoAssignOrbitcardCards({
    store,
    orbitcard = defaultOrbitcard,
    cfg,
    providerCards = null,
    fetchDetails = true,
    markMissing = fetchDetails
}) {
    const orbitCfg = {
        base_url: cfg.orbitcard_base_url,
        api_key: cfg.orbitcard_api_key,
        api_secret: cfg.orbitcard_api_secret
    };

    let list = Array.isArray(providerCards) ? providerCards : null;
    if (!list) {
        const providerList = await orbitcard.getCardList(orbitCfg, { status: fetchDetails ? '' : 'ACTIVE' });
        if (!providerList.success) {
            return {
                success: false,
                statusCode: 502,
                error: `Orbitcard 卡片列表查询失败: ${providerList.error || '未知错误'}`
            };
        }
        list = providerList.data;
    }

    const existingMetaMap = new Map();
    if (typeof store.getOrbitcardCardMetaByIds === 'function' && list.length) {
        const metaRows = await store.getOrbitcardCardMetaByIds(list.map((card) => card.cardId));
        for (const row of metaRows) {
            existingMetaMap.set(Number(row.cardId), row);
        }
    }

    const hasCardNeedingEstimate = list.some((providerCard) => {
        const cardId = Number(providerCard?.cardId ?? providerCard?.card_id ?? providerCard?.id);
        if (!Number.isInteger(cardId) || cardId <= 0) return false;
        const existing = existingMetaMap.get(cardId) || null;
        const alreadyBound = Boolean(existing?.planType);
        const existingRetired = String(existing?.status || '').toUpperCase() === 'RETIRED';
        const isActive = String(providerCard.status || 'ACTIVE').trim().toUpperCase() === 'ACTIVE';
        return !alreadyBound && !existingRetired && isActive && !orbitcard.isBlockedCardProduct(providerCard);
    });

    let productCatalog = [];
    if (hasCardNeedingEstimate) {
        try {
            const productResult = await orbitcard.getProductCode(orbitCfg);
            if (productResult?.success) {
                productCatalog = orbitcard.normalizeProductList(productResult.data);
            }
        } catch (_) {
            // 目录拉取失败时退回配置的兜底 Plus 单价，不阻断同步
        }
    }

    const syncedCards = [];
    const detailFailures = [];
    for (const providerCard of list) {
        const cardId = Number(providerCard?.cardId ?? providerCard?.card_id ?? providerCard?.id);
        if (!Number.isInteger(cardId) || cardId <= 0) continue;

        const existing = existingMetaMap.get(cardId) || null;
        const alreadyBound = Boolean(existing?.planType);
        const existingRetired = String(existing?.status || '').toUpperCase() === 'RETIRED';
        const isActive = String(providerCard.status || 'ACTIVE').trim().toUpperCase() === 'ACTIVE';

        let detail = null;
        let balance = providerCard.balance ?? null;
        let currency = providerCard.currency || '';
        let productCode = providerCard.productCode || '';

        if (fetchDetails) {
            try {
                const detailResult = await orbitcard.getCardDetail(orbitCfg, cardId);
                if (detailResult.success) {
                    detail = detailResult.data;
                    if (balance == null && detail.balance != null) balance = detail.balance;
                    if (!currency && detail.currency) currency = detail.currency;
                    if (!productCode && detail.productCode) productCode = detail.productCode;
                } else {
                    detailFailures.push({
                        cardId,
                        error: detailResult.error || '卡片详情查询失败'
                    });
                }
            } catch (error) {
                detailFailures.push({
                    cardId,
                    error: error.message || '卡片详情查询失败'
                });
            }
        }

        // 若卡列表与详情都未返回余额，且该卡需要推算容量（未绑定且 ACTIVE 非禁用），则补查摘要余额
        const needsBalanceForEstimate = !alreadyBound
            && !existingRetired
            && isActive
            && !orbitcard.isBlockedCardProduct({ ...providerCard, productCode });
        if (balance == null && needsBalanceForEstimate && typeof orbitcard.getCardSummary === 'function') {
            try {
                const summary = await orbitcard.getCardSummary(orbitCfg, cardId);
                if (summary?.success && summary.data) {
                    if (summary.data.balance != null) balance = summary.data.balance;
                    if (!currency && summary.data.currency) currency = summary.data.currency;
                    if (!productCode && summary.data.productCode) productCode = summary.data.productCode;
                }
            } catch (_) {
                // 摘要余额查询失败不阻断其它卡同步
            }
        }

        const mergedCard = {
            ...providerCard,
            cardId,
            productCode,
            balance,
            currency,
            cardNumber: detail?.cardNumber || '',
            cardExpiry: detail?.expiry || '',
            cardCvc: detail?.cvc || '',
            cardHolder: detail?.holder || ''
        };

        let autoPlanType = null;
        let autoMaxUsageCount = null;
        let autoInitialAmount = null;
        if (!alreadyBound && !existingRetired && isActive) {
            const estimate = orbitcard.estimatePlusCapacityFromBalance(mergedCard, {
                productCatalog,
                reuseLimits: cfg.orbitcard_reuse_limits,
                safetyMargins: cfg.orbitcard_safety_margins,
                fallbackPlusPrice: cfg.orbitcard_plus_unit_price
            });
            if (estimate.eligible && estimate.estimatedCount >= 1) {
                autoPlanType = estimate.planType;
                autoMaxUsageCount = estimate.estimatedCount;
                autoInitialAmount = estimate.balance;
            }
        }

        syncedCards.push({
            ...mergedCard,
            autoPlanType,
            autoMaxUsageCount,
            autoInitialAmount
        });
    }

    const syncResult = await store.syncOrbitcardCards(syncedCards);
    if (markMissing && typeof store.markMissingOrbitcardCards === 'function') {
        await store.markMissingOrbitcardCards(list.map((card) => card.cardId));
    }

    return {
        success: true,
        total: syncResult.total,
        inserted: syncResult.inserted,
        updated: syncResult.updated,
        autoAssigned: syncResult.autoAssigned || 0,
        autoAssignedCards: syncResult.autoAssignedCards || [],
        detailFailures
    };
}

function normalizeAutoSyncIntervalMs(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return DEFAULT_ORBITCARD_AUTO_SYNC_INTERVAL_MS;
    }
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_ORBITCARD_AUTO_SYNC_INTERVAL_MS;
    }
    if (parsed <= 0) {
        return 0;
    }
    return Math.max(MIN_ORBITCARD_AUTO_SYNC_INTERVAL_MS, Math.floor(parsed));
}

function createOrbitcardAutoSync({
    store,
    ensureStoreReady = null,
    orbitcard = defaultOrbitcard,
    intervalMs = DEFAULT_ORBITCARD_AUTO_SYNC_INTERVAL_MS,
    initialDelayMs = DEFAULT_ORBITCARD_AUTO_SYNC_INITIAL_DELAY_MS,
    logger = console
} = {}) {
    const effectiveIntervalMs = normalizeAutoSyncIntervalMs(intervalMs);
    const effectiveInitialDelayMs = Number.isFinite(Number(initialDelayMs)) && Number(initialDelayMs) >= 0
        ? Math.floor(Number(initialDelayMs))
        : DEFAULT_ORBITCARD_AUTO_SYNC_INITIAL_DELAY_MS;

    let started = false;
    let running = false;
    let initialTimer = null;
    let intervalTimer = null;
    let lastRunAt = null;
    let lastSuccessAt = null;
    let lastError = '';
    let lastSkippedReason = '';
    let lastResult = null;

    async function runOnce({ trigger = 'interval' } = {}) {
        if (running) {
            return { skipped: true, reason: 'in_progress' };
        }
        running = true;
        lastRunAt = new Date().toISOString();
        try {
            if (typeof ensureStoreReady === 'function') {
                await ensureStoreReady();
            }
            const cfg = await store.getGptApiConfig();
            const cardSource = String(cfg?.card_source || 'local').trim().toLowerCase();
            if (cardSource !== 'orbitcard') {
                lastSkippedReason = 'card_source_not_orbitcard';
                return { skipped: true, reason: lastSkippedReason };
            }
            if (!cfg?.orbitcard_api_key || !cfg?.orbitcard_api_secret) {
                lastSkippedReason = 'missing_credentials';
                return { skipped: true, reason: lastSkippedReason };
            }

            const result = await syncAndAutoAssignOrbitcardCards({
                store,
                orbitcard,
                cfg,
                fetchDetails: false,
                markMissing: false
            });
            if (!result.success) {
                lastError = result.error || '轻量自动同步失败';
                lastSkippedReason = '';
                logger?.warn?.(`[OrbitcardAutoSync] 定时轻量同步失败 (${trigger}): ${lastError}`);
                return { skipped: false, success: false, error: lastError };
            }

            lastSuccessAt = new Date().toISOString();
            lastError = '';
            lastSkippedReason = '';
            lastResult = {
                total: result.total,
                inserted: result.inserted,
                updated: result.updated,
                autoAssigned: result.autoAssigned
            };
            if (result.inserted > 0 || result.autoAssigned > 0) {
                logger?.log?.(
                    `[OrbitcardAutoSync] 轻量同步完成 (${trigger}): 共 ${result.total} 张，新入库 ${result.inserted} 张，自动绑定 Plus ${result.autoAssigned} 张`
                );
            }
            return { skipped: false, ...result };
        } catch (error) {
            lastError = error?.message || String(error || '未知错误');
            lastSkippedReason = '';
            logger?.warn?.(`[OrbitcardAutoSync] 定时轻量同步异常 (${trigger}): ${lastError}`);
            return { skipped: false, success: false, error: lastError };
        } finally {
            running = false;
        }
    }

    function start() {
        if (started || effectiveIntervalMs <= 0) {
            return false;
        }
        started = true;
        if (effectiveInitialDelayMs === 0) {
            runOnce({ trigger: 'startup' }).catch(() => {});
        } else {
            initialTimer = setTimeout(() => {
                initialTimer = null;
                runOnce({ trigger: 'startup' }).catch(() => {});
            }, effectiveInitialDelayMs);
            initialTimer.unref?.();
        }
        intervalTimer = setInterval(() => {
            runOnce({ trigger: 'interval' }).catch(() => {});
        }, effectiveIntervalMs);
        intervalTimer.unref?.();
        logger?.log?.(
            `[OrbitcardAutoSync] 已启用后端定时轻量同步（每 ${Math.round(effectiveIntervalMs / 1000)} 秒，仅活跃卡/不拉明文卡号）`
        );
        return true;
    }

    function stop() {
        if (initialTimer) {
            clearTimeout(initialTimer);
            initialTimer = null;
        }
        if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = null;
        }
        started = false;
    }

    function getStatus() {
        return {
            enabled: effectiveIntervalMs > 0,
            started,
            running,
            intervalMs: effectiveIntervalMs,
            intervalSeconds: Math.round(effectiveIntervalMs / 1000),
            lastRunAt,
            lastSuccessAt,
            lastError,
            lastSkippedReason,
            lastResult
        };
    }

    return {
        start,
        stop,
        runOnce,
        getStatus
    };
}

module.exports = {
    DEFAULT_ORBITCARD_AUTO_SYNC_INTERVAL_MS,
    MIN_ORBITCARD_AUTO_SYNC_INTERVAL_MS,
    DEFAULT_ORBITCARD_AUTO_SYNC_INITIAL_DELAY_MS,
    syncAndAutoAssignOrbitcardCards,
    createOrbitcardAutoSync
};
