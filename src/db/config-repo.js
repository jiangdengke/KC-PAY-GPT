'use strict';

const crypto = require('crypto');
const { config } = require('../config/env');
const {
    CANONICAL_PLAN_TYPES,
    getDefaultReuseLimit,
    getDefaultSafetyMargin
} = require('../config/plan-registry');
const { createPasswordHash, createPasswordHashAsync } = require('../security/admin-auth');
const { normalizeAdminPaths } = require('../security/admin-paths');
const { runQuery, runExecute, withTransaction } = require('./pool');

const GPT_API_CONFIG_KEYS = [
    'gpt_api_enabled',
    'gpt_api_base_url',
    'gpt_api_key',
    'gpt_api_plan_key',
    ...CANONICAL_PLAN_TYPES.map((planType) => `gpt_api_plan_key_${planType}`),
    'gpt_api_country',
    'gpt_api_currency',
    'gpt_api_payment_region',
    'gpt_api_card_source',
    'orbitcard_auto_create_card',
    'orbitcard_plus_unit_price',
    'orbitcard_product_code',
    'orbitcard_next_product_code',
    'orbitcard_base_url',
    'orbitcard_api_key',
    'orbitcard_api_secret',
    ...CANONICAL_PLAN_TYPES.flatMap((planType) => ([
        `orbitcard_reuse_limit_${planType}`,
        `orbitcard_safety_margin_${planType}`
    ]))
];

const DEFAULT_ORBITCARD_REUSE_LIMITS = Object.freeze(Object.fromEntries(
    CANONICAL_PLAN_TYPES.map((planType) => [planType, getDefaultReuseLimit(planType)])
));
const DEFAULT_ORBITCARD_SAFETY_MARGINS = Object.freeze(Object.fromEntries(
    CANONICAL_PLAN_TYPES.map((planType) => [planType, getDefaultSafetyMargin(planType)])
));

function parseOrbitcardReuseLimit(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : fallback;
}

function parseOrbitcardSafetyMargin(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

function parseOrbitcardPlusUnitPrice(value, fallback = 20) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 500 ? Number(parsed.toFixed(2)) : fallback;
}

function normalizeCardPool(cardPool) {
    return (cardPool || [])
        .filter((item) => item && item.number)
        .map((item, index) => [
            String(item.number),
            String(item.expiry || ''),
            String(item.cvc || ''),
            index,
            item.is_active === 0 || item.status === 'invalid' ? 0 : 1
        ]);
}

