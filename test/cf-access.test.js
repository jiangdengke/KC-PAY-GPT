'use strict';

const crypto = require('crypto');
const cfAccess = require('../cf-access');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256' };
const otherJwk = { ...other.publicKey.export({ format: 'jwk' }), kid: 'key-2', alg: 'RS256' };

const TEAM = 'team.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'aud-tag';
const nowSec = () => Math.floor(Date.now() / 1000);

function b64(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(claims = {}, { kid = 'key-1', alg = 'RS256', key = privateKey } = {}) {
    const payload = { iss: ISSUER, aud: [AUD], email: 'me@example.com', exp: nowSec() + 600, ...claims };
    const body = `${b64({ alg, kid })}.${b64(payload)}`;
    return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

const options = { keys: [jwk], issuer: ISSUER, audience: AUD };

describe('verifyAccessToken', () => {
    it('accepts a valid token, with aud as an array or a string', () => {
        expect(cfAccess.verifyAccessToken(sign(), options)).toEqual({ ok: true, email: 'me@example.com' });
        expect(cfAccess.verifyAccessToken(sign({ aud: AUD }), options).ok).toBe(true);
    });

    it.each([
        ['missing', undefined],
        ['malformed', 'a.b'],
        ['malformed', 'a.b.c'],
        ['bad_issuer', sign({ iss: 'https://evil.cloudflareaccess.com' })],
        ['bad_audience', sign({ aud: ['other-app'] })],
        ['expired', sign({ exp: nowSec() - 3600 })],
        ['expired', sign({ exp: undefined })],
        ['not_yet_valid', sign({ nbf: nowSec() + 3600 })],
        ['unknown_kid', sign({}, { kid: 'nope' })],
        ['bad_signature', sign({}, { key: other.privateKey })]
    ])('rejects with %s', (reason, token) => {
        expect(cfAccess.verifyAccessToken(token, options)).toEqual({ ok: false, reason });
    });

    it('rejects a tampered payload', () => {
        const [head, , signature] = sign().split('.');
        const forged = `${head}.${b64({ iss: ISSUER, aud: [AUD], exp: nowSec() + 600, email: 'evil@example.com' })}.${signature}`;
        expect(cfAccess.verifyAccessToken(forged, options).reason).toBe('bad_signature');
    });

    it('rejects alg none and HS256 signed with the public key', () => {
        const none = `${b64({ alg: 'none', kid: 'key-1' })}.${b64({ iss: ISSUER, aud: [AUD], exp: nowSec() + 600 })}.`;
        expect(cfAccess.verifyAccessToken(none, options).reason).toBe('bad_alg');

        const body = `${b64({ alg: 'HS256', kid: 'key-1' })}.${b64({ iss: ISSUER, aud: [AUD], exp: nowSec() + 600 })}`;
        const secret = publicKey.export({ type: 'spki', format: 'pem' });
        const hs = `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
        expect(cfAccess.verifyAccessToken(hs, options).reason).toBe('bad_alg');
    });
});

describe('normalizeTeamDomain', () => {
    it('accepts a bare domain or a URL', () => {
        expect(cfAccess.normalizeTeamDomain(' https://Team.cloudflareaccess.com/ ')).toBe(TEAM);
        expect(cfAccess.normalizeTeamDomain(TEAM)).toBe(TEAM);
        expect(cfAccess.normalizeTeamDomain(undefined)).toBe('');
    });
});

describe('createAccessGuard', () => {
    function run(guard, token) {
        const result = { nexted: false, status: null, body: null };
        const req = { get: (name) => (name === 'Cf-Access-Jwt-Assertion' ? token : undefined) };
        const res = {
            status(code) { result.status = code; return this; },
            json(body) { result.body = body; return this; }
        };
        return Promise.resolve(guard(req, res, () => { result.nexted = true; })).then(() => result);
    }

    const guardWith = (fetchCerts, onReject) => cfAccess.createAccessGuard({ teamDomain: TEAM, audience: AUD, fetchCerts, onReject });

    it('passes everything through when not configured', async () => {
        const fetchCerts = vi.fn();
        const guard = cfAccess.createAccessGuard({ teamDomain: '', audience: '', fetchCerts });
        expect((await run(guard)).nexted).toBe(true);
        expect(fetchCerts).not.toHaveBeenCalled();
    });

    it('fails closed when only one of the two settings is present', async () => {
        const onReject = vi.fn();
        const guard = cfAccess.createAccessGuard({ teamDomain: TEAM, audience: '', fetchCerts: vi.fn(), onReject });
        const result = await run(guard, sign());
        expect(result.nexted).toBe(false);
        expect(result.status).toBe(503);
        expect(onReject.mock.calls[0][0]).toBe('misconfigured');
    });

    it('fetches certs from the team domain and lets a valid token through', async () => {
        const fetchCerts = vi.fn(async () => ({ keys: [jwk] }));
        const result = await run(guardWith(fetchCerts), sign());
        expect(result.nexted).toBe(true);
        expect(fetchCerts).toHaveBeenCalledWith(`${ISSUER}/cdn-cgi/access/certs`);
    });

    it('rejects a missing token and reports why', async () => {
        const onReject = vi.fn();
        const result = await run(guardWith(async () => ({ keys: [jwk] }), onReject));
        expect(result.status).toBe(403);
        expect(result.body.success).toBe(false);
        expect(onReject.mock.calls[0][0]).toBe('missing');
    });

    it('fails closed when certs cannot be fetched', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await run(guardWith(async () => { throw new Error('down'); }), sign());
        warn.mockRestore();
        expect(result.nexted).toBe(false);
        expect(result.status).toBe(503);
    });

    it('limits cert refreshes triggered by unknown key ids', async () => {
        const fetchCerts = vi.fn(async () => ({ keys: [jwk] }));
        const guard = guardWith(fetchCerts);
        for (let i = 0; i < 5; i += 1) {
            expect((await run(guard, sign({}, { kid: 'nope' }))).status).toBe(403);
        }
        expect(fetchCerts).toHaveBeenCalledTimes(1);
    });

    it('shares one fetch between concurrent requests', async () => {
        const fetchCerts = vi.fn(async () => ({ keys: [jwk] }));
        const guard = guardWith(fetchCerts);
        const results = await Promise.all([run(guard, sign()), run(guard, sign()), run(guard, sign())]);
        expect(results.every((result) => result.nexted)).toBe(true);
        expect(fetchCerts).toHaveBeenCalledTimes(1);
    });

    it('picks up a rotated key after the refresh interval', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const fetchCerts = vi.fn().mockResolvedValueOnce({ keys: [jwk] }).mockResolvedValue({ keys: [jwk, otherJwk] });
            const guard = guardWith(fetchCerts);
            expect((await run(guard, sign())).nexted).toBe(true);
            vi.advanceTimersByTime(61 * 1000);
            expect((await run(guard, sign({}, { kid: 'key-2', key: other.privateKey }))).nexted).toBe(true);
            expect(fetchCerts).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
