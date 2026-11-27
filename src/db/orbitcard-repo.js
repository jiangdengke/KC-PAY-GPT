'use strict';

const {
    READABLE_PLAN_TYPES,
    requireCanonicalPlanType,
    requireReadablePlanType
} = require('../config/plan-registry');
const { runQuery, runExecute, withTransaction } = require('./pool');

const ORBITCARD_USAGE_CARD_STATUSES = new Set([
    'active',
    'reusable',
    'in_use',
    'retired',
    'provider_deleted',
    'cancelled',
    'unassigned'
]);
const ORBITCARD_USAGE_RECHARGE_STATUSES = new Set(['success', 'processing', 'failed']);

async function reserveOrbitcardCard(cards, ownerKey, options = {}) {
    const rawPlanType = String(options.planType || '').trim();
    const planType = rawPlanType ? requireReadablePlanType(rawPlanType, 'plan_type') : null;
    const maxUsageCount = Math.max(1, Number(options.maxUsageCount) || 1);
    const initialAmount = Number.isFinite(Number(options.initialAmount)) ? Number(options.initialAmount) : null;
    const persistMetadata = options.persistMetadata === true;
    const candidates = (Array.isArray(cards) ? cards : [])
        .map((card) => ({
            cardId: Number(card?.cardId ?? card?.card_id ?? card?.id),
            last4: String(card?.last4 || card?.card_last4 || '').slice(-4),
            status: String(card?.status || 'ACTIVE').trim().toUpperCase()
        }))
        .filter((card) => Number.isInteger(card.cardId) && card.cardId > 0 && card.status === 'ACTIVE');
    if (!candidates.length) return null;

    return withTransaction(async (connection) => {
        for (const card of candidates) {
            await connection.query(
                `INSERT INTO orbitcard_card_usage (card_id, status, plan_type, max_usage_count, initial_amount)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    status = CASE WHEN orbitcard_card_usage.status = 'RETIRED' THEN orbitcard_card_usage.status ELSE VALUES(status) END`,
                [
                    card.cardId,
                    card.status,
                    persistMetadata ? planType : null,
                    persistMetadata ? maxUsageCount : 1,
                    persistMetadata ? initialAmount : null
                ]
            );
        }
        const ids = candidates.map((card) => card.cardId);
        const placeholders = ids.map(() => '?').join(', ');
        const [rows] = await connection.query(
            `SELECT card_id, usage_count, max_usage_count, plan_type, initial_amount, last_used_at
             FROM orbitcard_card_usage
             WHERE card_id IN (${placeholders})
               AND status = 'ACTIVE'
               AND in_use = 0
               AND usage_count < max_usage_count
               AND (? IS NULL OR plan_type = ?)
               AND (cooldown_until IS NULL OR cooldown_until < NOW())
             ORDER BY usage_count ASC, COALESCE(last_used_at, '1970-01-01') ASC, card_id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [...ids, planType, planType]
        );
        if (!rows.length) return null;
        const row = rows[0];
        await connection.query(
            `UPDATE orbitcard_card_usage
             SET in_use = 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
             WHERE card_id = ?`,
            [String(ownerKey || '').slice(0, 64) || null, row.card_id]
        );
        const source = candidates.find((card) => card.cardId === Number(row.card_id));
        return {
            id: Number(row.card_id),
            orbitcard_id: Number(row.card_id),
            last4: source?.last4 || '',
            usage_count: Number(row.usage_count || 0),
            max_usage_count: Number(row.max_usage_count || maxUsageCount),
            plan_type: row.plan_type || planType,
            initial_amount: row.initial_amount == null ? initialAmount : Number(row.initial_amount)
        };
    });
}

async function releaseOrbitcardCard(cardId) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0) return;
    await runExecute(
        `UPDATE orbitcard_card_usage
         SET in_use = 0, locked_at = NULL, locked_by = NULL
         WHERE card_id = ?`,
        [id]
    );
}

async function retireOrbitcardCard(cardId) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0) return;
    await runExecute(
        `UPDATE orbitcard_card_usage
         SET status = 'RETIRED', in_use = 0, locked_at = NULL, locked_by = NULL
         WHERE card_id = ?`,
        [id]
    );
}

async function restoreOrbitcardCard(cardId) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const result = await runExecute(
        `UPDATE orbitcard_card_usage
         SET status = 'ACTIVE', in_use = 0, locked_at = NULL, locked_by = NULL,
             cooldown_until = NULL
         WHERE card_id = ?
           AND usage_count < max_usage_count`,
        [id]
    );
    return Number(result.affectedRows || 0) > 0;
}

async function assignOrbitcardCardPlan(cardId, planType, maxUsageCount) {
    const id = Number(cardId);
    let normalizedPlanType;
    try {
        normalizedPlanType = requireCanonicalPlanType(planType, 'plan_type');
    } catch (_) {
        return { success: false, reason: 'invalid_plan' };
    }
    const usageLimit = Math.max(1, Number(maxUsageCount) || 1);
    if (!Number.isInteger(id) || id <= 0 || !normalizedPlanType) {
        return { success: false, reason: 'invalid' };
    }

    const rows = await runQuery(
        'SELECT card_id, usage_count, in_use FROM orbitcard_card_usage WHERE card_id = ?',
        [id]
    );
    if (!rows.length) {
        return { success: false, reason: 'not_found' };
    }
    const card = rows[0];
    if (Number(card.in_use || 0) === 1) {
        return { success: false, reason: 'in_use' };
    }
    if (Number(card.usage_count || 0) > usageLimit) {
        return { success: false, reason: 'usage_exceeded' };
    }

    await runExecute(
        'UPDATE orbitcard_card_usage SET plan_type = ?, max_usage_count = ? WHERE card_id = ?',
        [normalizedPlanType, usageLimit, id]
    );
    return { success: true, planType: normalizedPlanType, maxUsageCount: usageLimit };
}

async function createOrbitcardRecharge({
    cardId,
    jobKey,
    planType = 'plus',
    cardLast4 = '',
    accountEmail = '',
    useNumber = 1,
    maxUsageCount = 1,
    initialAmount = null
} = {}) {
    const id = Number(cardId);
    const key = String(jobKey || '').trim();
    if (!Number.isInteger(id) || id <= 0 || !key) return false;
    const normalizedPlanType = requireReadablePlanType(planType || 'plus', 'plan_type');
    await runExecute(
        `INSERT INTO orbitcard_card_recharges
            (card_id, job_key, plan_type, card_last4, account_email, use_number, max_usage_count, initial_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
         ON DUPLICATE KEY UPDATE
            card_id = VALUES(card_id), plan_type = VALUES(plan_type), card_last4 = VALUES(card_last4),
            account_email = VALUES(account_email), use_number = VALUES(use_number),
            max_usage_count = VALUES(max_usage_count), initial_amount = VALUES(initial_amount)`,
        [
            id,
            key,
            normalizedPlanType,
            String(cardLast4 || '').replace(/\D/g, '').slice(-4),
            String(accountEmail || '').trim().slice(0, 255),
            Math.max(1, Number(useNumber) || 1),
            Math.max(1, Number(maxUsageCount) || 1),
            Number.isFinite(Number(initialAmount)) ? Number(initialAmount) : null
        ]
    );
    return true;
}

async function updateOrbitcardRecharge(jobKey, { status, orderId, message } = {}) {
    const key = String(jobKey || '').trim();
    if (!key) return;
    await runExecute(
        `UPDATE orbitcard_card_recharges
         SET status = COALESCE(?, status),
             order_id = COALESCE(?, order_id),
             message = COALESCE(?, message)
         WHERE job_key = ?`,
        [
            status ? String(status).trim() : null,
            orderId ? String(orderId).trim().slice(0, 128) : null,
            message ? String(message).trim().slice(0, 255) : null,
            key
        ]
    );
}

function normalizeOrbitcardUsageFilters(filters = {}) {
    const keyword = String(filters.keyword || '').trim().slice(0, 80);
    const planType = String(filters.planType || filters.plan_type || '').trim();
    const cardStatus = String(filters.cardStatus || filters.card_status || '').trim().toLowerCase();
    const rechargeStatus = String(filters.rechargeStatus || filters.recharge_status || '').trim().toLowerCase();
    return {
        keyword,
        planType: READABLE_PLAN_TYPES.includes(planType) ? planType : '',
        cardStatus: ORBITCARD_USAGE_CARD_STATUSES.has(cardStatus) ? cardStatus : '',
        rechargeStatus: ORBITCARD_USAGE_RECHARGE_STATUSES.has(rechargeStatus) ? rechargeStatus : ''
    };
}

function buildOrbitcardUsageFilter(filters = {}) {
    const normalized = normalizeOrbitcardUsageFilters(filters);
    const conditions = [];
    const params = [];

    if (normalized.keyword) {
        const keywordPattern = `%${normalized.keyword}%`;
        conditions.push(`(
            CAST(cu.card_id AS CHAR) LIKE ?
            OR COALESCE(cu.card_last4, '') LIKE ?
            OR RIGHT(COALESCE(cu.card_number, ''), 4) LIKE ?
            OR COALESCE(cu.product_code, '') LIKE ?
            OR EXISTS (
                SELECT 1
                FROM orbitcard_card_recharges keyword_recharge
                WHERE keyword_recharge.card_id = cu.card_id
                  AND (keyword_recharge.account_email LIKE ? OR keyword_recharge.order_id LIKE ? OR keyword_recharge.card_last4 LIKE ?)
            )
        )`);
        params.push(keywordPattern, keywordPattern, keywordPattern, keywordPattern, keywordPattern, keywordPattern, keywordPattern);
    }

    if (normalized.planType) {
        conditions.push('cu.plan_type = ?');
        params.push(normalized.planType);
    }

    const cardStatusConditions = {
        active: "cu.status NOT IN ('PROVIDER_DELETED', 'CANCELLED')",
        reusable: "cu.status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND cu.in_use = 0 AND cu.plan_type IS NOT NULL AND cu.usage_count < cu.max_usage_count",
        in_use: "cu.status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND cu.in_use = 1",
        retired: "cu.status = 'RETIRED'",
        provider_deleted: "cu.status = 'PROVIDER_DELETED'",
        cancelled: "cu.status = 'CANCELLED'",
        unassigned: "cu.status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND cu.plan_type IS NULL"
    };
    if (normalized.cardStatus) {
        conditions.push(cardStatusConditions[normalized.cardStatus]);
    }

    const rechargeStatusConditions = {
        success: "LOWER(recharge_filter.status) IN ('success', 'succeeded')",
        processing: "LOWER(recharge_filter.status) IN ('processing', 'running', 'pending')",
        failed: "LOWER(recharge_filter.status) IN ('failed', 'error')"
    };
    if (normalized.rechargeStatus) {
        conditions.push(`EXISTS (
            SELECT 1
            FROM orbitcard_card_recharges recharge_filter
            WHERE recharge_filter.card_id = cu.card_id
              AND ${rechargeStatusConditions[normalized.rechargeStatus]}
        )`);
    }

    return {
        normalized,
        whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

async function countOrbitcardUsage(filters = {}) {
    const { whereSql, params } = buildOrbitcardUsageFilter(filters);
    const rows = await runQuery(
        `SELECT COUNT(*) AS total FROM orbitcard_card_usage cu ${whereSql}`,
        params
    );
    return Number(rows[0]?.total || 0);
}

async function getOrbitcardUsageSummary() {
    const rows = await runQuery(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status NOT IN ('PROVIDER_DELETED', 'CANCELLED') THEN 1 ELSE 0 END) AS active_count,
            SUM(CASE WHEN status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND in_use = 0 AND plan_type IS NOT NULL AND usage_count < max_usage_count THEN 1 ELSE 0 END) AS reusable_count,
            SUM(CASE WHEN status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND in_use = 0 AND plan_type IS NOT NULL AND usage_count < max_usage_count THEN GREATEST(0, max_usage_count - usage_count) ELSE 0 END) AS remaining_slots,
            SUM(CASE WHEN status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND in_use = 1 THEN 1 ELSE 0 END) AS in_use_count,
            SUM(CASE WHEN status NOT IN ('PROVIDER_DELETED', 'RETIRED', 'CANCELLED') AND plan_type IS NULL THEN 1 ELSE 0 END) AS unassigned_count,
            SUM(CASE WHEN status = 'RETIRED' THEN 1 ELSE 0 END) AS retired_count,
            SUM(CASE WHEN status = 'PROVIDER_DELETED' THEN 1 ELSE 0 END) AS provider_deleted_count
         FROM orbitcard_card_usage`
    );
    const row = rows[0] || {};
    return {
        total: Number(row.total || 0),
        active: Number(row.active_count || 0),
        reusable: Number(row.reusable_count || 0),
        remainingSlots: Number(row.remaining_slots || 0),
        inUse: Number(row.in_use_count || 0),
        unassigned: Number(row.unassigned_count || 0),
        retired: Number(row.retired_count || 0),
        providerDeleted: Number(row.provider_deleted_count || 0)
    };
}

async function listOrbitcardUsage(limit = 200, offset = 0, filters = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const { whereSql, params: filterParams } = buildOrbitcardUsageFilter(filters);
    const cards = await runQuery(
        `SELECT cu.card_id, cu.usage_count, cu.plan_type, cu.max_usage_count, cu.initial_amount,
                cu.provider_balance, cu.provider_balance_currency, cu.provider_status, cu.provider_balance_updated_at,
                cu.card_number, cu.card_expiry, cu.card_cvc, cu.card_holder, cu.product_code, cu.card_last4,
                cu.daily_usage_count, cu.cooldown_until, cu.in_use, cu.locked_at, cu.locked_by,
                cu.last_used_at, cu.status, cu.created_at, cu.updated_at
         FROM orbitcard_card_usage cu
         ${whereSql}
         ORDER BY
             CASE
                 WHEN cu.status = 'ACTIVE' AND cu.in_use = 1 THEN 1
                 WHEN cu.status = 'ACTIVE' AND cu.plan_type IS NOT NULL AND cu.usage_count < cu.max_usage_count THEN 2
                 WHEN cu.status = 'ACTIVE' AND cu.plan_type IS NULL THEN 3
                 WHEN cu.status = 'RETIRED' THEN 4
                 WHEN cu.status = 'CANCELLED' THEN 5
                 WHEN cu.status = 'PROVIDER_DELETED' THEN 6
                 ELSE 7
             END ASC,
             cu.updated_at DESC,
             cu.card_id DESC
         LIMIT ? OFFSET ?`,
        [...filterParams, safeLimit, safeOffset]
    );
    const cardIds = cards.map((row) => Number(row.card_id)).filter((id) => Number.isInteger(id) && id > 0);
    if (!cardIds.length) return [];
    const cardPlaceholders = cardIds.map(() => '?').join(', ');
    const recharges = await runQuery(
        `SELECT card_id, job_key, plan_type, card_last4, account_email, use_number, max_usage_count,
                initial_amount, order_id, status, message, created_at, updated_at
         FROM orbitcard_card_recharges
         WHERE card_id IN (${cardPlaceholders})
         ORDER BY created_at DESC
         LIMIT ?`,
        [...cardIds, Math.min(5000, Math.max(100, safeLimit * 20))]
    );
    const historyByCard = new Map();
    for (const row of recharges) {
        const key = String(row.card_id);
        if (!historyByCard.has(key)) historyByCard.set(key, []);
        historyByCard.get(key).push({
            jobKey: row.job_key,
            planType: row.plan_type || 'plus',
            cardLast4: row.card_last4 || '',
            accountEmail: row.account_email || '',
            useNumber: Number(row.use_number || 0),
            maxUsageCount: Number(row.max_usage_count || 1),
            initialAmount: row.initial_amount == null ? null : Number(row.initial_amount),
            orderId: row.order_id || null,
            status: row.status || 'running',
            message: row.message || '',
            createdAt: row.created_at,
            updatedAt: row.updated_at
        });
    }
    return cards.map((row) => ({
        cardId: Number(row.card_id),
        cardLast4: historyByCard.get(String(row.card_id))?.find((item) => item.cardLast4)?.cardLast4
            || row.card_last4
            || String(row.card_number || '').slice(-4),
        cardNumber: row.card_number || '',
        cardExpiry: row.card_expiry || '',
        cardCvc: row.card_cvc || '',
        cardHolder: row.card_holder || '',
        productCode: row.product_code || '',
        planType: row.plan_type || null,
        usageCount: Number(row.usage_count || 0),
        maxUsageCount: Math.max(1, Number(row.max_usage_count || 1)),
        initialAmount: row.initial_amount == null ? null : Number(row.initial_amount),
        balance: row.provider_balance == null ? null : Number(row.provider_balance),
        balanceCurrency: row.provider_balance_currency || '',
        providerStatus: row.provider_status || '',
        balanceUpdatedAt: row.provider_balance_updated_at || null,
        dailyUsageCount: Number(row.daily_usage_count || 0),
        cooldownUntil: row.cooldown_until || null,
        inUse: Boolean(row.in_use),
        lockedAt: row.locked_at || null,
        lockedBy: row.locked_by || null,
        lastUsedAt: row.last_used_at || null,
        status: row.status || 'ACTIVE',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        recharges: historyByCard.get(String(row.card_id)) || []
    }));
}

async function getOrbitcardCardMetaByIds(cardIds = []) {
    const ids = [...new Set((Array.isArray(cardIds) ? cardIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await runQuery(
        `SELECT card_id, status, plan_type, usage_count, max_usage_count, initial_amount, provider_balance,
                card_number, card_expiry, card_cvc
         FROM orbitcard_card_usage
         WHERE card_id IN (${placeholders})`,
        ids
    );
    return rows.map((row) => ({
        cardId: Number(row.card_id),
        status: String(row.status || 'ACTIVE').trim().toUpperCase(),
        planType: row.plan_type || null,
        usageCount: Number(row.usage_count || 0),
        maxUsageCount: Math.max(1, Number(row.max_usage_count || 1)),
        initialAmount: row.initial_amount == null ? null : Number(row.initial_amount),
        balance: row.provider_balance == null ? null : Number(row.provider_balance),
        hasCardDetail: Boolean(
            String(row.card_number || '').trim()
            && String(row.card_expiry || '').trim()
            && String(row.card_cvc || '').trim()
        )
    }));
}

async function syncOrbitcardCards(cards = []) {
    const normalizedCards = (Array.isArray(cards) ? cards : [])
        .map((card) => {
            const rawAutoPlan = String(card?.autoPlanType || '').trim();
            let autoPlanType = null;
            if (rawAutoPlan) {
                try {
                    autoPlanType = requireCanonicalPlanType(rawAutoPlan, 'plan_type');
                } catch (_) {
                    autoPlanType = null;
                }
            }
            const rawAutoMax = Number(card?.autoMaxUsageCount);
            const autoMaxUsageCount = Number.isInteger(rawAutoMax) && rawAutoMax >= 1 && rawAutoMax <= 20
                ? rawAutoMax
                : null;
            const rawAutoInitial = card?.autoInitialAmount == null || card.autoInitialAmount === ''
                ? null
                : Number(card.autoInitialAmount);
            return {
                cardId: Number(card?.cardId ?? card?.card_id ?? card?.id),
                status: String(card?.status || 'ACTIVE').trim().toUpperCase() || 'ACTIVE',
                last4: String(card?.last4 || card?.cardLast4 || card?.card_last4 || '').replace(/\D/g, '').slice(-4),
                cardNumber: String(card?.cardNumber || card?.card_number || '').replace(/[\s-]+/g, '').trim(),
                cardExpiry: String(card?.cardExpiry || card?.card_expiry || '').trim(),
                cardCvc: String(card?.cardCvc || card?.card_cvc || '').trim(),
                cardHolder: String(card?.cardHolder || card?.card_holder || '').trim(),
                productCode: String(card?.productCode || card?.product_code || '').trim(),
                balance: card?.balance == null || card.balance === '' ? null : Number(card.balance),
                currency: String(card?.currency || '').trim().toUpperCase().slice(0, 8),
                autoPlanType,
                autoMaxUsageCount,
                autoInitialAmount: rawAutoInitial != null && Number.isFinite(rawAutoInitial) && rawAutoInitial > 0
                    ? rawAutoInitial
                    : null
            };
        })
        .filter((card) => Number.isInteger(card.cardId) && card.cardId > 0)
        .map((card) => ({
            ...card,
            last4: card.last4 || card.cardNumber.slice(-4),
            balance: card.balance != null && Number.isFinite(card.balance) ? card.balance : null
        }));

    if (!normalizedCards.length) {
        return { total: 0, inserted: 0, updated: 0, autoAssigned: 0, autoAssignedCards: [] };
    }

    return withTransaction(async (connection) => {
        const ids = normalizedCards.map((card) => card.cardId);
        const placeholders = ids.map(() => '?').join(', ');
        const [existingRows] = await connection.query(
            `SELECT card_id, status, plan_type, usage_count, max_usage_count, initial_amount
             FROM orbitcard_card_usage
             WHERE card_id IN (${placeholders})
             FOR UPDATE`,
            ids
        );
        const existingMap = new Map(existingRows.map((row) => [Number(row.card_id), row]));
        const autoAssignedCards = [];

        for (const card of normalizedCards) {
            const existing = existingMap.get(card.cardId) || null;
            const existingStatus = String(existing?.status || '').trim().toUpperCase();
            const existingPlanType = existing?.plan_type || null;
            const existingUsageCount = Number(existing?.usage_count || 0);
            const canAutoAssign = Boolean(
                !existingPlanType
                && existingStatus !== 'RETIRED'
                && card.status === 'ACTIVE'
                && card.autoPlanType
                && card.autoMaxUsageCount
            );
            const nextPlanType = canAutoAssign ? card.autoPlanType : existingPlanType;
            const nextMaxUsageCount = canAutoAssign
                ? Math.min(20, Math.max(1, existingUsageCount + card.autoMaxUsageCount))
                : (existing ? Math.max(1, Number(existing.max_usage_count || 1)) : 1);
            const nextInitialAmount = existing?.initial_amount != null
                ? Number(existing.initial_amount)
                : (canAutoAssign ? (card.autoInitialAmount ?? card.balance) : null);

            if (canAutoAssign) {
                autoAssignedCards.push({
                    cardId: card.cardId,
                    last4: card.last4 || '',
                    planType: nextPlanType,
                    maxUsageCount: nextMaxUsageCount,
                    balance: card.balance
                });
            }

            await connection.query(
                `INSERT INTO orbitcard_card_usage
                    (card_id, status, plan_type, max_usage_count, initial_amount,
                    provider_status, provider_balance, provider_balance_currency,
                    provider_balance_updated_at, card_number, card_expiry, card_cvc, card_holder, product_code, card_last4)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    status = CASE WHEN orbitcard_card_usage.status = 'RETIRED' THEN orbitcard_card_usage.status ELSE VALUES(status) END,
                    max_usage_count = CASE
                        WHEN orbitcard_card_usage.plan_type IS NULL AND VALUES(plan_type) IS NOT NULL THEN VALUES(max_usage_count)
                        ELSE orbitcard_card_usage.max_usage_count
                    END,
                    initial_amount = COALESCE(orbitcard_card_usage.initial_amount, VALUES(initial_amount)),
                    plan_type = COALESCE(orbitcard_card_usage.plan_type, VALUES(plan_type)),
                    provider_status = VALUES(provider_status),
                    provider_balance = COALESCE(VALUES(provider_balance), orbitcard_card_usage.provider_balance),
                    provider_balance_currency = COALESCE(VALUES(provider_balance_currency), orbitcard_card_usage.provider_balance_currency),
                    provider_balance_updated_at = CASE WHEN VALUES(provider_balance) IS NULL THEN orbitcard_card_usage.provider_balance_updated_at ELSE CURRENT_TIMESTAMP END,
                    card_number = COALESCE(NULLIF(VALUES(card_number), ''), orbitcard_card_usage.card_number),
                    card_expiry = COALESCE(NULLIF(VALUES(card_expiry), ''), orbitcard_card_usage.card_expiry),
                    card_cvc = COALESCE(NULLIF(VALUES(card_cvc), ''), orbitcard_card_usage.card_cvc),
                    card_holder = COALESCE(NULLIF(VALUES(card_holder), ''), orbitcard_card_usage.card_holder),
                    product_code = COALESCE(NULLIF(VALUES(product_code), ''), orbitcard_card_usage.product_code),
                    card_last4 = COALESCE(NULLIF(VALUES(card_last4), ''), orbitcard_card_usage.card_last4)`,
                [
                    card.cardId,
                    card.status,
                    nextPlanType,
                    nextMaxUsageCount,
                    nextInitialAmount,
                    card.status,
                    card.balance,
                    card.currency || null,
                    card.balance,
                    card.cardNumber || null,
                    card.cardExpiry || null,
                    card.cardCvc || null,
                    card.cardHolder || null,
                    card.productCode || null,
                    card.last4 || null
                ]
            );
        }

        return {
            total: normalizedCards.length,
            inserted: normalizedCards.filter((card) => !existingMap.has(card.cardId)).length,
            updated: normalizedCards.filter((card) => existingMap.has(card.cardId)).length,
            autoAssigned: autoAssignedCards.length,
            autoAssignedCards
        };
    });
}

async function updateOrbitcardCardBalance(cardId, { balance = null, currency = '', providerStatus = '' } = {}) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const numericBalance = balance == null || balance === '' ? null : Number(balance);
    if (numericBalance != null && !Number.isFinite(numericBalance)) return false;
    const result = await runExecute(
        `UPDATE orbitcard_card_usage
         SET provider_balance = ?,
             provider_balance_currency = ?,
             provider_status = ?,
             provider_balance_updated_at = CURRENT_TIMESTAMP
         WHERE card_id = ?`,
        [
            numericBalance,
            String(currency || '').trim().toUpperCase().slice(0, 8) || null,
            String(providerStatus || '').trim().toUpperCase().slice(0, 32) || null,
            id
        ]
    );
    return Number(result.affectedRows || 0) > 0;
}

async function markMissingOrbitcardCards(remoteCardIds = []) {
    const ids = [...new Set((Array.isArray(remoteCardIds) ? remoteCardIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0))];
    const params = [...ids];
    const where = ids.length ? `card_id NOT IN (${ids.map(() => '?').join(', ')})` : '1 = 1';
    const result = await runExecute(
        `UPDATE orbitcard_card_usage
         SET status = 'PROVIDER_DELETED', in_use = 0, locked_at = NULL, locked_by = NULL,
             cooldown_until = NULL, provider_status = 'DELETED'
         WHERE ${where} AND status <> 'PROVIDER_DELETED'`,
        params
    );
    return Number(result.affectedRows || 0);
}

async function recordOrbitcardCardUsage(cardId) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0) return { dailyUsageCount: 0, cooledDown: false };
    return withTransaction(async (connection) => {
        const [rows] = await connection.query(
            `SELECT daily_usage_count, daily_usage_reset_at, usage_count, max_usage_count
             FROM orbitcard_card_usage WHERE card_id = ? FOR UPDATE`,
            [id]
        );
        if (!rows.length) return { dailyUsageCount: 0, cooledDown: false };
        const row = rows[0];
        const resetAt = row.daily_usage_reset_at ? new Date(row.daily_usage_reset_at) : null;
        const expired = !resetAt || resetAt < new Date(Date.now() - 24 * 60 * 60 * 1000);
        const dailyUsageCount = expired ? 1 : Number(row.daily_usage_count || 0) + 1;
        const usageCount = Number(row.usage_count || 0) + 1;
        const maxUsageCount = Math.max(1, Number(row.max_usage_count || 1));
        const cooldownThreshold = Math.max(3, maxUsageCount);
        await connection.query(
            `UPDATE orbitcard_card_usage
             SET daily_usage_count = ?,
                 daily_usage_reset_at = CASE WHEN ? = 1 THEN NOW() ELSE daily_usage_reset_at END,
                 usage_count = ?,
                 last_used_at = NOW(),
                 cooldown_until = CASE WHEN ? >= ? THEN DATE_ADD(NOW(), INTERVAL 24 HOUR) ELSE cooldown_until END
             WHERE card_id = ?`,
            [dailyUsageCount, expired ? 1 : 0, usageCount, dailyUsageCount, cooldownThreshold, id]
        );
        return { dailyUsageCount, usageCount, maxUsageCount, cooledDown: dailyUsageCount >= cooldownThreshold };
    });
}

module.exports = {
    reserveOrbitcardCard,
    releaseOrbitcardCard,
    retireOrbitcardCard,
    restoreOrbitcardCard,
    assignOrbitcardCardPlan,
    createOrbitcardRecharge,
    updateOrbitcardRecharge,
    countOrbitcardUsage,
    getOrbitcardUsageSummary,
    listOrbitcardUsage,
    getOrbitcardCardMetaByIds,
    syncOrbitcardCards,
    updateOrbitcardCardBalance,
    markMissingOrbitcardCards,
    recordOrbitcardCardUsage
};