async function ensureDefaultConfigs() {
    const defaults = [
        ['admin_password_hash', createPasswordHash(config.admin.defaultPassword)],
        ['admin_password_version', '1'],
        ['admin_email', config.admin.defaultEmail],
        ['admin_secondary_password_hash', createPasswordHash(config.admin.defaultSecondaryPassword)],
        ['admin_secondary_password_version', '1'],
        ['admin_totp_secret', ''],
        ['admin_totp_enabled', '0'],
        ['telegram_on_admin_login', '1'],
        ['admin_2fa_login_mode', 'either'],
        ['admin_login_path', config.admin.defaultLoginPath],
        ['admin_panel_path', config.admin.defaultPanelPath],
        ['max_concurrent_activations', '1'],
        ['maintenance_mode', '0'],
        ['maintenance_mode_drain', '0'],
        ['external_card_api_key', crypto.randomUUID()],
        ['telegram_bot_token', ''],
        ['telegram_admin_chat_id', ''],
        ['telegram_group_chat_id', ''],
        ['telegram_notify_admin', '0'],
        ['telegram_notify_group', '0'],
        ['telegram_on_success', '0'],
        ['telegram_on_failure', '0'],
        ['telegram_on_card_pool_empty', '0'],
        ['gpt_api_enabled', '1'],
        ['gpt_api_base_url', config.defaults.gptApiBaseUrl],
        ['gpt_api_key', ''],
        ['gpt_api_plan_key', config.defaults.gptApiPlanKey],
        ...CANONICAL_PLAN_TYPES.map((planType) => [
            `gpt_api_plan_key_${planType}`,
            planType === 'plus' ? config.defaults.gptApiPlanKey : ''
        ]),
        ['gpt_api_country', 'PH'],
        ['gpt_api_currency', 'PHP'],
        ['gpt_api_payment_region', ''],
        ['gpt_api_card_source', 'orbitcard'],
        ['orbitcard_auto_create_card', '0'],
        ['orbitcard_plus_unit_price', '20'],
        ['orbitcard_product_code', ''],
        ['orbitcard_next_product_code', ''],
        ['orbitcard_base_url', config.defaults.orbitcardBaseUrl],
        ['orbitcard_api_key', ''],
        ['orbitcard_api_secret', ''],
        ...CANONICAL_PLAN_TYPES.flatMap((planType) => ([
            [`orbitcard_reuse_limit_${planType}`, String(DEFAULT_ORBITCARD_REUSE_LIMITS[planType])],
            [`orbitcard_safety_margin_${planType}`, String(DEFAULT_ORBITCARD_SAFETY_MARGINS[planType])]
        ]))
    ];

    const placeholders = defaults.map(() => '(?, ?)').join(', ');
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE config_value = app_config.config_value`,
        defaults.flat()
    );
}

async function getAppConfigValue(configKey, fallbackValue = '') {
    const rows = await runQuery(
        `SELECT config_value
         FROM app_config
         WHERE config_key = ?
         LIMIT 1`,
        [String(configKey)]
    );
    return rows[0]?.config_value ?? fallbackValue;
}

async function setAppConfigValue(configKey, configValue) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [String(configKey), String(configValue ?? '')]
    );
}

async function getGptApiConfig() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (${GPT_API_CONFIG_KEYS.map(() => '?').join(', ')})`,
        GPT_API_CONFIG_KEYS
    );
    const map = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    const legacyPlusPlanKey = String(map.gpt_api_plan_key || config.defaults.gptApiPlanKey).trim()
        || config.defaults.gptApiPlanKey;
    const planMappings = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
        planType,
        String(map[`gpt_api_plan_key_${planType}`] || (planType === 'plus' ? legacyPlusPlanKey : '')).trim()
    ]));
    const reuseLimits = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
        planType,
        parseOrbitcardReuseLimit(
            map[`orbitcard_reuse_limit_${planType}`],
            DEFAULT_ORBITCARD_REUSE_LIMITS[planType]
        )
    ]));
    const safetyMargins = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
        planType,
        parseOrbitcardSafetyMargin(
            map[`orbitcard_safety_margin_${planType}`],
            DEFAULT_ORBITCARD_SAFETY_MARGINS[planType]
        )
    ]));

    return {
        enabled: String(map.gpt_api_enabled ?? '1') === '1',
        base_url: String(map.gpt_api_base_url || config.defaults.gptApiBaseUrl).trim() || config.defaults.gptApiBaseUrl,
        api_key: String(map.gpt_api_key || '').trim(),
        plan_key: planMappings.plus,
        plan_mappings: planMappings,
        country: String(map.gpt_api_country || 'PH').trim().toUpperCase() || 'PH',
        currency: String(map.gpt_api_currency || 'PHP').trim().toUpperCase() || 'PHP',
        payment_region: String(map.gpt_api_payment_region || '').trim().toUpperCase(),
        card_source: String(map.gpt_api_card_source || 'local').trim().toLowerCase() === 'orbitcard' ? 'orbitcard' : 'local',
        orbitcard_auto_create_card: String(map.orbitcard_auto_create_card ?? '0') === '1',
        orbitcard_plus_unit_price: parseOrbitcardPlusUnitPrice(map.orbitcard_plus_unit_price, 20),
        orbitcard_product_code: String(map.orbitcard_product_code || map.orbitcard_next_product_code || '').trim(),
        orbitcard_base_url: String(map.orbitcard_base_url || config.defaults.orbitcardBaseUrl).trim().replace(/\/+$/, '') || config.defaults.orbitcardBaseUrl,
        orbitcard_api_key: String(map.orbitcard_api_key || '').trim(),
        orbitcard_api_secret: String(map.orbitcard_api_secret || config.defaults.orbitcardApiSecret || '').trim(),
        orbitcard_reuse_limits: reuseLimits,
        orbitcard_safety_margins: safetyMargins
    };
}

