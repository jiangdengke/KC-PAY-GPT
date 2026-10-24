'use strict';

const crypto = require('crypto');

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_REFRESH_AFTER_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SECONDARY_TOKEN_TTL_MS = 30 * 60 * 1000;
const TG_CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const TG_CODE_MAX_ATTEMPTS = 5;
// 全站登录失败上限：换 IP 也绕不过去；超过后所有来源暂停登录一个窗口期
const LOGIN_GLOBAL_MAX_ATTEMPTS = 100;
const LOGIN_GLOBAL_KEY = '*';
const MAX_TRACKED_LOGIN_KEYS = 10000;
const CHALLENGE_MAX_ATTEMPTS = 5;

const MIN_ADMIN_TOKEN_SECRET_LENGTH = 32;

const loginAttempts = new Map();
const tgLoginCodes = new Map();
const challengeStates = new Map();
let processAdminTokenSecret = '';

// 不能从 cwd 等公开信息派生密钥：仓库公开，派生值可被任何人算出并伪造管理员 token
function resolveAdminTokenSecret() {
    const configured = String(process.env.ADMIN_TOKEN_SECRET || '').trim();
    if (configured.length >= MIN_ADMIN_TOKEN_SECRET_LENGTH) {
        return configured;
    }
    if (!processAdminTokenSecret) {
        processAdminTokenSecret = crypto.randomBytes(32).toString('hex');
        console.warn(`⚠️  [AdminAuth] ADMIN_TOKEN_SECRET ${configured ? `少于 ${MIN_ADMIN_TOKEN_SECRET_LENGTH} 位` : '未配置'}，已改用本进程随机密钥，重启后需重新登录。请用 openssl rand -hex 32 生成并写入 .env`);
    }
    return processAdminTokenSecret;
}

function normalizeEndpointUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * 已保存的密钥只发往已保存的地址：请求改了地址却没带对应的新密钥时返回错误文案，
 * 防止后台被冒用时借“测试/保存”把已存密钥转发到外部服务器。
 * rules: [{ urlField, secretFields, label }]
 */
function findSavedSecretRedirect(body = {}, saved = {}, rules = []) {
    for (const { urlField, secretFields, label } of rules) {
        const requestedUrl = normalizeEndpointUrl(body[urlField]);
        if (!requestedUrl || requestedUrl === normalizeEndpointUrl(saved[urlField])) {
            continue;
        }
        const missing = secretFields.filter((field) => String(saved[field] || '').trim() && !String(body[field] || '').trim());
        if (missing.length > 0) {
            return `${label}已修改，需要重新填写 ${missing.join('、')}，已保存的密钥不会发往新地址`;
        }
    }
    return '';
}

function encodeBase64Url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function decodeBase64Url(input) {
    const normalized = String(input || '')
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(String(input || '').length / 4) * 4, '=');
    return Buffer.from(normalized, 'base64').toString('utf8');
}

function signPayload(encodedPayload, secret = resolveAdminTokenSecret()) {
    return crypto
        .createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function safeEqualString(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
    const parts = String(storedHash || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
        return false;
    }
    const [, salt, expectedHash] = parts;
    const actualHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return safeEqualString(actualHash, expectedHash);
}

function issueSignedToken(payload, ttlMs, secret = resolveAdminTokenSecret()) {
    const now = Date.now();
    const body = {
        ...payload,
        iat: now,
        exp: now + ttlMs
    };
    const encodedPayload = encodeBase64Url(JSON.stringify(body));
    const signature = signPayload(encodedPayload, secret);
    return {
        token: `${encodedPayload}.${signature}`,
        payload: body
    };
}

function verifySignedToken(token, { expectedSub, secret = resolveAdminTokenSecret() } = {}) {
    if (!token || typeof token !== 'string') {
        return null;
    }
    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) {
        return null;
    }
    const expectedSignature = signPayload(encodedPayload, secret);
    if (!safeEqualString(signature, expectedSignature)) {
        return null;
    }
    try {
        const payload = JSON.parse(decodeBase64Url(encodedPayload));
        if (!payload || !payload.exp || Date.now() >= Number(payload.exp)) {
            return null;
        }
        if (expectedSub && payload.sub !== expectedSub) {
            return null;
        }
        return payload;
    } catch (_) {
        return null;
    }
}

