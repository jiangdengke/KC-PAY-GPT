'use strict';

const {
    runQuery,
    runExecute,
    formatTaskDisplayTime,
    randomJobKeySuffix
} = require('./pool');
const { getTelegramConfig } = require('./config-repo');
const { listActivationManualHolds } = require('./cdk-repo');

function formatAdminTaskLogRow(row) {
    return {
        id: row.job_key,
        jobKey: row.job_key,
        time: formatTaskDisplayTime(row.created_at, row.display_time),
        token: row.token_preview,
        cdk: row.cdk_code || '',
        phone: row.phone,
        message: String(row.message || '').trim(),
        cardLast4: row.card_last4 || '',
        status: row.status,
        progress: Number(row.progress || 0),
        screenshots: [],
        videos: []
    };
}

async function listAdminTaskLogs(limit = 200) {
    const rows = await runQuery(
        `SELECT l.job_key, l.display_time, l.created_at, l.token_preview,
                l.cdk_code, l.phone, l.card_last4,
                l.status, l.message, l.progress, c.type AS cdk_type
         FROM task_logs l
         LEFT JOIN cdk_codes c ON l.cdk_code = c.cdk_code
         WHERE (l.cdk_code IS NULL OR l.cdk_code NOT LIKE 'ADMIN_PRODUCT_GEN:%')
           AND (c.type IS NULL OR c.type = '' OR c.type = '自助')
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ?`,
        [Math.min(500, Math.max(1, Number(limit) || 200))]
    );
    return rows.map(formatAdminTaskLogRow);
}

async function createTaskLog({ tokenPreview, sessionPayload, cdkCode, phone, cardLast4, status, progress = 0 }) {
    const now = new Date();
    const displayTime = formatTaskDisplayTime(now);
    const jobKey = `${now.getTime()}-${randomJobKeySuffix(12)}`;
    const message = String(status) === 'running' ? '正在开通中' : null;

    await runExecute(
        `INSERT INTO task_logs (job_key, token_preview, session_payload, cdk_code, phone, card_last4, status, message, progress, display_time, raw_output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            jobKey,
            String(tokenPreview),
            sessionPayload ? String(sessionPayload) : null,
            cdkCode || null,
            phone || null,
            cardLast4 || null,
            String(status),
            message,
            Number(progress || 0),
            displayTime
        ]
    );

    return { jobKey, displayTime };
}

async function getTaskStatus(jobKey) {
    const rows = await runQuery(
        `SELECT status, message, progress, raw_output, cdk_code, phone, card_last4,
                gpt_api_order_id, gpt_api_task_id, gpt_api_raw, gpt_api_topup_code, gpt_api_captcha
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [String(jobKey)]
    );
    return rows[0] || null;
}

