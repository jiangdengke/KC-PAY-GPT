'use strict';

const axios = require('axios');
const subscription = require('../src/services/subscription-check');

function makeJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.signature`;
}

function buildValidToken(overrides = {}) {
    return makeJwt({
        iss: 'https://auth.openai.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/profile': { email: 'sub@example.com' },
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test_123' },
        ...overrides
    });
}

function buildAccountPayload({ hasActive = true, plan = 'plus', willRenew = true, origin = 'chatgpt_web' } = {}) {
    return {
        accounts: {
            default: {
                account: {
                    account_id: 'acct_test_123',
                    has_previously_paid_subscription: hasActive
                },
                entitlement: {
                    has_active_subscription: hasActive,
                    subscription_plan: plan,
                    expires_at: '2027-01-01T00:00:00Z'
                },
                last_active_subscription: {
                    purchase_origin_platform: origin,
                    will_renew: willRenew,
                    billing_currency: 'usd',
                    expires_at: '2027-01-01T00:00:00Z'
                }
            }
        }
    };
}

describe('subscription-check (pure axios + ProxyAgent)', () => {
    beforeEach(() => {
        vi.spyOn(axios, 'request').mockImplementation(() => {
            throw new Error('unexpected axios.request');
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('validates session tokens cleanly', () => {
        expect(subscription.validateSessionTokenForQuery('').valid).toBe(false);
        expect(subscription.validateSessionTokenForQuery('not-a-jwt').valid).toBe(false);
        expect(subscription.validateSessionTokenForQuery(buildValidToken({ exp: 1000 })).valid).toBe(false);
        expect(subscription.validateSessionTokenForQuery(buildValidToken({ iss: 'https://evil.example' })).valid).toBe(false);

        const ok = subscription.validateSessionTokenForQuery(buildValidToken());
        expect(ok).toEqual({
            valid: true,
            email: 'sub@example.com',
            accountId: 'acct_test_123'
        });
    });

    it('queries subscription via proxy and falls back to direct request when proxy fails', async () => {
        const calls = [];
        axios.request.mockImplementation(async (config) => {
            calls.push(config);
            if (config.httpsAgent) {
                throw new Error('proxy connect ECONNREFUSED');
            }
            return {
                status: 200,
                data: buildAccountPayload({ hasActive: true, plan: 'pro200', willRenew: true })
            };
        });

        const result = await subscription.querySubscriptionBySession(buildValidToken(), {
            proxy: 'http://user:pass@127.0.0.1:8080',
            timezoneOffsetMin: 480
        });

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            email: 'sub@example.com',
            accountId: 'acct_test_123',
            planKey: 'pro200',
            plan: 'ChatGPT Pro 200',
            currency: 'USD',
            autoRenew: '是',
            autoRenewRaw: true
        });
        expect(calls).toHaveLength(2);
        expect(calls[0].httpsAgent).toBeDefined();
        expect(calls[1].httpsAgent).toBeUndefined();
    });

    it('maps 401 and Cloudflare 403 responses to clear errors', async () => {
        axios.request.mockResolvedValueOnce({ status: 401, data: { detail: 'unauthorized' } });
        const unauth = await subscription.querySubscriptionBySession(buildValidToken());
        expect(unauth).toMatchObject({ ok: false, statusCode: 401 });

        axios.request.mockResolvedValueOnce({ status: 403, data: '<html>Just a moment... cf-ray</html>' });
        const cfBlocked = await subscription.querySubscriptionBySession(buildValidToken());
        expect(cfBlocked).toMatchObject({ ok: false, statusCode: 403 });
        expect(cfBlocked.error).toContain('Cloudflare');
    });

    it('cancels and resumes auto-renew while blocking App Store subscriptions', async () => {
        axios.request.mockResolvedValueOnce({
            status: 200,
            data: buildAccountPayload({ origin: 'apple_app_store', willRenew: true })
        });
        const appleCancel = await subscription.cancelAutoRenew(buildValidToken());
        expect(appleCancel).toMatchObject({ ok: false, statusCode: 400 });
        expect(appleCancel.error).toContain('Apple App Store');

        axios.request
            .mockResolvedValueOnce({ status: 200, data: buildAccountPayload({ willRenew: true }) })
            .mockResolvedValueOnce({ status: 200, data: { ok: true } })
            .mockResolvedValueOnce({ status: 200, data: buildAccountPayload({ willRenew: false }) });

        const cancelled = await subscription.cancelAutoRenew(buildValidToken());
        expect(cancelled.ok).toBe(true);
        expect(cancelled.data).toMatchObject({ cancelled: true, autoRenewRaw: false });

        axios.request
            .mockResolvedValueOnce({ status: 200, data: buildAccountPayload({ willRenew: false }) })
            .mockResolvedValueOnce({ status: 200, data: { ok: true } })
            .mockResolvedValueOnce({ status: 200, data: buildAccountPayload({ willRenew: true }) });

        const resumed = await subscription.resumeAutoRenew(buildValidToken());
        expect(resumed.ok).toBe(true);
        expect(resumed.data).toMatchObject({ resumed: true, autoRenewRaw: true });
    });
});