async function saveGptApiConfig(input = {}) {
    const existing = await getGptApiConfig();
    const apiKey = String(input.api_key || '').trim() || existing.api_key || '';
    const productCode = Object.prototype.hasOwnProperty.call(input, 'orbitcard_product_code')
        ? String(input.orbitcard_product_code || '').trim()
        : existing.orbitcard_product_code;
    const autoCreateCard = Object.prototype.hasOwnProperty.call(input, 'orbitcard_auto_create_card')
        ? Boolean(input.orbitcard_auto_create_card)
        : Boolean(existing.orbitcard_auto_create_card);
    const plusUnitPrice = Object.prototype.hasOwnProperty.call(input, 'orbitcard_plus_unit_price')
        ? parseOrbitcardPlusUnitPrice(input.orbitcard_plus_unit_price, existing.orbitcard_plus_unit_price ?? 20)
        : (existing.orbitcard_plus_unit_price ?? 20);
    const orbitcardApiSecret = String(input.orbitcard_api_secret || '').trim() || existing.orbitcard_api_secret || '';
    const requestedMappings = input.plan_mappings && typeof input.plan_mappings === 'object' ? input.plan_mappings : {};
    const planMappings = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
        planType,
        String(requestedMappings[planType] ?? (planType === 'plus' ? input.plan_key : undefined)
            ?? existing.plan_mappings?.[planType] ?? '').trim()
    ]));
    if (!planMappings.plus) planMappings.plus = config.defaults.gptApiPlanKey;
    const requestedReuseLimits = input.orbitcard_reuse_limits && typeof input.orbitcard_reuse_limits === 'object'
        ? input.orbitcard_reuse_limits
        : {};
    const requestedSafetyMargins = input.orbitcard_safety_margins && typeof input.orbitcard_safety_margins === 'object'
        ? input.orbitcard_safety_margins
        : {};

    const entries = [
        ['gpt_api_enabled', input.enabled === false ? '0' : '1'],
        ['gpt_api_base_url', String(input.base_url || existing.base_url || config.defaults.gptApiBaseUrl).trim().replace(/\/+$/, '') || config.defaults.gptApiBaseUrl],
        ['gpt_api_key', apiKey],
        ['gpt_api_plan_key', planMappings.plus],
        ...CANONICAL_PLAN_TYPES.map((planType) => [`gpt_api_plan_key_${planType}`, planMappings[planType]]),
        ['gpt_api_country', String(input.country || existing.country || 'PH').trim().toUpperCase() || 'PH'],
        ['gpt_api_currency', String(input.currency || existing.currency || 'PHP').trim().toUpperCase() || 'PHP'],
        ['gpt_api_payment_region', String(input.payment_region ?? existing.payment_region ?? '').trim().toUpperCase()],
        ['gpt_api_card_source', String(input.card_source || existing.card_source || 'local').trim().toLowerCase() === 'orbitcard' ? 'orbitcard' : 'local'],
        ['orbitcard_auto_create_card', autoCreateCard ? '1' : '0'],
        ['orbitcard_plus_unit_price', String(plusUnitPrice)],
        ['orbitcard_product_code', productCode],
        ['orbitcard_next_product_code', ''],
        ['orbitcard_base_url', String(input.orbitcard_base_url || existing.orbitcard_base_url || config.defaults.orbitcardBaseUrl).trim().replace(/\/+$/, '') || config.defaults.orbitcardBaseUrl],
        ['orbitcard_api_key', String(input.orbitcard_api_key || existing.orbitcard_api_key || '').trim()],
        ['orbitcard_api_secret', orbitcardApiSecret],
        ...CANONICAL_PLAN_TYPES.flatMap((planType) => ([
            [`orbitcard_reuse_limit_${planType}`, String(parseOrbitcardReuseLimit(
                requestedReuseLimits[planType],
                existing.orbitcard_reuse_limits?.[planType] ?? DEFAULT_ORBITCARD_REUSE_LIMITS[planType]
            ))],
            [`orbitcard_safety_margin_${planType}`, String(parseOrbitcardSafetyMargin(
                requestedSafetyMargins[planType],
                existing.orbitcard_safety_margins?.[planType] ?? DEFAULT_ORBITCARD_SAFETY_MARGINS[planType]
            ))]
        ]))
    ];
    await runExecute(
        `INSERT INTO app_config (config_key, config_value) VALUES ${entries.map(() => '(?, ?)').join(', ')}
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        entries.flat()
    );
}

async function getTelegramConfig() {
    const keys = [
        'telegram_bot_token',
        'telegram_admin_chat_id',
        'telegram_group_chat_id',
        'telegram_notify_admin',
        'telegram_notify_group',
        'telegram_on_success',
        'telegram_on_failure',
        'telegram_on_card_pool_empty'
    ];
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (${keys.map(() => '?').join(', ')})`,
        keys
    );
    const map = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        bot_token: String(map.telegram_bot_token || '').trim(),
        admin_chat_id: String(map.telegram_admin_chat_id || '').trim(),
        group_chat_id: String(map.telegram_group_chat_id || '').trim(),
        notify_admin: String(map.telegram_notify_admin || '0') === '1',
        notify_group: String(map.telegram_notify_group || '0') === '1',
        on_success: String(map.telegram_on_success || '0') === '1',
        on_failure: String(map.telegram_on_failure || '0') === '1',
        on_card_pool_empty: String(map.telegram_on_card_pool_empty || '0') === '1'
    };
}

