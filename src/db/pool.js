'use strict';

const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { config } = require('../config/env');

const JOB_KEY_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

let pool = null;

function randomJobKeySuffix(length) {
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += JOB_KEY_CHARSET[crypto.randomInt(JOB_KEY_CHARSET.length)];
    }
    return out;
}

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: config.db.host,
            port: config.db.port,
            user: config.db.user,
            password: config.db.password,
            database: config.db.name,
            charset: 'utf8mb4',
            waitForConnections: true,
            connectionLimit: config.db.poolLimit,
            queueLimit: 0,
            namedPlaceholders: false,
            multipleStatements: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000
        });
    }
    return pool;
}

async function closePool() {
    if (pool) {
        const current = pool;
        pool = null;
        await current.end();
    }
}

async function runQuery(sql, params = [], options = {}) {
    const executor = options.connection || getPool();
    try {
        const [rows] = await executor.query(sql, params);
        return rows;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function runExecute(sql, params = [], options = {}) {
    const executor = options.connection || getPool();
    try {
        const [result] = await executor.execute(sql, params);
        return result;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function withTransaction(callback) {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function hasColumn(tableName, columnName) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [config.db.name, tableName, columnName]
    );
    return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(tableName, columnName, columnDefinition) {
    if (await hasColumn(tableName, columnName)) {
        return;
    }
    await runQuery(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
}

function parseTaskTimestamp(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null;
    }
    const raw = String(value || '').trim();
    if (!raw) return null;
    const legacy = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (legacy) {
        return new Date(Date.UTC(
            Number(legacy[1]),
            Number(legacy[2]) - 1,
            Number(legacy[3]),
            Number(legacy[4]),
            Number(legacy[5]),
            Number(legacy[6] || 0)
        ));
    }
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatTaskDisplayTime(value, fallback = '') {
    const date = parseTaskTimestamp(value) || parseTaskTimestamp(fallback);
    if (!date) return String(fallback || '');
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

async function ensureActiveSchema() {
    if (fs.existsSync(config.schemaPath)) {
        const schemaSql = fs.readFileSync(config.schemaPath, 'utf8');
        await runQuery(schemaSql);
    }

    await ensureColumn('app_config', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('app_config', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('card_assets', 'card_expiry', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'card_cvc', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'card_holder', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('card_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('card_assets', 'in_use', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'locked_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'locked_by', 'VARCHAR(64) NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'last_used_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'daily_usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'daily_usage_reset_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'cooldown_until', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'payment_holder_name', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'payment_address_line1', "VARCHAR(200) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'payment_address_city', "VARCHAR(100) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'payment_address_state', "VARCHAR(100) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'payment_address_postal', "VARCHAR(20) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'payment_address_id', 'BIGINT UNSIGNED NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('card_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('cdk_codes', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('cdk_codes', 'shipped_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('cdk_codes', 'used_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('cdk_codes', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('cdk_codes', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await ensureColumn('cdk_codes', 'type', "VARCHAR(16) NOT NULL DEFAULT '自助'");
    await ensureColumn('cdk_codes', 'plan_type', "VARCHAR(16) NOT NULL DEFAULT 'plus'");

    await ensureColumn('task_logs', 'token_preview', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('task_logs', 'phone', 'VARCHAR(32) NULL');
    await ensureColumn('task_logs', 'cdk_code', 'VARCHAR(32) NULL');
    await ensureColumn('task_logs', 'card_last4', 'VARCHAR(4) NULL');
    await ensureColumn('task_logs', 'status', "VARCHAR(32) NOT NULL DEFAULT 'running'");
    await ensureColumn('task_logs', 'message', 'VARCHAR(255) NULL');
    await ensureColumn('task_logs', 'progress', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('task_logs', 'display_time', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('task_logs', 'raw_output', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'failure_screenshots', 'TEXT NULL');
    await ensureColumn('task_logs', 'session_payload', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'gpt_api_order_id', 'VARCHAR(128) NULL DEFAULT NULL');
    await ensureColumn('task_logs', 'gpt_api_task_id', 'VARCHAR(128) NULL DEFAULT NULL');
    await ensureColumn('task_logs', 'gpt_api_raw', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'gpt_api_topup_code', 'VARCHAR(255) NULL DEFAULT NULL');
    await ensureColumn('task_logs', 'gpt_api_captcha', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('task_logs', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('proxy_assets', 'proxy_url', 'TEXT NOT NULL');
    await ensureColumn('proxy_assets', 'proxy_url_hash', "CHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'label', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'protocol', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'host', "VARCHAR(255) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('proxy_assets', 'last_check_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('proxy_assets', 'last_check_ok', 'TINYINT(1) NULL DEFAULT NULL');
    await ensureColumn('proxy_assets', 'last_check_ip', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'last_check_latency_ms', 'INT NULL DEFAULT NULL');
    await ensureColumn('proxy_assets', 'last_check_error', "VARCHAR(512) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('proxy_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('proxy_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('proxy_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await runQuery(`
        CREATE TABLE IF NOT EXISTS orbitcard_card_usage (
            card_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            usage_count INT NOT NULL DEFAULT 0,
            plan_type VARCHAR(32) NULL DEFAULT NULL,
            max_usage_count INT NOT NULL DEFAULT 1,
            initial_amount DECIMAL(12,2) NULL DEFAULT NULL,
            daily_usage_count INT NOT NULL DEFAULT 0,
            daily_usage_reset_at TIMESTAMP NULL DEFAULT NULL,
            cooldown_until TIMESTAMP NULL DEFAULT NULL,
            in_use TINYINT(1) NOT NULL DEFAULT 0,
            locked_at TIMESTAMP NULL DEFAULT NULL,
            locked_by VARCHAR(64) NULL DEFAULT NULL,
            last_used_at TIMESTAMP NULL DEFAULT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_orbitcard_usage_pick (status, in_use, cooldown_until, usage_count, last_used_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn('orbitcard_card_usage', 'plan_type', 'VARCHAR(32) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'max_usage_count', 'INT NOT NULL DEFAULT 1');
    await ensureColumn('orbitcard_card_usage', 'initial_amount', 'DECIMAL(12,2) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'provider_balance', 'DECIMAL(12,2) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'provider_balance_currency', 'VARCHAR(8) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'provider_status', 'VARCHAR(32) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'provider_balance_updated_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'card_number', 'VARCHAR(32) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'card_expiry', 'VARCHAR(16) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'card_cvc', 'VARCHAR(16) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'card_holder', 'VARCHAR(255) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'product_code', 'VARCHAR(128) NULL DEFAULT NULL');
    await ensureColumn('orbitcard_card_usage', 'card_last4', 'VARCHAR(4) NULL DEFAULT NULL');

    await runQuery(`
        CREATE TABLE IF NOT EXISTS orbitcard_card_recharges (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            card_id BIGINT UNSIGNED NOT NULL,
            job_key VARCHAR(128) NOT NULL,
            plan_type VARCHAR(32) NOT NULL DEFAULT 'plus',
            card_last4 VARCHAR(4) NOT NULL DEFAULT '',
            account_email VARCHAR(255) NOT NULL DEFAULT '',
            use_number INT NOT NULL DEFAULT 1,
            max_usage_count INT NOT NULL DEFAULT 1,
            initial_amount DECIMAL(12,2) NULL DEFAULT NULL,
            order_id VARCHAR(128) NULL DEFAULT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'running',
            message VARCHAR(255) NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_orbitcard_recharge_job (job_key),
            KEY idx_orbitcard_recharge_card (card_id, created_at),
            KEY idx_orbitcard_recharge_status (status, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn('orbitcard_card_recharges', 'card_last4', "VARCHAR(4) NOT NULL DEFAULT ''");

    await runQuery(`
        CREATE TABLE IF NOT EXISTS activation_manual_holds (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            account_key VARCHAR(255) NOT NULL,
            account_email VARCHAR(255) NOT NULL DEFAULT '',
            plan_type VARCHAR(16) NOT NULL DEFAULT 'plus',
            failed_job_key VARCHAR(64) NULL DEFAULT NULL,
            cdk_code VARCHAR(32) NULL DEFAULT NULL,
            reason VARCHAR(512) NOT NULL DEFAULT '',
            resolved_at TIMESTAMP NULL DEFAULT NULL,
            resolved_by VARCHAR(128) NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_activation_manual_hold_lookup (account_key, plan_type, resolved_at),
            KEY idx_activation_manual_hold_status (resolved_at, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    try {
        await runQuery(`
            ALTER TABLE activation_manual_holds
            ADD KEY idx_activation_manual_hold_cdk (cdk_code, resolved_at)
        `);
    } catch (error) {
        if (!/duplicate key name|duplicate key/i.test(String(error.message || ''))) {
            throw error;
        }
    }

    await runQuery(`
        CREATE TABLE IF NOT EXISTS ip_bans (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            cidr VARCHAR(64) NOT NULL,
            reason VARCHAR(255) NOT NULL DEFAULT '',
            source VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT 'manual/auto',
            hits BIGINT UNSIGNED NOT NULL DEFAULT 0,
            last_hit_at TIMESTAMP NULL DEFAULT NULL,
            expires_at TIMESTAMP NULL DEFAULT NULL COMMENT 'NULL = 永久',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_ip_bans_cidr (cidr),
            KEY idx_ip_bans_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

const connectionInfo = {
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user
};

module.exports = {
    getPool,
    closePool,
    runQuery,
    runExecute,
    withTransaction,
    hasColumn,
    ensureColumn,
    parseTaskTimestamp,
    formatTaskDisplayTime,
    randomJobKeySuffix,
    ensureActiveSchema,
    connectionInfo
};
