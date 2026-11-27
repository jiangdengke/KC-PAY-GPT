'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function loadEnvFile(filePath = path.join(ROOT_DIR, '.env')) {
    if (!fs.existsSync(filePath)) {
        return;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const eqIndex = line.indexOf('=');
        if (eqIndex <= 0) {
            continue;
        }
        const key = line.slice(0, eqIndex).trim();
        let value = line.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
            value = value.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnvFile();

const config = {
    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, 'public'),
    adminAssetsDir: path.join(ROOT_DIR, 'public', 'admin-assets'),
    dataDir: path.join(ROOT_DIR, 'data'),
    schemaPath: path.join(ROOT_DIR, 'mysql-schema.sql'),
    port: Number(process.env.PORT || 3100),
    jsonBodyLimit: process.env.JSON_BODY_LIMIT || '15mb',
    db: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        name: process.env.DB_NAME || 'gpt',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        poolLimit: Number(process.env.DB_POOL_LIMIT || 60),
        assetLockStaleMs: Number(process.env.ASSET_LOCK_STALE_MS || 15 * 60 * 1000)
    },
    admin: {
        defaultEmail: String(process.env.ADMIN_EMAIL || 'admin@vru.cc').trim().toLowerCase(),
        defaultPassword: String(process.env.ADMIN_PASSWORD || 'admin123'),
        defaultSecondaryPassword: String(process.env.ADMIN_SECONDARY_PASSWORD || 'admin123'),
        defaultLoginPath: String(process.env.ADMIN_LOGIN_PATH || 'admin-login').trim().toLowerCase(),
        defaultPanelPath: String(process.env.ADMIN_PANEL_PATH || 'admin').trim().toLowerCase()
    },
    defaults: {
        gptApiBaseUrl: 'https://recharge.desolate.run/api/v1/open',
        gptApiPlanKey: 'chatgptplusplan',
        orbitcardBaseUrl: 'https://orbitcard.cc',
        orbitcardApiSecret: String(process.env.ORBITCARD_API_SECRET || '').trim()
    },
    cfAccess: {
        teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN || '',
        aud: process.env.CF_ACCESS_AUD || '',
        certsUrl: process.env.CF_ACCESS_CERTS_URL || ''
    }
};

module.exports = {
    ROOT_DIR,
    loadEnvFile,
    config
};
