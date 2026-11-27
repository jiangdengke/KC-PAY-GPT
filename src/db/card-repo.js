'use strict';

const { config } = require('../config/env');
const { validateCard } = require('../utils/card-validator');
const { runQuery, runExecute, withTransaction } = require('./pool');

async function hasAvailableCard() {
    const rows = await runQuery(
        `SELECT id
         FROM card_assets
         WHERE is_active = 1
           AND in_use = 0
           AND status = '正常'
           AND (cooldown_until IS NULL OR cooldown_until < NOW())
         LIMIT 1`
    );
    return rows.length > 0;
}

async function listCardAssets() {
    const rows = await runQuery(
        `SELECT id, card_number, card_expiry, card_cvc, card_holder,
                payment_holder_name, payment_address_line1, payment_address_city,
                payment_address_state, payment_address_postal, payment_address_id,
                is_active, usage_count, last_used_at, status, cooldown_until
         FROM card_assets
         ORDER BY sort_order ASC, id ASC`
    );
    return rows.map((row) => ({
        id: row.id,
        card_number: row.card_number || '',
        card_expiry: row.card_expiry || '',
        card_cvc: row.card_cvc || '',
        last4: String(row.card_number || '').slice(-4),
        card_holder: row.card_holder || '',
        payment_holder_name: row.payment_holder_name || '',
        payment_address_line1: row.payment_address_line1 || '',
        payment_address_city: row.payment_address_city || '',
        payment_address_state: row.payment_address_state || '',
        payment_address_postal: row.payment_address_postal || '',
        payment_address_id: row.payment_address_id || null,
        is_active: Number(row.is_active || 0),
        usage_count: Number(row.usage_count || 0),
        last_used_at: row.last_used_at || null,
        status: row.status || '正常',
        cooldown_until: row.cooldown_until || null
    }));
}

async function deleteCardAssetById(cardId) {
    const result = await runExecute('DELETE FROM card_assets WHERE id = ?', [Number(cardId)]);
    return Number(result.affectedRows || 0) > 0;
}

async function deleteCardAsset(cardNumber) {
    if (!cardNumber) return;
    await runExecute(
        "UPDATE card_assets SET is_active = 0, status = '已报废' WHERE card_number = ?",
        [String(cardNumber)]
    );
}

async function reserveCard(ownerKey) {
    return withTransaction(async (connection) => {
        const [rows] = await connection.query(
            `SELECT id, card_number, card_expiry, card_cvc, card_holder, usage_count
             FROM card_assets
             WHERE is_active = 1
               AND in_use = 0
               AND status = '正常'
               AND (cooldown_until IS NULL OR cooldown_until < NOW())
             ORDER BY usage_count ASC, COALESCE(last_used_at, '1970-01-01') ASC, id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`
        );
        if (!rows.length) {
            return null;
        }
        const row = rows[0];
        await connection.query(
            `UPDATE card_assets
             SET in_use = 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
             WHERE id = ?`,
            [String(ownerKey || '').slice(0, 64) || null, row.id]
        );
        return {
            id: row.id,
            card_number: row.card_number,
            card_expiry: row.card_expiry,
            card_cvc: row.card_cvc,
            card_holder: row.card_holder,
            usage_count: Number(row.usage_count || 0)
        };
    });
}

async function releaseCard(cardId) {
    if (!cardId) return;
    await runExecute(
        'UPDATE card_assets SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE id = ?',
        [Number(cardId)]
    );
}

async function markCardExhausted(cardId) {
    if (!cardId) return;
    await runExecute(
        `UPDATE card_assets
         SET is_active = 0, status = '已报废', in_use = 0, locked_at = NULL, locked_by = NULL
         WHERE id = ?`,
        [Number(cardId)]
    );
}