function issueAdminToken(passwordVersion, email = '') {
    return issueSignedToken({
        sub: 'admin',
        permissions: ['admin'],
        pv: Math.max(1, Number(passwordVersion || 1)),
        email: String(email || '').trim().toLowerCase()
    }, ADMIN_TOKEN_TTL_MS);
}

function verifyAdminToken(token) {
    const payload = verifySignedToken(token, { expectedSub: 'admin' });
    if (!payload || !Array.isArray(payload.permissions) || !payload.permissions.includes('admin')) {
        return null;
    }
    return payload;
}

function issueLoginChallenge({ email, passwordVersion, ip, fingerprint }) {
    const challengeId = crypto.randomBytes(16).toString('hex');
    return issueSignedToken({
        sub: 'admin_login_challenge',
        cid: challengeId,
        email: String(email || '').trim().toLowerCase(),
        pv: Math.max(1, Number(passwordVersion || 1)),
        ip: String(ip || '').slice(0, 45),
        fp: String(fingerprint || '').slice(0, 128)
    }, CHALLENGE_TTL_MS);
}

function verifyLoginChallenge(token) {
    return verifySignedToken(token, { expectedSub: 'admin_login_challenge' });
}

function issueSecondaryToken(secondaryPasswordVersion, ip = '') {
    return issueSignedToken({
        sub: 'admin_secondary',
        sv: Math.max(1, Number(secondaryPasswordVersion || 1)),
        ip: String(ip || '').slice(0, 45)
    }, SECONDARY_TOKEN_TTL_MS);
}

function verifySecondaryToken(token) {
    return verifySignedToken(token, { expectedSub: 'admin_secondary' });
}

/**
 * 只信任本机 nginx 写入的 X-Real-IP（nginx 按 Cloudflare 网段开启 real_ip，见 deploy/nginx）。
 * X-Forwarded-For 首段可由客户端任意填写，用它限流等于没有限流。
 * app 端口只绑定 127.0.0.1，外部请求无法绕过 nginx 直接伪造 X-Real-IP。
 */
function resolveClientIp(req) {
    const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
    const raw = realIp || req?.socket?.remoteAddress || req?.ip || '';
    return String(raw)
        .replace(/^::ffff:/, '')
        .replace(/^::1$/, '127.0.0.1')
        .trim()
        .slice(0, 45);
}

// IPv6 按 /64 合并计数：同一用户可以轻易换用 /64 内的任意地址
function toRateLimitKey(ip) {
    const value = String(ip || '').trim().toLowerCase();
    if (!value.includes(':')) {
        return value || 'unknown';
    }
    const [head, tail = ''] = value.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const parts = value.includes('::')
        ? [...headParts, ...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'), ...tailParts]
        : headParts;
    return `${parts.slice(0, 4).map((part) => part || '0').join(':')}::/64`;
}

function getClientMeta(req) {
    return {
        ip: resolveClientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
        fingerprint: String(req.body?.fingerprint || req.headers['x-client-fingerprint'] || '').slice(0, 128)
    };
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function pruneLoginAttempts(now) {
    if (loginAttempts.size <= MAX_TRACKED_LOGIN_KEYS) {
        return;
    }
    for (const [key, entry] of loginAttempts) {
        if (key !== LOGIN_GLOBAL_KEY && entry.lockedUntil <= now && now - entry.firstAt > LOGIN_WINDOW_MS) {
            loginAttempts.delete(key);
        }
    }
}

function checkLoginRateLimit(ip, scope = 'login') {
    const key = `${scope}|${toRateLimitKey(ip)}`;
    const now = Date.now();
    const globalEntry = loginAttempts.get(LOGIN_GLOBAL_KEY);
    if (globalEntry?.lockedUntil && now < globalEntry.lockedUntil) {
        return { allowed: false, retryAfterSec: Math.ceil((globalEntry.lockedUntil - now) / 1000), reason: 'global_locked' };
    }
    const entry = loginAttempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0 };
    if (entry.lockedUntil && now < entry.lockedUntil) {
        const retryAfterSec = Math.ceil((entry.lockedUntil - now) / 1000);
        return { allowed: false, retryAfterSec, reason: 'locked' };
    }
    if (now - entry.firstAt > LOGIN_WINDOW_MS) {
        entry.count = 0;
        entry.firstAt = now;
        entry.lockedUntil = 0;
    }
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
        entry.lockedUntil = now + LOGIN_LOCK_MS;
        loginAttempts.set(key, entry);
        return { allowed: false, retryAfterSec: Math.ceil(LOGIN_LOCK_MS / 1000), reason: 'locked' };
    }
    return { allowed: true, entry, key };
}

