'use strict';

const crypto = require('crypto');

function decodeJwtPart(part) {
    const normalized = String(part || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        return null;
    }
    try {
        return decodeJwtPart(parts[1]);
    } catch (_) {
        return null;
    }
}

function extractProfileFromToken(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
        return { email: '', accountId: '', userId: '' };
    }
    const authInfo = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
        email: profile.email || '',
        accountId: authInfo.chatgpt_account_id || '',
        userId: authInfo.chatgpt_user_id || ''
    };
}

function parseSessionJson(raw) {
    const content = String(raw || '').trim().replace(/^\uFEFF/, '');
    if (!content || !content.startsWith('{')) {
        return null;
    }
    try {
        const data = JSON.parse(content);
        if (data?.accessToken || data?.access_token || data?.user) {
            return data;
        }
    } catch (_) {
        return null;
    }
    return null;
}

function buildSessionPayload(accessToken, sessionJson = null) {
    const token = String(accessToken || '').trim();
    const profile = extractProfileFromToken(token);
    const base = sessionJson && typeof sessionJson === 'object' ? { ...sessionJson } : {};
    const user = base.user || (profile.email || profile.userId ? {
        id: profile.userId || `user-${profile.accountId || 'session'}`,
        email: profile.email || undefined,
        name: profile.email || undefined
    } : null);

    const expires = base.expires
        || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    return {
        ...base,
        user,
        expires,
        accessToken: base.accessToken || base.access_token || token,
        authProvider: base.authProvider || 'google-oauth2'
    };
}

function extractAccessTokenFromRaw(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return '';
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        return String(sessionJson.accessToken || sessionJson.access_token || '').trim();
    }

    const jwtMatch = content.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwtMatch) {
        return jwtMatch[0];
    }

    return content;
}

function resolveSessionInput(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return null;
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        const accessToken = extractAccessTokenFromRaw(content);
        if (!accessToken) {
            return null;
        }
        return {
            accessToken,
            sessionJson,
            sessionData: buildSessionPayload(accessToken, sessionJson),
            rawJson: JSON.stringify(sessionJson)
        };
    }

    const accessToken = extractAccessTokenFromRaw(content);
    if (!accessToken) {
        return null;
    }

    const sessionData = buildSessionPayload(accessToken, null);
    return {
        accessToken,
        sessionJson: null,
        sessionData,
        rawJson: JSON.stringify(sessionData)
    };
}

function normalizeSessionToken(raw) {
    return extractAccessTokenFromRaw(String(raw || '').trim());
}

function buildStoredSessionPayload(rawSession, sessionJson, token) {
    if (sessionJson && typeof sessionJson === 'object') {
        const payload = { ...sessionJson };
        if (!payload.accessToken && !payload.access_token && token) {
            payload.accessToken = token;
        }
        return JSON.stringify(payload);
    }
    const content = String(rawSession || '').trim();
    if (content && content.startsWith('{')) {
        return content;
    }
    return JSON.stringify(buildSessionPayload(token, null));
}

function validateAccessToken(token) {
    const value = String(token || '').trim();
    if (!value) {
        return { valid: false, message: '缺少 AccessToken' };
    }

    const parts = value.split('.');
    if (parts.length !== 3 || parts.some((item) => !item)) {
        return { valid: false, message: '该 Token 不合法：格式错误' };
    }

    let header;
    let payload;
    try {
        header = decodeJwtPart(parts[0]);
        payload = decodeJwtPart(parts[1]);
    } catch (_) {
        return { valid: false, message: '该 Token 不合法：无法解析' };
    }

    if (header.typ !== 'JWT') {
        return { valid: false, message: '该 Token 不合法：类型错误' };
    }
    if (header.alg !== 'RS256') {
        return { valid: false, message: '该 Token 不合法：算法错误' };
    }
    if (payload.iss !== 'https://auth.openai.com') {
        return { valid: false, message: '该 Token 不合法：签发方错误' };
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
    if (!audiences.includes('https://api.openai.com/v1')) {
        return { valid: false, message: '该 Token 不合法：aud 不匹配' };
    }

    const authInfo = payload['https://api.openai.com/auth'];
    if (!authInfo || !authInfo.chatgpt_account_id || !authInfo.chatgpt_user_id) {
        return { valid: false, message: '该 Token 不合法：缺少账户信息' };
    }

    const scopes = Array.isArray(payload.scp) ? payload.scp : [];
    if (!scopes.includes('model.request')) {
        return { valid: false, message: '该 Token 不合法：缺少 model.request 权限' };
    }

    const exp = Number(payload.exp || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!exp || !Number.isFinite(exp)) {
        return { valid: false, message: '该 Token 不合法：缺少过期时间' };
    }
    if (exp <= now) {
        return { valid: false, message: '该 Token 已过期' };
    }

    return {
        valid: true,
        message: 'AccessToken 校验通过',
        email: payload['https://api.openai.com/profile']?.email || ''
    };
}

function extractSessionPreview(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return String(raw || '').slice(0, 32);
    }
    const email = resolved.sessionData?.user?.email;
    if (email) {
        return email;
    }
    return `${resolved.accessToken.slice(0, 12)}...`;
}

function extractEmailFromSession(raw) {
    if (raw && typeof raw === 'object') {
        return String(
            raw.user?.email
            || raw.profile?.email
            || extractProfileFromToken(raw.accessToken || raw.access_token).email
            || ''
        ).trim();
    }
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return '';
    }
    return String(
        resolved.sessionData?.user?.email
        || resolved.sessionJson?.user?.email
        || extractProfileFromToken(resolved.accessToken).email
        || ''
    ).trim();
}

function extractAccountIdFromSession(raw) {
    if (raw && typeof raw === 'object') {
        return String(
            raw.account?.id
            || raw.account?.account_id
            || raw.account_id
            || raw.user?.account_id
            || raw.user?.id
            || extractProfileFromToken(raw.accessToken || raw.access_token).accountId
            || ''
        ).trim();
    }
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return '';
    }
    return String(
        resolved.sessionData?.account?.id
        || resolved.sessionData?.account?.account_id
        || resolved.sessionJson?.account?.id
        || resolved.sessionJson?.account?.account_id
        || extractProfileFromToken(resolved.accessToken).accountId
        || ''
    ).trim();
}

function getActivationAccountKey(sessionOrRaw, token = '') {
    const accountId = extractAccountIdFromSession(sessionOrRaw);
    if (accountId) {
        return `acct:${accountId.toLowerCase()}`;
    }
    const email = extractEmailFromSession(sessionOrRaw);
    if (email) {
        return `email:${email.toLowerCase()}`;
    }
    const digest = crypto.createHash('sha256')
        .update(String(token || sessionOrRaw || ''))
        .digest('hex')
        .slice(0, 32);
    return `token:${digest}`;
}

module.exports = {
    decodeJwtPart,
    decodeJwtPayload,
    extractProfileFromToken,
    parseSessionJson,
    buildSessionPayload,
    extractAccessTokenFromRaw,
    resolveSessionInput,
    normalizeSessionToken,
    buildStoredSessionPayload,
    validateAccessToken,
    extractSessionPreview,
    extractEmailFromSession,
    extractAccountIdFromSession,
    getActivationAccountKey
};
