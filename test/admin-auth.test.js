'use strict';

const crypto = require('crypto');
const adminAuth = require('../admin-auth');

// 2026-10 之前的回退密钥：仓库公开，任何人都能算出
function legacyDerivedSecret(cwd) {
    return crypto.createHash('sha256').update(`web_redeem:${cwd}:admin-token-secret`).digest('hex');
}

function forgeAdminToken(secret) {
    return adminAuth.issueSignedToken({ sub: 'admin', permissions: ['admin'], pv: 1 }, 60 * 1000, secret).token;
}

describe('admin token secret', () => {
    const originalSecret = process.env.ADMIN_TOKEN_SECRET;

    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalSecret === undefined) {
            delete process.env.ADMIN_TOKEN_SECRET;
        } else {
            process.env.ADMIN_TOKEN_SECRET = originalSecret;
        }
    });

    it('rejects tokens forged with the legacy cwd-derived secret when no secret is configured', () => {
        delete process.env.ADMIN_TOKEN_SECRET;
        for (const cwd of ['/app', process.cwd()]) {
            expect(adminAuth.verifyAdminToken(forgeAdminToken(legacyDerivedSecret(cwd)))).toBeNull();
        }
    });

    it('uses a random per-process secret when the configured secret is missing or short', () => {
        delete process.env.ADMIN_TOKEN_SECRET;
        const missing = adminAuth.resolveAdminTokenSecret();
        expect(missing).toMatch(/^[0-9a-f]{64}$/);
        expect(missing).not.toBe(legacyDerivedSecret('/app'));
        expect(missing).not.toBe(legacyDerivedSecret(process.cwd()));

        process.env.ADMIN_TOKEN_SECRET = 'too-short';
        expect(adminAuth.resolveAdminTokenSecret()).toBe(missing);

        const { token } = adminAuth.issueAdminToken(1, 'admin@example.com');
        expect(adminAuth.verifyAdminToken(token)).toMatchObject({ sub: 'admin', pv: 1 });
    });

    it('signs with the configured secret and rejects tokens signed with any other secret', () => {
        process.env.ADMIN_TOKEN_SECRET = 'a'.repeat(adminAuth.MIN_ADMIN_TOKEN_SECRET_LENGTH);
        const { token } = adminAuth.issueAdminToken(3, 'admin@example.com');
        expect(adminAuth.verifyAdminToken(token)).toMatchObject({ sub: 'admin', pv: 3 });
        expect(adminAuth.verifyAdminToken(forgeAdminToken(legacyDerivedSecret('/app')))).toBeNull();

        process.env.ADMIN_TOKEN_SECRET = 'b'.repeat(adminAuth.MIN_ADMIN_TOKEN_SECRET_LENGTH);
        expect(adminAuth.verifyAdminToken(token)).toBeNull();
    });
});

describe('findSavedSecretRedirect', () => {
    const rules = [
        { urlField: 'base_url', secretFields: ['api_key'], label: '代充 API 地址' },
        { urlField: 'orbitcard_base_url', secretFields: ['orbitcard_api_key', 'orbitcard_api_secret'], label: 'Orbitcard 地址' }
    ];
    const saved = {
        base_url: 'https://api.example.com',
        api_key: 'saved-key',
        orbitcard_base_url: 'https://orbitcard.cc',
        orbitcard_api_key: 'saved-orbit-key',
        orbitcard_api_secret: 'saved-orbit-secret'
    };

    it('allows the saved address with saved secrets, ignoring a trailing slash', () => {
        expect(adminAuth.findSavedSecretRedirect({ base_url: 'https://api.example.com/' }, saved, rules)).toBe('');
        expect(adminAuth.findSavedSecretRedirect({}, saved, rules)).toBe('');
    });

    it('rejects a new address that would reuse saved secrets', () => {
        expect(adminAuth.findSavedSecretRedirect({ base_url: 'https://attacker.example' }, saved, rules))
            .toContain('api_key');
        expect(adminAuth.findSavedSecretRedirect({
            orbitcard_base_url: 'https://attacker.example',
            orbitcard_api_key: 'new-key'
        }, saved, rules)).toContain('orbitcard_api_secret');
    });

    it('allows a new address when every saved secret is replaced or none is saved', () => {
        expect(adminAuth.findSavedSecretRedirect({
            base_url: 'https://new.example.com',
            api_key: 'new-key'
        }, saved, rules)).toBe('');
        expect(adminAuth.findSavedSecretRedirect(
            { base_url: 'https://new.example.com' },
            { base_url: 'https://api.example.com', api_key: '' },
            rules
        )).toBe('');
    });
});

function freshAdminAuth() {
    delete require.cache[require.resolve('../admin-auth')];
    return require('../admin-auth');
}