async function saveTelegramConfig(input = {}) {
    const existing = await getTelegramConfig();
    const botToken = String(input.bot_token || '').trim() || existing.bot_token || '';
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'telegram_bot_token', botToken,
            'telegram_admin_chat_id', String(input.admin_chat_id || '').trim(),
            'telegram_group_chat_id', String(input.group_chat_id || '').trim(),
            'telegram_notify_admin', input.notify_admin ? '1' : '0',
            'telegram_notify_group', input.notify_group ? '1' : '0',
            'telegram_on_success', input.on_success ? '1' : '0',
            'telegram_on_failure', input.on_failure ? '1' : '0',
            'telegram_on_card_pool_empty', input.on_card_pool_empty ? '1' : '0'
        ]
    );
}

async function saveConfig(input = {}) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(input, key);
    const configEntries = [];

    if (hasOwn('max_concurrent_activations')) {
        configEntries.push([
            'max_concurrent_activations',
            String(Math.max(1, Number(input.max_concurrent_activations || 1)))
        ]);
    }
    if (hasOwn('maintenance_mode')) {
        configEntries.push(['maintenance_mode', input.maintenance_mode ? '1' : '0']);
    }
    if (hasOwn('maintenance_mode_drain')) {
        configEntries.push(['maintenance_mode_drain', input.maintenance_mode_drain ? '1' : '0']);
    }

    const cardPool = hasOwn('card_pool')
        ? normalizeCardPool(Array.isArray(input.card_pool) ? input.card_pool : [])
        : null;

    await withTransaction(async (connection) => {
        if (configEntries.length > 0) {
            const placeholders = configEntries.map(() => '(?, ?)').join(', ');
            await runExecute(
                `INSERT INTO app_config (config_key, config_value)
                 VALUES ${placeholders}
                 ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
                configEntries.flat(),
                { connection }
            );
        }

        if (cardPool !== null) {
            if (cardPool.length > 0) {
                const cardNumbers = cardPool.map((item) => item[0]);
                const cardPlaceholders = cardNumbers.map(() => '?').join(', ');
                await runExecute(
                    `DELETE FROM card_assets WHERE card_number NOT IN (${cardPlaceholders})`,
                    cardNumbers,
                    { connection }
                );
                for (const card of cardPool) {
                    const result = await runExecute(
                        `UPDATE card_assets
                         SET card_expiry = ?, card_cvc = ?, sort_order = ?, is_active = ?
                         WHERE card_number = ?`,
                        [card[1], card[2], card[3], card[4], card[0]],
                        { connection }
                    );
                    if (result.affectedRows === 0) {
                        await runExecute(
                            `INSERT INTO card_assets (card_number, card_expiry, card_cvc, sort_order, is_active)
                             VALUES (?, ?, ?, ?, ?)`,
                            card,
                            { connection }
                        );
                    }
                }
            } else {
                await runExecute('DELETE FROM card_assets', [], { connection });
            }
        }
    });
}

async function getMaxConcurrentActivations() {
    const val = await getAppConfigValue('max_concurrent_activations', '1');
    return Math.max(1, Number(val || 1));
}

async function getMaintenanceModeState() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['maintenance_mode', 'maintenance_mode_drain']
    );
    const configMap = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        enabled: String(configMap.maintenance_mode || '0') === '1',
        drain: String(configMap.maintenance_mode_drain || '0') === '1'
    };
}

async function setMaintenanceModeState(enabled, drain = false) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'maintenance_mode', enabled ? '1' : '0',
            'maintenance_mode_drain', drain ? '1' : '0'
        ]
    );
}

async function getAdminAuthConfig() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'admin_password_hash',
            'admin_password_version',
            'admin_email',
            'admin_secondary_password_hash',
            'admin_secondary_password_version',
            'admin_totp_secret',
            'admin_totp_enabled',
            'telegram_on_admin_login',
            'admin_2fa_login_mode'
        ]
    );

    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));
    return {
        email: String(map.admin_email || config.admin.defaultEmail).trim().toLowerCase(),
        passwordHash: String(map.admin_password_hash || ''),
        passwordVersion: Math.max(1, Number(map.admin_password_version || 1)),
        secondaryPasswordHash: String(map.admin_secondary_password_hash || ''),
        secondaryPasswordVersion: Math.max(1, Number(map.admin_secondary_password_version || 1)),
        totpSecret: String(map.admin_totp_secret || ''),
        totpEnabled: String(map.admin_totp_enabled || '0') === '1',
        notifyAdminLogin: String(map.telegram_on_admin_login || '1') !== '0',
        login2faMode: ['either', 'totp', 'telegram'].includes(String(map.admin_2fa_login_mode || '').trim().toLowerCase())
            ? String(map.admin_2fa_login_mode || 'either').trim().toLowerCase()
            : 'either'
    };
}

async function saveAdmin2faLoginMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['either', 'totp', 'telegram'].includes(normalized)) {
        throw new Error('无效的登录验证方式');
    }
    await setAppConfigValue('admin_2fa_login_mode', normalized);
    return normalized;
}

async function getAdminPaths() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['admin_login_path', 'admin_panel_path']
    );
    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));
    return normalizeAdminPaths({
        loginPath: map.admin_login_path || config.admin.defaultLoginPath,
        panelPath: map.admin_panel_path || config.admin.defaultPanelPath
    });
}

async function saveAdminPaths({ loginPath, panelPath }) {
    const normalized = normalizeAdminPaths({ loginPath, panelPath });
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_login_path', normalized.loginPath,
                'admin_panel_path', normalized.panelPath
            ],
            { connection }
        );
    });
    return normalized;
}

async function updateAdminEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
        throw new Error('管理员邮箱格式无效');
    }
    await setAppConfigValue('admin_email', normalized);
    return normalized;
}

async function updateAdminPassword(password) {
    const nextHash = await createPasswordHashAsync(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.passwordVersion || 1)) + 1;

    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_password_hash', nextHash,
                'admin_password_version', String(nextVersion)
            ],
            { connection }
        );
    });

    return {
        passwordHash: nextHash,
        passwordVersion: nextVersion
    };
}

async function updateAdminSecondaryPassword(password) {
    const nextHash = await createPasswordHashAsync(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.secondaryPasswordVersion || 1)) + 1;
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_secondary_password_hash', nextHash,
                'admin_secondary_password_version', String(nextVersion)
            ],
            { connection }
        );
    });
    return { secondaryPasswordVersion: nextVersion };
}

async function saveAdminTotpConfig({ secret, enabled }) {
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_totp_secret', String(secret || ''),
                'admin_totp_enabled', enabled ? '1' : '0'
            ],
            { connection }
        );
    });
}

module.exports = {
    ensureDefaultConfigs,
    getAppConfigValue,
    setAppConfigValue,
    getGptApiConfig,
    saveGptApiConfig,
    getTelegramConfig,
    saveTelegramConfig,
    saveConfig,
    getMaxConcurrentActivations,
    getMaintenanceModeState,
    setMaintenanceModeState,
    getAdminAuthConfig,
    saveAdmin2faLoginMode,
    getAdminPaths,
    saveAdminPaths,
    updateAdminEmail,
    updateAdminPassword,
    updateAdminSecondaryPassword,
    saveAdminTotpConfig
};