function recordLoginFailure(key, entry) {
    const now = Date.now();
    const next = entry || { count: 0, firstAt: now, lockedUntil: 0 };
    next.count += 1;
    if (next.count >= LOGIN_MAX_ATTEMPTS) {
        next.lockedUntil = now + LOGIN_LOCK_MS;
    }
    loginAttempts.set(key, next);

    const globalEntry = loginAttempts.get(LOGIN_GLOBAL_KEY) || { count: 0, firstAt: now, lockedUntil: 0 };
    if (now - globalEntry.firstAt > LOGIN_WINDOW_MS) {
        globalEntry.count = 0;
        globalEntry.firstAt = now;
        globalEntry.lockedUntil = 0;
    }
    globalEntry.count += 1;
    if (globalEntry.count >= LOGIN_GLOBAL_MAX_ATTEMPTS) {
        globalEntry.lockedUntil = now + LOGIN_WINDOW_MS;
    }
    loginAttempts.set(LOGIN_GLOBAL_KEY, globalEntry);
    pruneLoginAttempts(now);
}

/**
 * 每个登录 challenge 最多尝试 CHALLENGE_MAX_ATTEMPTS 次二次验证，成功后作废。
 * 否则拿到一个 challenge 就能在有效期内无限次猜 6 位 TOTP。
 */
function consumeChallengeAttempt(challenge) {
    const cid = String(challenge?.cid || '').trim();
    if (!cid) {
        return { ok: false, reason: 'invalid' };
    }
    const now = Date.now();
    for (const [key, state] of challengeStates) {
        if (state.exp <= now) challengeStates.delete(key);
    }
    const state = challengeStates.get(cid) || { attempts: 0, used: false, exp: Number(challenge.exp) || now + CHALLENGE_TTL_MS };
    if (state.used) {
        return { ok: false, reason: 'used' };
    }
    if (state.attempts >= CHALLENGE_MAX_ATTEMPTS) {
        return { ok: false, reason: 'too_many_attempts' };
    }
    state.attempts += 1;
    challengeStates.set(cid, state);
    return { ok: true };
}

function markChallengeUsed(challenge) {
    const cid = String(challenge?.cid || '').trim();
    if (!cid) return;
    const state = challengeStates.get(cid) || { attempts: 0, exp: Number(challenge.exp) || Date.now() + CHALLENGE_TTL_MS };
    state.used = true;
    challengeStates.set(cid, state);
}

function clearLoginAttempts(key) {
    loginAttempts.delete(String(key || 'unknown'));
}

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_CHARS[(value << (5 - bits)) & 31];
    }
    return output;
}

function base32Decode(input) {
    const cleaned = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const output = [];
    for (const char of cleaned) {
        const idx = BASE32_CHARS.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            output.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(output);
}

function generateTotpToken(secret, counter) {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % 1_000_000).padStart(6, '0');
}

function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20));
}

function verifyTotpCode(secret, token, window = 1) {
    const normalizedSecret = String(secret || '').replace(/\s+/g, '').toUpperCase();
    const normalizedToken = String(token || '').trim().padStart(6, '0');
    if (!normalizedSecret || !/^\d{6}$/.test(normalizedToken)) {
        return false;
    }
    const counter = Math.floor(Date.now() / 1000 / 30);
    for (let w = -window; w <= window; w += 1) {
        if (generateTotpToken(normalizedSecret, counter + w) === normalizedToken) {
            return true;
        }
    }
    return false;
}