describe('client IP and login throttling', () => {
    it('ignores client-supplied X-Forwarded-For and trusts the nginx X-Real-IP header', () => {
        const req = {
            headers: { 'x-forwarded-for': '127.0.0.1, 1.2.3.4', 'x-real-ip': '203.0.113.9' },
            socket: { remoteAddress: '172.18.0.1' }
        };
        expect(adminAuth.resolveClientIp(req)).toBe('203.0.113.9');
        expect(adminAuth.resolveClientIp({ headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '::ffff:10.0.0.5' } }))
            .toBe('10.0.0.5');
    });

    it('groups IPv6 addresses by /64 for rate limiting', () => {
        expect(adminAuth.toRateLimitKey('2605:a140:2361:126::1')).toBe('2605:a140:2361:126::/64');
        expect(adminAuth.toRateLimitKey('2605:a140:2361:126:ffff:1:2:3')).toBe('2605:a140:2361:126::/64');
        expect(adminAuth.toRateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
        expect(adminAuth.toRateLimitKey('85.239.242.39')).toBe('85.239.242.39');
    });

    it('locks one source after repeated failures and keeps scopes separate', () => {
        const auth = freshAdminAuth();
        for (let i = 0; i < 5; i += 1) {
            const rate = auth.checkLoginRateLimit('198.51.100.7');
            expect(rate.allowed).toBe(true);
            auth.recordLoginFailure(rate.key, rate.entry);
        }
        expect(auth.checkLoginRateLimit('198.51.100.7').allowed).toBe(false);
        expect(auth.checkLoginRateLimit('198.51.100.7', '2fa').allowed).toBe(true);
        expect(auth.checkLoginRateLimit('198.51.100.8').allowed).toBe(true);
    });

    it('locks every source once global failures reach the cap', () => {
        const auth = freshAdminAuth();
        for (let i = 0; i < 100; i += 1) {
            const rate = auth.checkLoginRateLimit(`10.1.${Math.floor(i / 4)}.${i % 4}`);
            expect(rate.allowed).toBe(true);
            auth.recordLoginFailure(rate.key, rate.entry);
        }
        const blocked = auth.checkLoginRateLimit('192.0.2.200');
        expect(blocked).toMatchObject({ allowed: false, reason: 'global_locked' });
    });
});

describe('2FA challenge attempts', () => {
    it('allows five attempts per challenge and rejects reuse after success', () => {
        const auth = freshAdminAuth();
        const challenge = { cid: 'challenge-a', exp: Date.now() + 60 * 1000 };
        for (let i = 0; i < 5; i += 1) {
            expect(auth.consumeChallengeAttempt(challenge).ok).toBe(true);
        }
        expect(auth.consumeChallengeAttempt(challenge)).toEqual({ ok: false, reason: 'too_many_attempts' });

        const other = { cid: 'challenge-b', exp: Date.now() + 60 * 1000 };
        expect(auth.consumeChallengeAttempt(other).ok).toBe(true);
        auth.markChallengeUsed(other);
        expect(auth.consumeChallengeAttempt(other)).toEqual({ ok: false, reason: 'used' });
    });

    it('generates six-digit Telegram codes', () => {
        for (let i = 0; i < 50; i += 1) {
            expect(adminAuth.generateTelegramLoginCode()).toMatch(/^[1-9]\d{5}$/);
        }
    });
});

describe('public request quotas', () => {
    it('charges batch requests by cost and blocks once the window is used up', () => {
        const auth = freshAdminAuth();
        const limits = { windowMs: 60 * 1000, max: 600 };
        for (let i = 0; i < 6; i += 1) {
            expect(auth.consumeRequestQuota('lookup', '203.0.113.50', { ...limits, cost: 100 }).allowed).toBe(true);
        }
        const blocked = auth.consumeRequestQuota('lookup', '203.0.113.50', { ...limits, cost: 1 });
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterSec).toBeGreaterThan(0);
        expect(auth.consumeRequestQuota('activation', '203.0.113.50', { windowMs: 60 * 1000, max: 30 }).allowed).toBe(true);
        expect(auth.consumeRequestQuota('lookup', '203.0.113.51', { ...limits, cost: 100 }).allowed).toBe(true);
    });

    it('shares one quota across an IPv6 /64', () => {
        const auth = freshAdminAuth();
        const limits = { windowMs: 60 * 1000, max: 2 };
        expect(auth.consumeRequestQuota('activation', '2605:a140:2361:126::1', limits).allowed).toBe(true);
        expect(auth.consumeRequestQuota('activation', '2605:a140:2361:126::2', limits).allowed).toBe(true);
        expect(auth.consumeRequestQuota('activation', '2605:a140:2361:126:abcd::9', limits).allowed).toBe(false);
    });
});

describe('findWeakCdkCodes', () => {
    it('flags imported codes shorter than the minimum length', () => {
        expect(adminAuth.findWeakCdkCodes(['KC-K25PBB6MNM7VVV8', ' 12345678 ', 'ABCDEFGHIJK', 'ABCDEFGHIJKL', '', null]))
            .toEqual(['12345678', 'ABCDEFGHIJK']);
        expect(adminAuth.findWeakCdkCodes(['KC-K25PBB6MNM7VVV8'])).toEqual([]);
    });
});
