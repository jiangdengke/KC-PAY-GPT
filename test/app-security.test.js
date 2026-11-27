'use strict';

const crypto = require('crypto');
const http = require('http');
const { createApp } = require('../src/app');
const adminAuth = require('../src/security/admin-auth');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'app-sec-key-1', alg: 'RS256' };
const TEAM_DOMAIN = 'sec-test.cloudflareaccess.com';
const AUD = 'app-sec-aud';

function b64(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signCfAccessJwt(claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'RS256', kid: 'app-sec-key-1' })}.${b64({
        iss: `https://${TEAM_DOMAIN}`,
        aud: [AUD],
        email: 'admin@example.com',
        exp: now + 600,
        ...claims
    })}`;
    return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

function createMockStore() {
    return {
        ensureReady: async () => true,
        getAdminPaths: async () => ({
            loginPath: 'secret-login',
            panelPath: 'secret-panel'
        }),
        getAdminAuthConfig: async () => ({
            email: 'admin@example.com',
            passwordHash: adminAuth.createPasswordHash('pass1234'),
            passwordVersion: 1,
            secondaryPasswordHash: adminAuth.createPasswordHash('sec1234'),
            secondaryPasswordVersion: 1,
            totpEnabled: false,
            totpSecret: '',
            login2faMode: 'either',
            notifyAdminLogin: false
        }),
        getTelegramConfig: async () => ({}),
        listActiveIpBans: async () => [],
        getTrustedAdminIps: async () => [],
        getCdkByCode: async () => null,
        verifyCdkDetails: async () => null
    };
}

describe('Express app security boundaries', () => {
    let server;
    let baseUrl;
    const originalSecret = process.env.ADMIN_TOKEN_SECRET;

    beforeAll(async () => {
        process.env.ADMIN_TOKEN_SECRET = 'c'.repeat(32);
        const { app } = createApp({
            store: createMockStore(),
            cfAccessConfig: {
                teamDomain: TEAM_DOMAIN,
                aud: AUD,
                fetchCerts: async () => ({ keys: [jwk] })
            }
        });
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        if (originalSecret === undefined) {
            delete process.env.ADMIN_TOKEN_SECRET;
        } else {
            process.env.ADMIN_TOKEN_SECRET = originalSecret;
        }
    });

    it('removes /api/public/admin-paths and blocks direct access to admin HTML/assets', async () => {
        const blockedPaths = [
            '/api/public/admin-paths',
            '/admin.html',
            '/admin-login.html',
            '/admin.js',
            '/admin.css',
            '/admin-assets/core.js',
            '/admin-assets/admin.css'
        ];
        for (const p of blockedPaths) {
            const res = await fetch(`${baseUrl}${p}`);
            expect(res.status, `expected 404 for ${p}`).toBe(404);
        }
    });

    it('requires Cloudflare Access JWT for /{loginPath}, /{panelPath}, /admin/assets/*, and /api/admin/*', async () => {
        const cfToken = signCfAccessJwt();

        // Without CF Access JWT -> 403
        expect((await fetch(`${baseUrl}/secret-login`)).status).toBe(403);
        expect((await fetch(`${baseUrl}/secret-panel`)).status).toBe(403);
        expect((await fetch(`${baseUrl}/admin/assets/core.js`)).status).toBe(403);
        expect((await fetch(`${baseUrl}/api/admin/data`)).status).toBe(403);

        // With Cf-Access-Jwt-Assertion header
        const loginRes = await fetch(`${baseUrl}/secret-login`, {
            headers: { 'Cf-Access-Jwt-Assertion': cfToken }
        });
        expect(loginRes.status).toBe(200);
        expect(loginRes.headers.get('cache-control')).toContain('no-store');

        const panelRes = await fetch(`${baseUrl}/secret-panel`, {
            headers: { 'Cf-Access-Jwt-Assertion': cfToken }
        });
        expect(panelRes.status).toBe(200);
        expect(panelRes.headers.get('cache-control')).toContain('no-store');
        const panelHtml = await panelRes.text();
        expect(panelHtml).toContain('<meta name="admin-login-path" content="/secret-login">');
        expect(panelHtml).toContain('/admin/assets/core.js');

        const assetHeaderRes = await fetch(`${baseUrl}/admin/assets/core.js`, {
            headers: { 'Cf-Access-Jwt-Assertion': cfToken }
        });
        expect(assetHeaderRes.status).toBe(200);
        expect(assetHeaderRes.headers.get('cache-control')).toContain('no-store');

        // With CF_Authorization cookie fallback
        const assetCookieRes = await fetch(`${baseUrl}/admin/assets/core.js`, {
            headers: { Cookie: `CF_Authorization=${encodeURIComponent(cfToken)}` }
        });
        expect(assetCookieRes.status).toBe(200);

        // /api/admin/data with CF Access but no admin Bearer token -> 401
        const apiNoBearer = await fetch(`${baseUrl}/api/admin/data`, {
            headers: { 'Cf-Access-Jwt-Assertion': cfToken }
        });
        expect(apiNoBearer.status).toBe(401);

        // /api/admin/session with both CF Access and admin Bearer returns dynamic paths
        const { token: adminBearer } = adminAuth.issueAdminToken(1, 'admin@example.com');
        const sessionRes = await fetch(`${baseUrl}/api/admin/session`, {
            headers: {
                'Cf-Access-Jwt-Assertion': cfToken,
                Authorization: `Bearer ${adminBearer}`
            }
        });
        expect(sessionRes.status).toBe(200);
        const sessionBody = await sessionRes.json();
        expect(sessionBody).toMatchObject({
            success: true,
            loginPath: 'secret-login',
            panelPath: 'secret-panel',
            loginUrl: '/secret-login',
            panelUrl: '/secret-panel'
        });
    });

    it('serves cleaned customer index.html and handles prototype-pollution JSON safely', async () => {
        const indexRes = await fetch(`${baseUrl}/`);
        expect(indexRes.status).toBe(200);
        const indexHtml = await indexRes.text();
        expect(indexHtml).not.toContain('paymentRegionHint');
        expect(indexHtml).not.toContain('loadPaymentRegionHint');

        const pollRes = await fetch(`${baseUrl}/api/verify-cdk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"cdk":{"toString":1,"valueOf":2,"__proto__":{"polluted":true}}}'
        });
        expect(pollRes.status).toBe(400);
        const pollBody = await pollRes.json();
        expect(pollBody.success).toBe(false);

        const missingCdkRes = await fetch(`${baseUrl}/api/verify-cdk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cdk: 'KC-NONEXISTENT12345' })
        });
        expect(missingCdkRes.status).toBe(403);
        const missingBody = await missingCdkRes.json();
        expect(missingBody.success).toBe(false);
    });
});
