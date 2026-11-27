'use strict';

const axios = require('axios');
const adminAuth = require('../security/admin-auth');
const cfAccess = require('../security/cf-access');

function extractBearerToken(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.startsWith('Bearer ')) {
        return '';
    }
    return authHeader.slice(7).trim();
}

function createAdminGuards({ store, ensureStoreReady, security, cfAccessConfig = {} }) {
    const teamDomain = cfAccessConfig.teamDomain ?? process.env.CF_ACCESS_TEAM_DOMAIN;
    const audience = cfAccessConfig.aud ?? process.env.CF_ACCESS_AUD;
    const certsUrl = cfAccessConfig.certsUrl ?? process.env.CF_ACCESS_CERTS_URL;
    const fetchCerts = cfAccessConfig.fetchCerts
        || ((url) => axios.get(url, { timeout: 10000 }).then((response) => response.data));

    const requireCfAccess = cfAccess.createAccessGuard({
        teamDomain,
        audience,
        certsUrl,
        fetchCerts,
        onReject: (reason, req) => {
            const ip = adminAuth.resolveClientIp(req);
            if (security?.alertSecurity) {
                security.alertSecurity('cf-access-reject', '🛡️ 有请求绕过 Cloudflare Access 到达后台接口或资源', [
                    `来源：${ip}`,
                    `路径：${String(req.originalUrl || req.path || '').split('?')[0].slice(0, 100)}`,
                    `原因：${reason}`
                ], { windowMs: 60 * 60 * 1000, max: 1 });
            }
        }
    });

    async function authenticateAdmin(req, res, next) {
        try {
            await ensureStoreReady();
            const token = extractBearerToken(req);
            const payload = adminAuth.verifyAdminToken(token);
            if (!payload) {
                return res.status(401).json({ success: false, message: '未登录或登录已过期，请重新登录' });
            }

            const authConfig = await store.getAdminAuthConfig();
            if (Number(payload.pv || 0) !== Number(authConfig.passwordVersion || 1)) {
                return res.status(401).json({ success: false, message: '密码已变更，请重新登录' });
            }

            req.admin = payload;
            req.adminToken = token;
            req.adminAuthConfig = authConfig;
            return next();
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    const requireSecondaryAuth = adminAuth.createRequireSecondaryAuth(store, ensureStoreReady);

    return {
        requireCfAccess,
        authenticateAdmin,
        requireSecondaryAuth
    };
}

module.exports = {
    extractBearerToken,
    createAdminGuards
};
