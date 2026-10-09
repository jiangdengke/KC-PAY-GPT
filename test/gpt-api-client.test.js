'use strict';

const axios = require('axios');
const client = require('../gpt-api-client');

describe('gpt api client', () => {
    afterEach(() => vi.restoreAllMocks());

    it('inspects the session before checkout using only documented fields', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { ok: true, verified: true, current_plan: 'Free' }
        });
        const out = await client.inspectPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            { planKey: 'plus', session: { accessToken: 'token', user: { email: 'user@example.com' } } }
        );
        expect(out.success).toBe(true);
        expect(spy.mock.calls[0][0].url).toBe('https://example.test/api/v1/pay/inspect');
        expect(spy.mock.calls[0][0].data).toEqual({
            plan_key: 'plus',
            session: { accessToken: 'token', user: { email: 'user@example.com' } }
        });
    });

    it('preserves structured unverified reasons', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                ok: false,
                verified: false,
                error: 'session_unverified',
                reason: 'cloudflare_challenge',
                upstream_status: 403
            }
        });
        const out = await client.inspectPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            { planKey: 'plus', sessionToken: 'token' }
        );
        expect(out).toMatchObject({
            success: false,
            error: 'session_unverified',
            reason: 'cloudflare_challenge',
            upstreamStatus: 403
        });
    });

    it('sends the protocol proxy field to pay', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { order_id: 1, task_id: 2 }
        });
        await client.submitPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            {
                planKey: 'plus',
                session: { accessToken: 'token', user: { email: 'user@example.com' } },
                newCard: { number: '4242', exp_month: 12, exp_year: 2030, cvc: '123' },
                proxy: 'http://ignored.example:8080',
                idempotencyKey: 'pay-1'
            }
        );
        expect(spy.mock.calls[0][0].data.proxy).toBe('http://ignored.example:8080');
        expect(spy.mock.calls[0][0].data.session.user.email).toBe('user@example.com');
    });
    it('parses the platform gpt plans array', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { gpt: [{ key: 'plus' }], credit: [] } });
        const out = await client.fetchPlans({ base_url: 'https://example.test/api/v1', api_key: 'gptk_test' });
        expect(out.plans).toEqual([{ key: 'plus' }]);
    });

    it('uses the business result status instead of queue done', () => {
        expect(client.extractStatus({ status: 'done', result: { ok: false, status: 'failed', error: 'cf_challenge_unresolved' } })).toBe('failed');
        expect(client.extractStatus({ status: 'done', result: { ok: true, status: 'success' } })).toBe('success');
    });

    it('formats provider queue and processing states for end users', () => {
        expect(client.formatProgressMessage({ status: 'pending', display_status: 'queued' }, 1))
            .toBe('订单已进入处理队列，等待处理（已查询 1 次）');
        expect(client.formatProgressMessage({ status: 'processing' }, 4))
            .toBe('订单正在处理中（已查询 4 次）');
        expect(client.formatProgressMessage({ status: 'running', queue_status: 'stalled' }, 2))
            .toBe('订单处理较慢，系统仍在等待结果（已查询 2 次）');
        expect(client.formatProgressMessage({ status: 'unknown' }, 3))
            .toBe('订单已提交，正在同步最新状态（已查询 3 次）');
        expect(client.formatProgressMessage({ status: 'pending', message: '正在等待银行确认' }, 2))
            .toBe('正在等待银行确认（已查询 2 次）');
    });

    it('normalizes multi-round captcha metadata and user-facing states', () => {
        const pending = client.extractCaptcha({
            stage: 'awaiting_captcha',
            captcha: {
                id: 'cap_1',
                status: 'pending',
                url: 'https://recharge.example/captcha#ticket',
                expires_at: '2026-09-13T15:00:00Z'
            }
        });
        expect(pending).toEqual({
            id: 'cap_1',
            status: 'pending',
            url: 'https://recharge.example/captcha#ticket',
            expiresAt: '2026-09-13T15:00:00Z'
        });
        expect(client.formatProgressMessage({
            stage: 'awaiting_captcha',
            captcha: pending
        })).toBe('需要完成人机验证，请点击页面中的验证按钮');
        expect(client.formatProgressMessage({
            stage: 'captcha_submitted',
            captcha: { ...pending, status: 'submitted', url: null }
        }, 2)).toBe('人机验证已提交，系统正在确认（已查询 2 次）');
    });

    it('sends documented client reference and saved-card fields', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { ok: true, already_submitted: true, order_id: 12, task_id: 34, topup_code: 'code-prefix...' }
        });
        const out = await client.submitPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            { planKey: 'plus', sessionToken: 'token', cardId: 8, cvc: '123', acceptWarnings: true, country: 'US', currency: 'USD', clientRef: 'kc-cdk-1', idempotencyKey: 'pay-1' }
        );
        expect(spy.mock.calls[0][0].data).toEqual({
            plan_key: 'plus',
            country: 'US',
            currency: 'USD',
            card_id: 8,
            cvc: '123',
            accept_warnings: true,
            client_ref: 'kc-cdk-1',
            session: { access_token: 'token' }
        });
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toBe('pay-1');
        expect(out).toMatchObject({ orderId: 12, taskId: 34, alreadySubmitted: true, topupCode: 'code-prefix...' });
    });

    it('separates GPT and credit plans and summarizes balance', async () => {
        vi.spyOn(axios, 'request')
            .mockResolvedValueOnce({ status: 200, data: { gpt: [{ key: 'plus' }], credit: [{ id: 2, credits: 100 }] } })
            .mockResolvedValueOnce({ status: 200, data: { credits: 980, balance: 1250, balance_usd: '12.50' } });
        const plans = await client.fetchPlans({ base_url: 'https://example.test/api/v1', api_key: 'gptk_test' });
        const balance = await client.queryBalance({ base_url: 'https://example.test/api/v1', api_key: 'gptk_test' });
        expect(plans).toMatchObject({ gptPlans: [{ key: 'plus' }], creditPlans: [{ id: 2, credits: 100 }] });
        expect(balance).toMatchObject({ credits: 980, balance: 1250, balanceUsd: '12.50' });
    });

    it('uses the Desolate Open account endpoint and X-API-Key auth', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 0, message: '成功', data: { accountId: 'usr_1', accountName: 'demo', email: 'demo@example.com', availablePoints: 20 } }
        });
        const out = await client.queryAccount({ base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' });
        expect(out).toMatchObject({ success: true, availablePoints: 20 });
        expect(spy.mock.calls[0][0]).toMatchObject({
            url: 'https://recharge.desolate.run/api/v1/open/account',
            headers: { 'X-API-Key': 'ap_live_test' }
        });
        expect(spy.mock.calls[0][0].headers.Authorization).toBeUndefined();
    });

    it('normalizes all supported Desolate Open base URL forms', () => {
        expect(client.resolveBaseUrl({ base_url: 'https://recharge.desolate.run' })).toBe('https://recharge.desolate.run/api/v1/open');
        expect(client.resolveBaseUrl({ base_url: 'https://recharge.desolate.run/api/v1' })).toBe('https://recharge.desolate.run/api/v1/open');
        expect(client.resolveBaseUrl({ base_url: 'https://recharge.desolate.run/api/v1/open' })).toBe('https://recharge.desolate.run/api/v1/open');
        expect(client.resolveOpenPlanCode('plus')).toBe('chatgptplusplan');
    });

    it('reports all Desolate Open plan mappings during connection tests', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 0, message: '成功', data: { accountId: 'usr_1', availablePoints: 20 } }
        });
        const out = await client.testConnection({
            base_url: 'https://recharge.desolate.run',
            api_key: 'ap_live_test',
            plan_key: 'chatgptplusplan'
        });
        expect(out.planMappings).toEqual({
            plus: 'chatgptplusplan',
            pro100: null,
            pro200: null,
            pro500: null
        });
        expect(out.message).toContain('Pro 100=未配置');
        expect(out.message).toContain('Pro 200=未配置');
        expect(out.message).toContain('Pro 500=未配置');
    });

    it('requires explicit Desolate mappings for Pro tiers and rejects legacy or unknown plan types', () => {
        expect(() => client.resolveOpenPlanCode('pro100')).toThrow(/Pro 100.*未配置/);
        expect(client.resolveOpenPlanCode('pro100', {
            plan_mappings: { pro100: 'operator-confirmed-pro100' }
        })).toBe('operator-confirmed-pro100');
        expect(() => client.resolveOpenPlanCode('pro_5x')).toThrow(/必须是 plus \/ pro100 \/ pro200 \/ pro500/);
        expect(() => client.resolveOpenPlanCode('not-a-plan')).toThrow(/必须是 plus \/ pro100 \/ pro200 \/ pro500/);
    });

    it('maps the Desolate Open order fields and unwraps its response envelope', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 201,
            data: { code: 0, message: '成功', data: { orderId: 'ord_abc', status: 'pending', targetEmail: 'demo@example.com', planCode: 'chatgptplusplan', createdAt: '2026-09-03T00:00:00Z' } }
        });
        const session = {
            user: { id: 'user_1', email: 'demo@example.com' },
            account: { id: 'acct_1' },
            accessToken: 'aaa.bbb.ccc',
            sessionToken: 'opaque-cookie-token',
            expires: '2099-12-31T00:00:00Z'
        };
        const out = await client.submitPay(
            { base_url: 'https://recharge.desolate.run/api/v1/open', api_key: 'ap_live_test' },
            { planKey: 'chatgptplusplan', session, idempotencyKey: 'job-abc', newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' } }
        );
        expect(out).toMatchObject({ success: true, orderId: 'ord_abc', taskId: null });
        expect(spy.mock.calls[0][0].url).toBe('https://recharge.desolate.run/api/v1/open/orders');
        expect(spy.mock.calls[0][0].data).toEqual({
            planCode: 'chatgptplusplan',
            cardNumber: '4242424242424242',
            expiryMonth: 12,
            expiryYear: 2032,
            securityCode: '123',
            session
        });
        expect(spy.mock.calls[0][0].data.clientRequestId).toBeUndefined();
        expect(spy.mock.calls[0][0].data.clientRef).toBeUndefined();
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
        expect(spy.mock.calls[0][0].headers['X-Request-ID']).toBeUndefined();
    });

    it('derives stable UUID idempotency headers from Desolate seeds', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 201,
            data: { code: 0, data: { orderId: 'ord_abc' } }
        });
        const cfg = { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' };
        const input = {
            planKey: 'chatgptplusplan',
            session: {
                user: { id: 'user_1', email: 'demo@example.com' },
                account: { id: 'acct_1' },
                accessToken: 'aaa.bbb.ccc',
                sessionToken: 'opaque-cookie-token',
                expires: '2099-12-31T00:00:00Z'
            },
            newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' }
        };

        await client.submitPay(cfg, { ...input, idempotencyKey: 'stable-seed' });
        await client.submitPay(cfg, { ...input, idempotencyKey: 'stable-seed' });
        await client.submitPay(cfg, { ...input, idempotencyKey: 'different-seed' });

        const keys = spy.mock.calls.map(([request]) => request.headers['Idempotency-Key']);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).not.toBe(keys[2]);
        expect(keys.every((key) => /^[0-9a-f]{8}-[0-9a-f]{4}-[5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))).toBe(true);
    });

    it('preserves a valid Desolate UUID idempotency key unchanged', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 201,
            data: { code: 0, data: { orderId: 'ord_uuid' } }
        });
        const validUuid = '123e4567-e89b-12d3-a456-426614174000';
        await client.submitPay(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            {
                planKey: 'chatgptplusplan',
                session: {
                    user: { id: 'user_1', email: 'demo@example.com' },
                    account: { id: 'acct_1' },
                    accessToken: 'aaa.bbb.ccc',
                    sessionToken: 'opaque-cookie-token',
                    expires: '2099-12-31T00:00:00Z'
                },
                idempotencyKey: validUuid,
                newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' }
            }
        );
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toBe(validUuid);
    });

    it('keeps the legacy protocol Idempotency-Key behavior', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { order_id: 'legacy-order', task_id: 'legacy-task' }
        });
        await client.submitPay(
            { base_url: 'https://example.test/api/v1', api_key: 'gptk_test' },
            {
                planKey: 'plus',
                sessionToken: 'token',
                cardId: 8,
                cvc: '123',
                idempotencyKey: 'legacy-seed'
            }
        );
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toBe('legacy-seed');
    });

    it('omits the optional Desolate idempotency header when no stable seed is supplied', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 201,
            data: { code: 0, data: { orderId: 'ord_without_key' } }
        });
        await client.submitPay(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            {
                planKey: 'chatgptplusplan',
                session: {
                    user: { id: 'user_1', email: 'demo@example.com' },
                    account: { id: 'acct_1' },
                    accessToken: 'aaa.bbb.ccc',
                    sessionToken: 'opaque-cookie-token',
                    expires: '2099-12-31T00:00:00Z'
                },
                newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' }
            }
        );
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toBeUndefined();
    });

    it('uses clientRef as a deterministic Desolate seed when the explicit key is blank', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 201,
            data: { code: 0, data: { orderId: 'ord_client_ref' } }
        });
        const input = {
            planKey: 'chatgptplusplan',
            session: {
                user: { id: 'user_1', email: 'demo@example.com' },
                account: { id: 'acct_1' },
                accessToken: 'aaa.bbb.ccc',
                sessionToken: 'opaque-cookie-token',
                expires: '2099-12-31T00:00:00Z'
            },
            idempotencyKey: '   ',
            clientRef: 'stable-client-ref',
            newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' }
        };
        const cfg = { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' };

        await client.submitPay(cfg, input);
        await client.submitPay(cfg, input);

        const keys = spy.mock.calls.map(([request]) => request.headers['Idempotency-Key']);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('preserves Desolate duplicate request business code 40005', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 40005, message: '重复请求', data: null }
        });
        const out = await client.submitPay(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            {
                planKey: 'chatgptplusplan',
                session: {
                    user: { id: 'user_1', email: 'demo@example.com' },
                    account: { id: 'acct_1' },
                    accessToken: 'aaa.bbb.ccc',
                    sessionToken: 'opaque-cookie-token',
                    expires: '2099-12-31T00:00:00Z'
                },
                idempotencyKey: 'same-job',
                newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' }
            }
        );
        expect(out).toMatchObject({ success: false, businessCode: 40005, error: '重复请求' });
    });

    it('preserves HTTP 422 validation details for Desolate order failures', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 422,
            data: {
                detail: [{
                    type: 'extra_forbidden',
                    loc: ['body', 'clientRequestId'],
                    msg: 'Extra inputs are not permitted'
                }]
            }
        });
        const out = await client.submitPay(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            {
                planKey: 'chatgptplusplan',
                session: {
                    user: { id: 'user_1', email: 'demo@example.com' },
                    account: { id: 'acct_1' },
                    accessToken: 'aaa.bbb.ccc',
                    sessionToken: 'opaque-cookie-token',
                    expires: '2099-12-31T00:00:00Z'
                },
                idempotencyKey: 'same-job',
                newCard: { number: '4242424242424242', exp_month: 12, exp_year: 2032, cvc: '123' }
            }
        );
        expect(out).toMatchObject({ success: false, status: 422 });
        expect(out.error).toContain('Extra inputs are not permitted');
    });

    it('requires code zero for Desolate Open API success', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 40022, message: '套餐代码无效', data: null }
        });
        const out = await client.queryAccount({ base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' });
        expect(out.success).toBe(false);
        expect(out.error).toBe('套餐代码无效');
    });

    it('unwraps Desolate Open order status and preserves Retry-After', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            headers: { 'retry-after': '7' },
            data: {
                code: 0,
                message: '成功',
                data: {
                    orderId: 'ord_abc',
                    status: 'succeeded',
                    targetEmail: 'demo@example.com',
                    planCode: 'chatgptplusplan',
                    subscriptionCancelled: true,
                    createdAt: '2026-09-03T00:00:00Z',
                    updatedAt: '2026-09-03T00:01:00Z'
                }
            }
        });
        const out = await client.queryOrder(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            'ord_abc'
        );
        expect(out).toMatchObject({ success: true, rawStatus: 'succeeded', retryAfterMs: 7000 });
        expect(out.data.subscriptionCancelled).toBe(true);
        expect(spy.mock.calls[0][0].url).toBe('https://recharge.desolate.run/api/v1/open/orders/ord_abc');
    });

    it('preserves a readable order message for the standard task timeline', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                code: 0,
                message: '上游订单处理中，请稍候',
                data: { orderId: 'ord_message', status: 'pending' }
            }
        });
        const out = await client.queryOrder(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            'ord_message'
        );
        expect(out.message).toBe('上游订单处理中，请稍候');
        expect(client.extractProviderMessage({ message: '成功' }, '成功')).toBe('');
    });

    it('returns captcha and stage from a Desolate Open order status', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                code: 0,
                data: {
                    orderId: 'ord_captcha',
                    status: 'pending',
                    stage: 'awaiting_captcha',
                    captcha: {
                        id: 'cap_2',
                        status: 'pending',
                        url: 'https://recharge.example/captcha#ticket'
                    }
                }
            }
        });
        const out = await client.queryOrder(
            { base_url: 'https://recharge.desolate.run', api_key: 'ap_live_test' },
            'ord_captcha'
        );
        expect(out).toMatchObject({
            rawStatus: 'pending',
            stage: 'awaiting_captcha',
            captcha: {
                id: 'cap_2',
                status: 'pending',
                url: 'https://recharge.example/captcha#ticket'
            }
        });
    });

});
