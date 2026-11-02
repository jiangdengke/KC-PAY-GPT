'use strict';

const crypto = require('crypto');

// Cloudflare 每 6 周轮换签名密钥，旧密钥再保留 7 天。遇到未知 kid 时提前刷新，但限制频率，防止假令牌刷爆证书接口
const CERTS_TTL_MS = 60 * 60 * 1000;
const CERTS_MIN_REFRESH_MS = 60 * 1000;
const CLOCK_SKEW_SEC = 60;

function normalizeTeamDomain(value) {
    return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function decodeJson(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * 校验 Cloudflare Access 令牌。keys 是证书接口返回的 JWK 数组。
 * 返回 { ok: true, email } 或 { ok: false, reason }；reason 为 unknown_kid 时调用方可刷新证书后重试。
 */
function verifyAccessToken(token, { keys, issuer, audience, now = Date.now() }) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: token ? 'malformed' : 'missing' };
    let header;
    let payload;
    try {
        header = decodeJson(parts[0]);
        payload = decodeJson(parts[1]);
    } catch (_) {
        return { ok: false, reason: 'malformed' };
    }
    // 算法写死，不信任令牌自己声明的算法
    if (header?.alg !== 'RS256') return { ok: false, reason: 'bad_alg' };
    const jwk = (keys || []).find((key) => key.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'unknown_kid' };
    let signatureOk = false;
    try {
        signatureOk = crypto.verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            crypto.createPublicKey({ key: jwk, format: 'jwk' }),
            Buffer.from(parts[2], 'base64url')
        );
    } catch (_) {
        signatureOk = false;
    }
    if (!signatureOk) return { ok: false, reason: 'bad_signature' };
    if (payload?.iss !== issuer) return { ok: false, reason: 'bad_issuer' };
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) return { ok: false, reason: 'bad_audience' };
    const seconds = now / 1000;
    if (!Number.isFinite(payload.exp) || payload.exp + CLOCK_SKEW_SEC < seconds) return { ok: false, reason: 'expired' };
    if (Number.isFinite(payload.nbf) && payload.nbf - CLOCK_SKEW_SEC > seconds) return { ok: false, reason: 'not_yet_valid' };
    return { ok: true, email: payload.email };
}

/**
 * 生成 Express 中间件。teamDomain 和 audience 都留空时不启用；只填一个视为配置错误，直接拒绝。
 * fetchCerts(url) 返回证书接口的 JSON；onReject(reason, req) 在每次拒绝时调用。
 */
function createAccessGuard({ teamDomain, audience, certsUrl, fetchCerts, onReject = () => {} }) {
    const domain = normalizeTeamDomain(teamDomain);
    const aud = String(audience || '').trim();
    if (!domain && !aud) {
        return (req, res, next) => next();
    }
    const issuer = `https://${domain}`;
    const url = certsUrl || `${issuer}/cdn-cgi/access/certs`;
    let keys = [];
    let fetchedAt = 0;
    let lastAttemptAt = 0;
    let inFlight = null;

    function refreshKeys(now) {
        if (inFlight) return inFlight;
        if (now - lastAttemptAt < CERTS_MIN_REFRESH_MS) return Promise.resolve();
        lastAttemptAt = now;
        inFlight = Promise.resolve()
            .then(() => fetchCerts(url))
            .then((body) => {
                if (Array.isArray(body?.keys) && body.keys.length > 0) {
                    keys = body.keys;
                    fetchedAt = Date.now();
                }
            })
            .catch((error) => console.warn(`[CfAccess] 获取证书失败，继续使用旧证书（${keys.length} 个）: ${error.message}`))
            .finally(() => { inFlight = null; });
        return inFlight;
    }

    function reject(req, res, status, reason, message) {
        onReject(reason, req);
        res.status(status).json({ success: false, message });
    }

    return async function requireCfAccess(req, res, next) {
        if (!domain || !aud) {
            return reject(req, res, 503, 'misconfigured', 'Cloudflare Access 配置不完整');
        }
        const now = Date.now();
        if (now - fetchedAt > CERTS_TTL_MS) await refreshKeys(now);
        if (keys.length === 0) {
            return reject(req, res, 503, 'certs_unavailable', '暂时无法校验 Cloudflare Access，请稍后再试');
        }
        const verify = () => verifyAccessToken(req.get('Cf-Access-Jwt-Assertion'), { keys, issuer, audience: aud, now });
        let result = verify();
        if (result.reason === 'unknown_kid') {
            await refreshKeys(now);
            result = verify();
        }
        if (result.ok) return next();
        return reject(req, res, 403, result.reason, '请先通过 Cloudflare Access 验证');
    };
}

module.exports = { normalizeTeamDomain, verifyAccessToken, createAccessGuard };
