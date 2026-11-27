'use strict';

const {
    requireCanonicalPlanType,
    requireReadablePlanType
} = require('../config/plan-registry');
const { getPool, runQuery, runExecute } = require('./pool');

function normalizeCdks(cdks) {
    return [...new Set((cdks || []).filter(Boolean).map((item) => String(item).trim()))];
}

async function listCdks() {
    const rows = await runQuery(
        `SELECT c.cdk_code, c.shipped_at, c.used_at, c.type, c.plan_type, c.created_at,
                (
                    SELECT l.token_preview
                    FROM task_logs l
                    WHERE l.cdk_code = c.cdk_code
                      AND l.token_preview IS NOT NULL
                      AND l.token_preview != ''
                    ORDER BY l.created_at DESC, l.id DESC
                    LIMIT 1
                ) AS session_preview,
                (
                    SELECT l.job_key
                    FROM task_logs l
                    WHERE l.cdk_code = c.cdk_code
                      AND l.token_preview IS NOT NULL
                      AND l.token_preview != ''
                    ORDER BY l.created_at DESC, l.id DESC
                    LIMIT 1
                ) AS session_job_key
         FROM cdk_codes c
         WHERE c.is_active = 1
           AND (c.type = '自助' OR c.type IS NULL OR c.type = '')
         ORDER BY c.created_at DESC, c.id DESC`
    );

    const runningRows = await runQuery(
        `SELECT cdk_code, MAX(updated_at) AS updated_at
         FROM task_logs
         WHERE status = 'running'
           AND cdk_code IS NOT NULL
         GROUP BY cdk_code`
    );
    const runningSet = new Set(runningRows.map((row) => String(row.cdk_code || '').trim()).filter(Boolean));

    return rows.map((row) => ({
        code: row.cdk_code,
        status: runningSet.has(String(row.cdk_code || '').trim())
            ? 'processing'
            : (row.used_at ? 'used' : 'unused'),
        type: row.type || '自助',
        plan_type: row.plan_type || 'plus',
        shipped: Boolean(row.shipped_at),
        shipped_at: row.shipped_at
            ? new Date(row.shipped_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        used_at: row.used_at
            ? new Date(row.used_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        session_preview: row.session_preview || null,
        session_job_key: row.session_job_key || null
    }));
}

async function markCdkShipped(cdk) {
    const result = await runExecute(
        `UPDATE cdk_codes
         SET shipped_at = COALESCE(shipped_at, CURRENT_TIMESTAMP)
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
    return result.affectedRows > 0;
}

async function insertCdks(cdks, options = {}) {
    const normalized = normalizeCdks(cdks);
    if (normalized.length === 0) {
        return { insertedCount: 0, duplicateCount: 0, totalCount: 0 };
    }

    const type = options.type || '自助';
    const planType = requireCanonicalPlanType(options.plan_type, 'plan_type');
    const values = normalized.map((cdk) => [cdk, 1, type, planType]);

    const [result] = await getPool().query(
        'INSERT IGNORE INTO cdk_codes (cdk_code, is_active, type, plan_type) VALUES ?',
        [values]
    );

    const insertedCount = Number(result?.affectedRows || 0);
    return {
        insertedCount,
        duplicateCount: Math.max(0, normalized.length - insertedCount),
        totalCount: normalized.length
    };
}

async function deleteCdk(cdk) {
    await runExecute('DELETE FROM cdk_codes WHERE cdk_code = ?', [String(cdk)]);
}

async function verifyCdk(cdk) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM cdk_codes
         WHERE cdk_code = ?
           AND is_active = 1
           AND used_at IS NULL`,
        [String(cdk)]
    );
    return Number(rows[0]?.count || 0) > 0;
}

async function verifyCdkDetails(cdk) {
    const rows = await runQuery(
        `SELECT * FROM cdk_codes
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function recordCdkFailure(cdk) {
    await runExecute(
        `UPDATE cdk_codes
         SET fail_count = fail_count + 1
         WHERE cdk_code = ?`,
        [String(cdk)]
    );

    const cdkDetails = await verifyCdkDetails(cdk);
    if (cdkDetails && cdkDetails.fail_count >= 3) {
        await runExecute(
            `UPDATE cdk_codes
             SET cooldown_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE),
                 fail_count = 0
             WHERE cdk_code = ?`,
            [String(cdk)]
        );
        return true;
    }
    return false;
}

async function resetCdkFailure(cdk) {
    await runExecute(
        `UPDATE cdk_codes
         SET fail_count = 0, cooldown_until = NULL
         WHERE cdk_code = ?`,
        [String(cdk)]
    );
}

async function markCdkUsed(cdk) {
    const result = await runExecute(
        `UPDATE cdk_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE cdk_code = ?
           AND is_active = 1
           AND used_at IS NULL`,
        [String(cdk)]
    );
    return result.affectedRows > 0;
}

async function markCdkUnused(cdk) {
    await runExecute(
        `UPDATE cdk_codes
         SET used_at = NULL
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
}

async function getActivationAttemptLimit(scopeType, scopeKey) {
    const rows = await runQuery(
        `SELECT scope_type, scope_key, fail_count, cooldown_until
         FROM activation_attempt_limits
         WHERE scope_type = ?
           AND scope_key = ?
         LIMIT 1`,
        [String(scopeType), String(scopeKey)]
    );
    return rows[0] || null;
}

async function recordActivationAttemptFailure(scopeType, scopeKey) {
    await runExecute(
        `INSERT INTO activation_attempt_limits (scope_type, scope_key, fail_count, cooldown_until)
         VALUES (?, ?, 1, NULL)
         ON DUPLICATE KEY UPDATE fail_count = fail_count + 1`,
        [String(scopeType), String(scopeKey)]
    );

    const limit = await getActivationAttemptLimit(scopeType, scopeKey);
    if (limit && Number(limit.fail_count || 0) >= 3) {
        await runExecute(
            `UPDATE activation_attempt_limits
             SET cooldown_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE),
                 fail_count = 0
             WHERE scope_type = ?
               AND scope_key = ?`,
            [String(scopeType), String(scopeKey)]
        );
        return true;
    }
    return false;
}

async function resetActivationAttemptFailure(scopeType, scopeKey) {
    await runExecute(
        `DELETE FROM activation_attempt_limits
         WHERE scope_type = ?
           AND scope_key = ?`,
        [String(scopeType), String(scopeKey)]
    );
}

async function getActivationManualHold(cdkCode) {
    const code = String(cdkCode || '').trim();
    if (!code) return null;
    const rows = await runQuery(
        `SELECT id, account_key, account_email, plan_type, failed_job_key, cdk_code,
                reason, created_at, updated_at
         FROM activation_manual_holds
         WHERE cdk_code = ?
           AND resolved_at IS NULL
         ORDER BY id DESC
         LIMIT 1`,
        [code]
    );
    return rows[0] || null;
}

async function createActivationManualHold({ accountKey, accountEmail, planType, failedJobKey, cdkCode, reason }) {
    const code = String(cdkCode || '').trim();
    if (!code) {
        return null;
    }
    const type = requireReadablePlanType(planType || 'plus', 'plan_type');
    const existing = await getActivationManualHold(code);
    if (existing) {
        return existing;
    }
    await runExecute(
        `INSERT INTO activation_manual_holds
            (account_key, account_email, plan_type, failed_job_key, cdk_code, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            String(accountKey || '').trim(),
            String(accountEmail || '').trim(),
            type,
            String(failedJobKey || '').trim() || null,
            code,
            String(reason || '').trim().slice(0, 512)
        ]
    );
    return getActivationManualHold(code);
}

async function listActivationManualHolds(limit = 200) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return runQuery(
        `SELECT id, account_key, account_email, plan_type, failed_job_key, cdk_code,
                reason, created_at, updated_at
         FROM activation_manual_holds
         WHERE resolved_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [safeLimit]
    );
}

async function resolveActivationManualHold(id, resolvedBy = '') {
    const rows = await runQuery(
        `SELECT cdk_code
         FROM activation_manual_holds
         WHERE id = ?
           AND resolved_at IS NULL
         LIMIT 1`,
        [Number(id)]
    );
    const cdkCode = String(rows[0]?.cdk_code || '').trim();
    const result = await runExecute(
        `UPDATE activation_manual_holds
         SET resolved_at = CURRENT_TIMESTAMP,
             resolved_by = ?
         WHERE id = ?
           AND resolved_at IS NULL`,
        [String(resolvedBy || '').trim().slice(0, 128) || 'admin', Number(id)]
    );
    if (Number(result.affectedRows || 0) === 0) return false;
    if (cdkCode) {
        await resetCdkFailure(cdkCode);
        await markCdkUnused(cdkCode);
    }
    return true;
}

module.exports = {
    listCdks,
    markCdkShipped,
    insertCdks,
    deleteCdk,
    verifyCdk,
    verifyCdkDetails,
    recordCdkFailure,
    resetCdkFailure,
    markCdkUsed,
    markCdkUnused,
    getActivationAttemptLimit,
    recordActivationAttemptFailure,
    resetActivationAttemptFailure,
    getActivationManualHold,
    createActivationManualHold,
    listActivationManualHolds,
    resolveActivationManualHold
};