async function recordCardUsage(cardId) {
    if (!cardId) {
        return { dailyUsageCount: 0, cooledDown: false };
    }

    return withTransaction(async (connection) => {
        const [rows] = await connection.query(
            'SELECT daily_usage_count, daily_usage_reset_at FROM card_assets WHERE id = ? FOR UPDATE',
            [Number(cardId)]
        );
        if (!rows.length) {
            return { dailyUsageCount: 0, cooledDown: false };
        }

        const row = rows[0];
        const resetAt = row.daily_usage_reset_at ? new Date(row.daily_usage_reset_at) : null;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        let newDailyCount;

        if (!resetAt || resetAt < twentyFourHoursAgo) {
            newDailyCount = 1;
            await connection.query(
                `UPDATE card_assets
                 SET daily_usage_count = 1, daily_usage_reset_at = NOW(),
                     usage_count = usage_count + 1, last_used_at = NOW()
                 WHERE id = ?`,
                [Number(cardId)]
            );
        } else {
            newDailyCount = Number(row.daily_usage_count || 0) + 1;
            await connection.query(
                `UPDATE card_assets
                 SET daily_usage_count = daily_usage_count + 1,
                     usage_count = usage_count + 1, last_used_at = NOW()
                 WHERE id = ?`,
                [Number(cardId)]
            );
        }

        let cooledDown = false;
        if (newDailyCount >= 3) {
            await connection.query(
                'UPDATE card_assets SET cooldown_until = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?',
                [Number(cardId)]
            );
            cooledDown = true;
        }

        return { dailyUsageCount: newDailyCount, cooledDown };
    });
}

async function importCards(cards) {
    if (!Array.isArray(cards)) {
        throw new Error('cards 参数必须为数组');
    }
    if (cards.length > 500) {
        throw new Error('单次导入上限 500 条');
    }

    const failures = [];
    const validCards = [];

    for (let i = 0; i < cards.length; i += 1) {
        const source = cards[i] || {};
        const rawExpiry = String(source.card_expiry || '').trim();
        const card = {
            ...source,
            card_number: String(source.card_number || '').replace(/[\s-]+/g, ''),
            card_expiry: /^\d{4}$/.test(rawExpiry) ? `${rawExpiry.slice(0, 2)}/${rawExpiry.slice(2)}` : rawExpiry,
            card_cvc: String(source.card_cvc || '').trim()
        };
        const result = validateCard(card);
        if (!result.valid) {
            failures.push({ index: i, errors: result.errors });
        } else {
            validCards.push({
                index: i,
                card_number: card.card_number,
                card_expiry: card.card_expiry,
                card_cvc: card.card_cvc,
                card_holder: String(card.card_holder || '').trim()
            });
        }
    }

    if (validCards.length === 0) {
        return { imported: 0, skipped: 0, failed: failures.length, failures };
    }

    const cardNumbers = validCards.map((c) => c.card_number);
    const placeholders = cardNumbers.map(() => '?').join(', ');
    const existingRows = await runQuery(
        `SELECT card_number FROM card_assets WHERE card_number IN (${placeholders})`,
        cardNumbers
    );
    const existingSet = new Set(existingRows.map((r) => r.card_number));

    let imported = 0;
    let skipped = 0;
    const seenInBatch = new Set();

    for (const card of validCards) {
        if (existingSet.has(card.card_number) || seenInBatch.has(card.card_number)) {
            skipped += 1;
            continue;
        }
        seenInBatch.add(card.card_number);
        try {
            await runExecute(
                `INSERT INTO card_assets (card_number, card_expiry, card_cvc, card_holder, sort_order, is_active, status)
                 VALUES (?, ?, ?, ?, 0, 1, '正常')`,
                [card.card_number, card.card_expiry, card.card_cvc, card.card_holder]
            );
            imported += 1;
        } catch (err) {
            if (err.message && err.message.includes('Duplicate')) {
                skipped += 1;
            } else {
                failures.push({ index: card.index, errors: [err.message || '插入失败'] });
            }
        }
    }

    return { imported, skipped, failed: failures.length, failures };
}

async function releaseStaleAssetLocks() {
    const staleThreshold = new Date(Date.now() - config.db.assetLockStaleMs);
    const [cardResult, orbitcardResult] = await Promise.all([
        runExecute(
            `UPDATE card_assets
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE in_use = 1 AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        ),
        runExecute(
            `UPDATE orbitcard_card_usage
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE in_use = 1 AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        )
    ]);
    return {
        cardReleased: Number(cardResult?.affectedRows || 0),
        orbitcardReleased: Number(orbitcardResult?.affectedRows || 0)
    };
}

async function resetAllAssetLocks() {
    await Promise.all([
        runExecute('UPDATE card_assets SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE in_use = 1'),
        runExecute('UPDATE orbitcard_card_usage SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE in_use = 1')
    ]);
}

module.exports = {
    hasAvailableCard,
    listCardAssets,
    deleteCardAssetById,
    deleteCardAsset,
    reserveCard,
    releaseCard,
    markCardExhausted,
    recordCardUsage,
    importCards,
    releaseStaleAssetLocks,
    resetAllAssetLocks
};
