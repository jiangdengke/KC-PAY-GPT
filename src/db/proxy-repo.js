'use strict';

const {
    substituteProxySession,
    hashProxyUrl,
    parseProxyMeta,
    normalizeProxyLines,
    maskProxyUrl
} = require('../services/proxy-pool');
const { runQuery, runExecute } = require('./pool');

function formatProxyAssetRow(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        proxy_url: String(row.proxy_url || ''),
        proxy_url_masked: maskProxyUrl(row.proxy_url),
        label: String(row.label || ''),
        protocol: String(row.protocol || ''),
        host: String(row.host || ''),
        is_active: Number(row.is_active) === 1,
        last_check_at: row.last_check_at || null,
        last_check_ok: row.last_check_ok === null || row.last_check_ok === undefined
            ? null
            : Number(row.last_check_ok) === 1,
        last_check_ip: String(row.last_check_ip || ''),
        last_check_latency_ms: row.last_check_latency_ms === null || row.last_check_latency_ms === undefined
            ? null
            : Number(row.last_check_latency_ms),
        last_check_error: String(row.last_check_error || ''),
        usage_count: Number(row.usage_count || 0),
        sort_order: Number(row.sort_order || 0),
        created_at: row.created_at || null,
        updated_at: row.updated_at || null
    };
}

async function listProxyAssets() {
    const rows = await runQuery(
        'SELECT * FROM proxy_assets ORDER BY sort_order ASC, id ASC'
    );
    return rows.map(formatProxyAssetRow);
}

async function addProxyAssets(input) {
    const lines = normalizeProxyLines(input);
    if (!lines.length) {
        return { success: false, error: '未提供代理 URL' };
    }

    let added = 0;
    let skipped = 0;
    const ids = [];

    for (const line of lines) {
        const urlHash = hashProxyUrl(line);
        const existing = await runQuery(
            'SELECT id FROM proxy_assets WHERE proxy_url_hash = ? LIMIT 1',
            [urlHash]
        );
        if (existing.length) {
            skipped += 1;
            continue;
        }
        const meta = parseProxyMeta(line);
        const result = await runExecute(
            `INSERT INTO proxy_assets (proxy_url, proxy_url_hash, protocol, host, is_active, sort_order)
             VALUES (?, ?, ?, ?, 1, ?)`,
            [line, urlHash, meta.protocol || '', meta.host || '', Date.now() % 1000000]
        );
        added += 1;
        ids.push(Number(result.insertId));
    }

    return {
        success: true,
        added,
        skipped,
        ids,
        message: `已保存 ${added} 条代理${skipped ? `，跳过重复 ${skipped} 条` : ''}`
    };
}

async function deleteProxyAsset(id) {
    const result = await runExecute('DELETE FROM proxy_assets WHERE id = ?', [Number(id)]);
    if (!result.affectedRows) {
        return { success: false, error: '代理不存在' };
    }
    return { success: true };
}

async function setProxyAssetActive(id, isActive) {
    const result = await runExecute(
        'UPDATE proxy_assets SET is_active = ? WHERE id = ?',
        [isActive ? 1 : 0, Number(id)]
    );
    if (!result.affectedRows) {
        return { success: false, error: '代理不存在' };
    }
    return { success: true, is_active: Boolean(isActive) };
}

async function updateProxyAssetCheck(id, checkResult) {
    const ok = Boolean(checkResult?.ok);
    await runExecute(
        `UPDATE proxy_assets
         SET last_check_at = CURRENT_TIMESTAMP,
             last_check_ok = ?,
             last_check_ip = ?,
             last_check_latency_ms = ?,
             last_check_error = ?
         WHERE id = ?`,
        [
            ok ? 1 : 0,
            ok ? String(checkResult.ip || '') : '',
            ok ? Number(checkResult.latencyMs || 0) : null,
            ok ? '' : String(checkResult.error || '检测失败').slice(0, 512),
            Number(id)
        ]
    );
}

async function getProxyAssetById(id) {
    const rows = await runQuery('SELECT * FROM proxy_assets WHERE id = ? LIMIT 1', [Number(id)]);
    return formatProxyAssetRow(rows[0]);
}

async function migrateLegacyProxyConfig() {
    const rows = await runQuery(
        'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
        ['proxy']
    );
    const raw = String(rows[0]?.config_value || '').trim();
    if (!raw) {
        return;
    }

    const countRows = await runQuery('SELECT COUNT(*) AS count FROM proxy_assets');
    const existingCount = Number(countRows[0]?.count || 0);
    const lines = normalizeProxyLines(raw);
    if (!lines.length) {
        await runExecute('UPDATE app_config SET config_value = \'\' WHERE config_key = ?', ['proxy']);
        return;
    }

    if (existingCount === 0) {
        await addProxyAssets(lines);
    }
    await runExecute('UPDATE app_config SET config_value = \'\' WHERE config_key = ?', ['proxy']);
}

async function getActiveProxy() {
    const rows = await runQuery(
        `SELECT proxy_url
         FROM proxy_assets
         WHERE is_active = 1
         ORDER BY RAND()
         LIMIT 1`
    );
    if (!rows.length) {
        return '';
    }
    await runExecute(
        'UPDATE proxy_assets SET usage_count = usage_count + 1 WHERE proxy_url = ?',
        [rows[0].proxy_url]
    ).catch(() => { });
    return substituteProxySession(String(rows[0].proxy_url || ''));
}

module.exports = {
    listProxyAssets,
    addProxyAssets,
    deleteProxyAsset,
    setProxyAssetActive,
    updateProxyAssetCheck,
    getProxyAssetById,
    migrateLegacyProxyConfig,
    getActiveProxy
};
