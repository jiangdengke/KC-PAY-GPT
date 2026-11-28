'use strict';

const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { createApp } = require('../src/app');
const adminAuth = require('../src/security/admin-auth');
const ipBan = require('../src/security/ip-ban');
const { PUBLIC_CDK_QUOTAS } = require('../src/security/security-manager');
const { ACTIVATION_COOLDOWN_MINUTES, ACTIVATION_FAILURE_THRESHOLD } = require('../src/db/cdk-repo');

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

describe('Hardened security without Cloudflare Access', () => {
    let server;
    let wss;
    let baseUrl;
    let wsUrl;
    let securityRef;
    let passwordVersion = 2;
    let totpSecret = '';
    let totpEnabled = false;
    let login2faMode = 'either';
    const clearedCdks = [];
    const activeIpCooldowns = [
        { scopeType: 'ip', scopeKey: '203.0.113.88', failCount: 0, cooldownUntil: '2099-01-01T00:00:00.000Z', remainingMinutes: 29 }
    ];
    const originalSecret = process.env.ADMIN_TOKEN_SECRET;

    beforeAll(async () => {
        process.env.ADMIN_TOKEN_SECRET = 'e'.repeat(64);
        const store = {
            ensureReady: async () => true,
            getAdminPaths: async () => ({
                loginPath: 'custom-login-x',
                panelPath: 'custom-panel-x'
            }),
            getAdminAuthConfig: async () => ({
                email: 'owner@example.com',
                passwordHash: adminAuth.createPasswordHash('StrongPass!2026'),
                passwordVersion,
                secondaryPasswordHash: adminAuth.createPasswordHash('sec1234'),
                secondaryPasswordVersion: 1,
                totpEnabled,
                totpSecret,
                login2faMode,
                notifyAdminLogin: false
            }),
            saveAdminTotpConfig: async ({ secret, enabled }) => {
                totpSecret = String(secret || '');
                totpEnabled = Boolean(enabled);
            },
            saveAdmin2faLoginMode: async (mode) => {
                login2faMode = mode;
                return mode;
            },
            getTelegramConfig: async () => ({
                bot_token: '123456:TESTTOKEN',
                admin_chat_id: '999999'
            }),
            getAppConfigValue: async (key, fallback = '') => (key === 'external_card_api_key' ? 'ext-secret-key-1234567890' : fallback),
            listActiveIpBanRules: async () => [],
            listRecentAdminLoginIps: async () => [],
            saveIpBan: async () => {},
            insertAdminLoginLog: async () => {},
            verifyCdkDetails: async (cdk) => {
                if (cdk === 'KC-LEGACY-PRO200') {
                    return { code: cdk, type: '自助', plan_type: 'pro200', used_at: null, cooldown_until: null };
                }
                if (cdk === 'KC-COOLED-PLUS01') {
                    return { code: cdk, type: '自助', plan_type: 'plus', used_at: null, cooldown_until: '2099-01-01T00:00:00.000Z' };
                }
                return null;
            },
            resetCdkFailure: async (cdk) => {
                clearedCdks.push(cdk);
            },
            listActiveActivationCooldowns: async () => [...activeIpCooldowns],
            resetActivationAttemptFailure: async (scopeType, scopeKey) => {
                const idx = activeIpCooldowns.findIndex((item) => item.scopeType === scopeType && item.scopeKey === scopeKey);
                if (idx >= 0) activeIpCooldowns.splice(idx, 1);
            },
            getActivationAttemptLimit: async () => null,
            getRunningTaskByCdk: async () => null,
            getActivationManualHold: async () => null,
            getTaskStatus: async () => null
        };

        const { app, ensureStoreReady, security, taskHub } = createApp({
            store,
            cfAccessConfig: { teamDomain: '', aud: '' }
        });
        securityRef = security;
        security.ipBanState.matcher = ipBan.createBanMatcher([
            { id: 77, cidr: '198.51.100.77/32', expires_at: null }
        ]);

        server = http.createServer(app);
        wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
        taskHub.attachWebSocketServer(wss, { ensureStoreReady, security });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        wsUrl = `ws://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        if (wss) {
            await new Promise((resolve) => wss.close(resolve));
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        if (originalSecret === undefined) {
            delete process.env.ADMIN_TOKEN_SECRET;
        } else {
            process.env.ADMIN_TOKEN_SECRET = originalSecret;
        }
    });

    it('rejects every forged, tampered, stale-pv, or challenge-replayed admin Bearer token with 401 when CF Access is off', async () => {
        const legacyAppSecret = crypto.createHash('sha256').update('web_redeem:/app:admin-token-secret').digest('hex');
        const forgedLegacy = adminAuth.issueSignedToken({ sub: 'admin', permissions: ['admin'], pv: 2 }, 60_000, legacyAppSecret).token;
        const forgedWrongSecret = adminAuth.issueSignedToken({ sub: 'admin', permissions: ['admin'], pv: 2 }, 60_000, 'f'.repeat(64)).token;
        const stalePvToken = adminAuth.issueAdminToken(1, 'owner@example.com').token;
        const { token: challengeToken } = adminAuth.issueLoginChallenge({
            email: 'owner@example.com',
            passwordVersion: 2,
            ip: '198.51.100.5',
            fingerprint: 'fp'
        });
        const validToken = adminAuth.issueAdminToken(2, 'owner@example.com').token;
        const extraDotToken = `${validToken}.tamper`;

        const badTokens = [
            '',
            'not-a-token',
            forgedLegacy,
            forgedWrongSecret,
            stalePvToken,
            challengeToken,
            extraDotToken
        ];

        for (const token of badTokens) {
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const res = await fetch(`${baseUrl}/api/admin/data`, { headers });
            expect(res.status, `expected 401 for bad token`).toBe(401);
        }

        // Valid token with matching pv succeeds
        const okRes = await fetch(`${baseUrl}/api/admin/session`, {
            headers: { Authorization: `Bearer ${validToken}` }
        });
        expect(okRes.status).toBe(200);
    });

    it('rejects 2FA verify and send-tg-code when passwordVersion changed after challenge was issued', async () => {
        passwordVersion = 2;
        const { token: oldChallenge } = adminAuth.issueLoginChallenge({
            email: 'owner@example.com',
            passwordVersion: 2,
            ip: '198.51.100.8',
            fingerprint: 'fp'
        });

        // Password rotates to version 3
        passwordVersion = 3;

        const verifyRes = await fetch(`${baseUrl}/api/admin/login/verify-2fa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.8' },
            body: JSON.stringify({ challengeToken: oldChallenge, method: 'telegram', code: '123456' })
        });
        expect(verifyRes.status).toBe(401);

        const sendRes = await fetch(`${baseUrl}/api/admin/login/send-tg-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.8' },
            body: JSON.stringify({ challengeToken: oldChallenge })
        });
        expect(sendRes.status).toBe(401);

        passwordVersion = 2;
    });

    it('actually enforces public CDK lookup quota (returns 429 with Retry-After) and external cards quota', async () => {
        const ip = '203.0.113.199';
        const batch = Array.from({ length: 100 }, (_, i) => `KC-QUOTATEST000${String(i).padStart(3, '0')}`);

        // 6 batches x 100 = 600 quota units (exact limit)
        for (let i = 0; i < 6; i += 1) {
            const res = await fetch(`${baseUrl}/api/cdk/query-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
                body: JSON.stringify({ cdks: batch })
            });
            expect(res.status).toBe(200);
        }

        // 601st lookup must be throttled with 429 + Retry-After
        const throttled = await fetch(`${baseUrl}/api/verify-cdk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
            body: JSON.stringify({ cdk: 'KC-QUOTATEST999999' })
        });
        expect(throttled.status).toBe(429);
        expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);

        // External card push rejects bad API key and enforces quota
        const badKey = await fetch(`${baseUrl}/api/external/cards/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.200', 'X-API-Key': 'wrong-key' },
            body: JSON.stringify({ cards: [] })
        });
        expect(badKey.status).toBe(401);
    });

    it('closes WebSocket connections from banned IPs and Tor exit nodes with 1008', async () => {
        const bannedCode = await new Promise((resolve) => {
            const ws = new WebSocket(wsUrl, { headers: { 'X-Real-IP': '198.51.100.77' } });
            ws.on('close', (code) => resolve(code));
        });
        expect(bannedCode).toBe(1008);

        securityRef.torExitState.ips.add('185.220.101.99');
        const torCode = await new Promise((resolve) => {
            const ws = new WebSocket(wsUrl, { headers: { 'X-Real-IP': '185.220.101.99' } });
            ws.on('close', (code) => resolve(code));
        });
        expect(torCode).toBe(1008);
    });

    it('generates TOTP QR code locally as data URI (never third-party) and enforces TOTP-only mode when enabled', async () => {
        const validToken = adminAuth.issueAdminToken(passwordVersion, 'owner@example.com').token;
        const setupRes = await fetch(`${baseUrl}/api/admin/2fa/setup`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${validToken}` }
        });
        expect(setupRes.status).toBe(200);
        const setupBody = await setupRes.json();
        expect(setupBody.success).toBe(true);
        expect(setupBody.secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(setupBody.qrCodeUrl).toMatch(/^data:image\/png;base64,/);
        expect(setupBody.qrCodeUrl).not.toContain('qrserver.com');

        // Enable TOTP-only mode and confirm TOTP active
        login2faMode = 'totp';
        totpEnabled = true;

        const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.55' },
            body: JSON.stringify({ email: 'owner@example.com', password: 'StrongPass!2026' })
        });
        expect(loginRes.status).toBe(200);
        const loginBody = await loginRes.json();
        expect(loginBody.requires2fa).toBe(true);
        expect(loginBody.methods).toEqual(['totp']);
        expect(loginBody.defaultMethod).toBe('totp');

        // Telegram login code sending must be rejected once TOTP-only mode is active
        const tgSendRes = await fetch(`${baseUrl}/api/admin/login/send-tg-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.55' },
            body: JSON.stringify({ challengeToken: loginBody.challengeToken })
        });
        expect(tgSendRes.status).toBe(400);

        totpEnabled = false;
        login2faMode = 'either';
    });

    it('rejects discontinued Pro plans on CDK verification, CDK generation, and Orbitcard binding', async () => {
        const verifyRes = await fetch(`${baseUrl}/api/verify-cdk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.56' },
            body: JSON.stringify({ cdk: 'KC-LEGACY-PRO200' })
        });
        expect(verifyRes.status).toBe(400);
        const verifyBody = await verifyRes.json();
        expect(verifyBody.success).toBe(false);
        expect(verifyBody.message).toContain('ChatGPT Plus');

        const validToken = adminAuth.issueAdminToken(passwordVersion, 'owner@example.com').token;
        const secToken = adminAuth.issueSecondaryToken(1).token;

        const genRes = await fetch(`${baseUrl}/api/admin/cdks/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${validToken}`
            },
            body: JSON.stringify({ count: 1, plan_type: 'pro200' })
        });
        expect(genRes.status).toBe(400);

        const bindRes = await fetch(`${baseUrl}/api/admin/orbitcard/cards/101/plan`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${validToken}`,
                'X-Admin-Secondary-Token': secToken
            },
            body: JSON.stringify({ plan_type: 'pro100', max_usage_count: 1 })
        });
        expect(bindRes.status).toBe(400);
    });

    it('tightens per-IP activation quota to 10 per 10 minutes and exposes admin cooldown inspection and clear endpoints', async () => {
        expect(ACTIVATION_FAILURE_THRESHOLD).toBe(3);
        expect(ACTIVATION_COOLDOWN_MINUTES).toBe(30);
        expect(PUBLIC_CDK_QUOTAS.activation).toEqual({ max: 10, windowMs: 10 * 60 * 1000 });

        // 10 activation requests from one IP consume the 10-min quota; 11th must return 429
        const ip = '203.0.113.211';
        for (let i = 0; i < 10; i += 1) {
            const res = await fetch(`${baseUrl}/api/run-process`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
                body: JSON.stringify({ cdk: '' })
            });
            expect(res.status).toBe(400);
        }
        const throttled = await fetch(`${baseUrl}/api/run-process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
            body: JSON.stringify({ cdk: '' })
        });
        expect(throttled.status).toBe(429);
        expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);

        // Cooldown admin routes reject unauthenticated requests
        const unauthRes = await fetch(`${baseUrl}/api/admin/activation-cooldowns`);
        expect(unauthRes.status).toBe(401);

        const validToken = adminAuth.issueAdminToken(passwordVersion, 'owner@example.com').token;

        // List active IP cooldowns
        const listRes = await fetch(`${baseUrl}/api/admin/activation-cooldowns`, {
            headers: { Authorization: `Bearer ${validToken}` }
        });
        expect(listRes.status).toBe(200);
        const listBody = await listRes.json();
        expect(listBody.success).toBe(true);
        expect(listBody.cooldowns).toHaveLength(1);
        expect(listBody.cooldowns[0].scopeKey).toBe('203.0.113.88');

        // Clear IP cooldown rejects invalid payload
        const badIpClear = await fetch(`${baseUrl}/api/admin/activation-cooldowns/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${validToken}` },
            body: JSON.stringify({ scope_type: 'ip', scope_key: '' })
        });
        expect(badIpClear.status).toBe(400);

        // Clear IP cooldown succeeds
        const okIpClear = await fetch(`${baseUrl}/api/admin/activation-cooldowns/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${validToken}` },
            body: JSON.stringify({ scope_type: 'ip', scope_key: '203.0.113.88' })
        });
        expect(okIpClear.status).toBe(200);
        expect(activeIpCooldowns).toHaveLength(0);

        // Clear CDK cooldown returns 404 for unknown CDK and 200 for existing CDK
        const missingCdkClear = await fetch(`${baseUrl}/api/admin/cdks/KC-NO-SUCH-CODE/clear-cooldown`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${validToken}` }
        });
        expect(missingCdkClear.status).toBe(404);

        const okCdkClear = await fetch(`${baseUrl}/api/admin/cdks/KC-COOLED-PLUS01/clear-cooldown`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${validToken}` }
        });
        expect(okCdkClear.status).toBe(200);
        expect(clearedCdks).toContain('KC-COOLED-PLUS01');
    });
});