async function getAdminTaskLogDetail(jobKey) {
    const rows = await runQuery(
        `SELECT job_key, display_time, created_at, updated_at, token_preview, cdk_code, phone, card_last4,
                status, message, progress, raw_output,
                gpt_api_order_id, gpt_api_task_id, gpt_api_topup_code, gpt_api_raw, gpt_api_captcha
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [String(jobKey || '').trim()]
    );
    const row = rows[0];
    if (!row) return null;
    return {
        jobKey: row.job_key,
        displayTime: row.display_time,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tokenPreview: row.token_preview || '',
        cdk: row.cdk_code || '',
        phone: row.phone || '',
        cardLast4: row.card_last4 || '',
        status: row.status || '',
        message: row.message || '',
        progress: Number(row.progress || 0),
        rawOutput: row.raw_output || '',
        gptApiOrderId: row.gpt_api_order_id || '',
        gptApiTaskId: row.gpt_api_task_id || '',
        gptApiTopupCode: row.gpt_api_topup_code || '',
        gptApiRaw: row.gpt_api_raw || '',
        gptApiCaptcha: row.gpt_api_captcha || ''
    };
}

async function getRunningTaskByCdk(cdk) {
    const rows = await runQuery(
        `SELECT job_key, status, message, progress, updated_at
         FROM task_logs
         WHERE cdk_code = ?
           AND status = 'running'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function getLatestTaskByCdk(cdk) {
    const rows = await runQuery(
        `SELECT job_key, token_preview, session_payload, status, created_at
         FROM task_logs
         WHERE cdk_code = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function deleteTaskLogByJobKey(jobKey) {
    const key = String(jobKey || '').trim();
    if (!key) {
        return { deleted: 0 };
    }
    const result = await runExecute('DELETE FROM task_logs WHERE job_key = ? LIMIT 1', [key]);
    return { deleted: Number(result.affectedRows || 0) };
}

async function updateTaskLog(jobKey, {
    status,
    message,
    rawOutput,
    cdkCode,
    phone,
    cardLast4,
    progress,
    sessionPayload,
    gptApiOrderId,
    gptApiTaskId,
    gptApiRaw,
    gptApiTopupCode,
    gptApiCaptcha
}) {
    await runExecute(
        `UPDATE task_logs
         SET status = ?,
             message = COALESCE(?, message),
             raw_output = COALESCE(?, raw_output),
             progress = GREATEST(progress, COALESCE(?, progress)),
             cdk_code = COALESCE(?, cdk_code),
             phone = COALESCE(?, phone),
             card_last4 = COALESCE(?, card_last4),
             session_payload = COALESCE(?, session_payload),
             gpt_api_order_id = COALESCE(?, gpt_api_order_id),
             gpt_api_task_id = COALESCE(?, gpt_api_task_id),
             gpt_api_raw = COALESCE(?, gpt_api_raw),
             gpt_api_topup_code = COALESCE(?, gpt_api_topup_code),
             gpt_api_captcha = COALESCE(?, gpt_api_captcha)
         WHERE job_key = ?`,
        [
            String(status),
            message || null,
            rawOutput || null,
            progress == null ? null : Number(progress),
            cdkCode || null,
            phone || null,
            cardLast4 || null,
            sessionPayload || null,
            gptApiOrderId || null,
            gptApiTaskId || null,
            gptApiRaw || null,
            gptApiTopupCode || null,
            gptApiCaptcha || null,
            String(jobKey)
        ]
    );
}

async function listSessions(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 12, 100));
    const offset = Math.max(0, Number(options.offset) || 0);
    const search = String(options.search || '').trim().slice(0, 120);
    const where = [
        'l.token_preview IS NOT NULL',
        "l.token_preview != ''",
        "(l.cdk_code IS NULL OR l.cdk_code NOT LIKE 'ADMIN_PRODUCT_GEN:%')",
        "(c.type IS NULL OR c.type = '' OR c.type = '自助')"
    ];
    const searchParams = [];
    if (search) {
        const keyword = `%${search}%`;
        where.push('(l.job_key LIKE ? OR l.token_preview LIKE ? OR l.cdk_code LIKE ? OR l.card_last4 LIKE ? OR l.message LIKE ?)');
        searchParams.push(keyword, keyword, keyword, keyword, keyword);
    }
    const whereSql = where.join('\n           AND ');
    const [countRows, rows] = await Promise.all([
        runQuery(
            `SELECT COUNT(*) AS total
             FROM task_logs l
             LEFT JOIN cdk_codes c ON l.cdk_code = c.cdk_code
             WHERE ${whereSql}`,
            searchParams
        ),
        runQuery(
            `SELECT l.job_key, l.display_time, l.token_preview, l.session_payload, l.cdk_code, l.phone, l.card_last4,
                    l.status, l.message, l.progress, l.created_at, l.updated_at
             FROM task_logs l
             LEFT JOIN cdk_codes c ON l.cdk_code = c.cdk_code
             WHERE ${whereSql}
             ORDER BY l.created_at DESC, l.id DESC
             LIMIT ? OFFSET ?`,
            [...searchParams, limit, offset]
        )
    ]);

    const items = rows.map((row) => ({
        job_key: row.job_key,
        time: row.display_time,
        token_preview: row.token_preview,
        has_session: Boolean(row.session_payload),
        cdk_code: row.cdk_code || '',
        card_last4: row.card_last4 || '',
        status: row.status,
        message: row.message || '',
        progress: Number(row.progress || 0),
        created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        updated_at: row.updated_at
            ? new Date(row.updated_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null
    }));

    return {
        items,
        total: Number(countRows[0]?.total || 0),
        limit,
        offset,
        search
    };
}

async function getSessionByJobKey(jobKey) {
    const rows = await runQuery(
        `SELECT job_key, display_time, token_preview, session_payload, cdk_code, card_last4, status, message, progress, created_at, updated_at
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [String(jobKey)]
    );
    const row = rows[0];
    if (!row) return null;
    return {
        job_key: row.job_key,
        time: row.display_time,
        token_preview: row.token_preview,
        session_payload: row.session_payload || '',
        cdk_code: row.cdk_code || '',
        card_last4: row.card_last4 || '',
        status: row.status,
        message: row.message || '',
        progress: Number(row.progress || 0),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function listRecentGptApiOrders(limit = 10) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    return runQuery(
        `SELECT job_key, cdk_code, status, message, progress, updated_at,
                gpt_api_order_id, gpt_api_task_id, gpt_api_topup_code, gpt_api_raw
         FROM task_logs
         WHERE (gpt_api_order_id IS NOT NULL OR gpt_api_task_id IS NOT NULL)
           AND status = 'failed'
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [safeLimit]
    );
}

async function cleanupStaleLegacyTasks() {
    const result = await runExecute(
        `UPDATE task_logs
         SET status = 'failed',
             message = '遗留成品任务已自动清理',
             progress = 100,
             updated_at = CURRENT_TIMESTAMP
         WHERE status = 'running'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'`
    );
    if (result?.affectedRows > 0) {
        console.log(`🧹 [任务] 已清理 ${result.affectedRows} 条遗留成品 running 任务`);
    }
}

async function getAdminData() {
    const [configRows, cardRows, logRows, statsRows, cdkStatsRows, orbitcardCountRows, manualHoldRows, telegram] = await Promise.all([
        runQuery(
            `SELECT config_key, config_value
             FROM app_config
             WHERE config_key IN (?, ?, ?)`,
            ['max_concurrent_activations', 'maintenance_mode', 'maintenance_mode_drain']
        ),
        runQuery(
            `SELECT card_number, card_expiry, card_cvc, usage_count, is_active, status
             FROM card_assets
             ORDER BY sort_order ASC, id ASC`
        ),
        listAdminTaskLogs(200),
        runQuery(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(status = 'success'), 0) AS success,
                COALESCE(SUM(status IN ('failed', 'card_invalid', 'manual', 'retry', 'maintenance')), 0) AS failed,
                COALESCE(SUM(status = 'running'), 0) AS running
             FROM task_logs
             WHERE cdk_code IS NULL OR cdk_code NOT LIKE 'ADMIN_PRODUCT_GEN:%'`
        ),
        runQuery(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(used_at IS NOT NULL), 0) AS used_count,
                COALESCE(SUM(used_at IS NULL), 0) AS unused_count
             FROM cdk_codes
             WHERE is_active = 1`
        ),
        runQuery(
            `SELECT COUNT(*) AS active_count
             FROM orbitcard_card_usage
             WHERE status = 'ACTIVE' AND usage_count < max_usage_count`
        ),
        listActivationManualHolds(200),
        getTelegramConfig()
    ]);

    const stats = statsRows[0] || {};
    const cdkStats = cdkStatsRows[0] || {};
    const configMap = Object.fromEntries(configRows.map((row) => [row.config_key, row.config_value]));

    return {
        config: {
            max_concurrent_activations: Math.max(1, Number(configMap.max_concurrent_activations || 1)),
            maintenance_mode: String(configMap.maintenance_mode || '0') === '1',
            maintenance_mode_drain: String(configMap.maintenance_mode_drain || '0') === '1',
            card_pool: cardRows.map((row) => ({
                number: row.card_number,
                expiry: row.card_expiry,
                cvc: row.card_cvc,
                usage_count: Number(row.usage_count || 0),
                is_active: Number(row.is_active || 0),
                status: Number(row.is_active || 0) === 1
                    ? 'normal'
                    : String(row.status || 'invalid').trim() || 'invalid'
            }))
        },
        stats: {
            total: Number(stats.total || 0),
            success: Number(stats.success || 0),
            failed: Number(stats.failed || 0),
            running: Number(stats.running || 0),
            cdk_total: Number(cdkStats.total || 0),
            cdk_used: Number(cdkStats.used_count || 0),
            cdk_unused: Number(cdkStats.unused_count || 0),
            orbitcard_reusable: Number(orbitcardCountRows[0]?.active_count || 0)
        },
        telegram,
        logs: logRows,
        manual_holds: manualHoldRows.map((hold) => ({
            id: Number(hold.id),
            accountEmail: hold.account_email || '',
            planType: hold.plan_type || 'plus',
            failedJobKey: hold.failed_job_key || '',
            cdkCode: hold.cdk_code || '',
            reason: hold.reason || '',
            createdAt: hold.created_at,
            updatedAt: hold.updated_at
        }))
    };
}

module.exports = {
    listAdminTaskLogs,
    createTaskLog,
    getTaskStatus,
    getAdminTaskLogDetail,
    getRunningTaskByCdk,
    getLatestTaskByCdk,
    deleteTaskLogByJobKey,
    updateTaskLog,
    listSessions,
    getSessionByJobKey,
    listRecentGptApiOrders,
    cleanupStaleLegacyTasks,
    getAdminData
};