function getTotpUri(email, secret, issuer = 'PlusPapay') {
    const normalizedSecret = String(secret || '').replace(/\s+/g, '').toUpperCase();
    const accountName = `${issuer}:${String(email || 'admin').trim()}`;
    const encodedAccount = encodeURIComponent(accountName);
    const encodedIssuer = encodeURIComponent(issuer);
    return `otpauth://totp/${encodedAccount}?secret=${normalizedSecret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

function storeTelegramLoginCode(challengeId, code) {
    const key = String(challengeId || '').trim();
    if (!key) return;
    tgLoginCodes.set(key, {
        code: String(code),
        exp: Date.now() + TG_CODE_TTL_MS,
        attempts: 0
    });
}

function verifyTelegramLoginCode(challengeId, inputCode) {
    const key = String(challengeId || '').trim();
    const entry = tgLoginCodes.get(key);
    if (!entry) {
        return { ok: false, reason: 'expired' };
    }
    if (Date.now() >= entry.exp) {
        tgLoginCodes.delete(key);
        return { ok: false, reason: 'expired' };
    }
    entry.attempts += 1;
    if (entry.attempts > TG_CODE_MAX_ATTEMPTS) {
        tgLoginCodes.delete(key);
        return { ok: false, reason: 'too_many_attempts' };
    }
    if (!safeEqualString(String(inputCode || '').trim(), entry.code)) {
        tgLoginCodes.set(key, entry);
        return { ok: false, reason: 'invalid' };
    }
    tgLoginCodes.delete(key);
    return { ok: true };
}

function generateTelegramLoginCode() {
    return String(crypto.randomInt(100000, 1000000));
}

function is2faRequired(authConfig = {}, telegramSettings = {}) {
    if (authConfig.totpEnabled && authConfig.totpSecret) {
        return true;
    }
    const botToken = String(telegramSettings.bot_token || '').trim();
    const adminChatId = String(telegramSettings.admin_chat_id || '').trim();
    return Boolean(botToken && adminChatId);
}

function getAvailable2faMethods(authConfig = {}, telegramSettings = {}) {
    const methods = [];
    const totpSecret = String(authConfig.totpSecret || '').trim();
    if (authConfig.totpEnabled && totpSecret) {
        methods.push('totp');
    }
    const botToken = String(telegramSettings.bot_token || '').trim();
    const adminChatId = String(telegramSettings.admin_chat_id || '').trim();
    if (botToken && adminChatId) {
        methods.push('telegram');
    }
    return methods;
}

function resolveLogin2faMethods(authConfig = {}, telegramSettings = {}) {
    const available = getAvailable2faMethods(authConfig, telegramSettings);
    const mode = String(authConfig.login2faMode || 'either').trim().toLowerCase();
    if (mode === 'totp') {
        return available.includes('totp') ? ['totp'] : available;
    }
    if (mode === 'telegram') {
        return available.includes('telegram') ? ['telegram'] : available;
    }
    return available;
}

function pickDefaultLogin2faMethod(methods = [], preferred = '') {
    const list = Array.isArray(methods) ? methods : [];
    const pref = String(preferred || '').trim().toLowerCase();
    if (pref && list.includes(pref)) {
        return pref;
    }
    if (list.includes('totp')) {
        return 'totp';
    }
    return list[0] || '';
}

function createRequireSecondaryAuth(store, ensureStoreReady) {
    // 已取消后台二级密码：直接放行，仅保留管理员登录鉴权（authenticateAdmin）
    return async function requireSecondaryAuth(req, res, next) {
        req.secondaryAuth = { bypassed: true };
        return next();
    };
}

module.exports = {
    ADMIN_TOKEN_TTL_MS,
    ADMIN_REFRESH_AFTER_MS,
    MIN_ADMIN_TOKEN_SECRET_LENGTH,
    resolveAdminTokenSecret,
    findSavedSecretRedirect,
    safeEqualString,
    issueSignedToken,
    verifySignedToken,
    createPasswordHash,
    verifyPassword,
    issueAdminToken,
    verifyAdminToken,
    issueLoginChallenge,
    verifyLoginChallenge,
    issueSecondaryToken,
    verifySecondaryToken,
    resolveClientIp,
    toRateLimitKey,
    getClientMeta,
    normalizeEmail,
    checkLoginRateLimit,
    recordLoginFailure,
    clearLoginAttempts,
    consumeChallengeAttempt,
    markChallengeUsed,
    generateTotpSecret,
    verifyTotpCode,
    getTotpUri,
    storeTelegramLoginCode,
    verifyTelegramLoginCode,
    generateTelegramLoginCode,
    is2faRequired,
    getAvailable2faMethods,
    resolveLogin2faMethods,
    pickDefaultLogin2faMethod,
    createRequireSecondaryAuth
};
