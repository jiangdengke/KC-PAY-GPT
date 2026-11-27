'use strict';

const { runQuery, runExecute } = require('./pool');

async function insertAdminLoginLog({
    event,
    adminEmail = '',
    ip = '',
    userAgent = '',
    fingerprint = '',
    detail = ''
}) {
    await runExecute(
        `INSERT INTO admin_login_logs (event, admin_email, ip, user_agent, fingerprint, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            String(event || 'unknown').slice(0, 32),
            String(adminEmail || '').slice(0, 128) || null,
            String(ip || '').slice(0, 45) || null,
            String(userAgent || '').slice(0, 512) || null,
            String(fingerprint || '').slice(0, 128) || null,
            String(detail || '').slice(0, 512) || null
        ]
    );
}

async function listAdminLoginLogs(limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const [rows, countRows] = await Promise.all([
        runQuery(
            `SELECT id, event, admin_email, ip, user_agent, fingerprint, detail, created_at
             FROM admin_login_logs
             ORDER BY id DESC
             LIMIT ? OFFSET ?`,
            [safeLimit, safeOffset]
        ),
        runQuery('SELECT COUNT(*) AS total FROM admin_login_logs')
    ]);
    return {
        logs: rows,
        total: Number(countRows[0]?.total || 0),
        limit: safeLimit,
        offset: safeOffset
    };
}

async function listIpBans() {
    return runQuery(
        `SELECT id, cidr, reason, source, hits, last_hit_at, expires_at, created_at
         FROM ip_bans
         ORDER BY created_at DESC, id DESC
         LIMIT 300`
    );
}

async function listActiveIpBanRules() {
    return runQuery(
        `SELECT id, cidr, expires_at
         FROM ip_bans
         WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP`
    );
}

async function listRecentLoginFailures(minutes = 30) {
    return runQuery(
        `SELECT ip, event, admin_email, created_at
         FROM admin_login_logs
         WHERE event IN ('login_failed', '2fa_failed')
           AND ip IS NOT NULL AND ip <> ''
           AND created_at >= NOW() - INTERVAL ? MINUTE
         ORDER BY id ASC
         LIMIT 20000`,
        [Math.max(1, Number(minutes) || 30)]
    );
}

async function listLoginFailureCounts(minutes = 1440) {
    return runQuery(
        `SELECT ip, admin_email, COUNT(*) AS attempts, MIN(created_at) AS first_at
         FROM admin_login_logs
         WHERE event = 'login_failed'
           AND ip IS NOT NULL AND ip <> ''
           AND created_at >= NOW() - INTERVAL ? MINUTE
         GROUP BY ip, admin_email
         LIMIT 100000`,
        [Math.max(1, Number(minutes) || 1440)]
    );
}

async function saveIpBan({ cidr, reason = '', source = 'manual', expiresAt = null }) {
    const params = [
        String(cidr),
        String(reason || '').slice(0, 255),
        source === 'auto' ? 'auto' : 'manual',
        expiresAt
    ];
    if (source === 'auto') {
        await runExecute(
            `INSERT INTO ip_bans (cidr, reason, source, expires_at) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                expires_at = IF(expires_at IS NULL, NULL, GREATEST(expires_at, VALUES(expires_at)))`,
            params
        );
        return;
    }
    await runExecute(
        `INSERT INTO ip_bans (cidr, reason, source, expires_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), source = VALUES(source), expires_at = VALUES(expires_at)`,
        params
    );
}

async function deleteIpBan(id) {
    const result = await runExecute('DELETE FROM ip_bans WHERE id = ?', [Number(id)]);
    return Number(result.affectedRows || 0) > 0;
}

async function addIpBanHits(counts = new Map()) {
    for (const [id, count] of counts) {
        await runExecute(
            'UPDATE ip_bans SET hits = hits + ?, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?',
            [Number(count) || 0, Number(id)]
        );
    }
}

async function listRecentAdminLoginIps(days = 30) {
    const rows = await runQuery(
        `SELECT DISTINCT ip
         FROM admin_login_logs
         WHERE event = 'login_success'
           AND ip IS NOT NULL AND ip <> ''
           AND created_at >= NOW() - INTERVAL ? DAY`,
        [Math.max(1, Number(days) || 30)]
    );
    return rows.map((row) => String(row.ip));
}

module.exports = {
    insertAdminLoginLog,
    listAdminLoginLogs,
    listIpBans,
    listActiveIpBanRules,
    listRecentLoginFailures,
    listLoginFailureCounts,
    saveIpBan,
    deleteIpBan,
    addIpBanHits,
    listRecentAdminLoginIps
};
