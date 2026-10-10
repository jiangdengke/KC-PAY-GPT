'use strict';

const {
    buildGptApiFailureDiagnostic,
    redactSensitiveText
} = require('../gpt-api-failure');
const { formatTelegramMessage } = require('../telegram-notify');

describe('GPT API admin failure diagnostics', () => {
    it('uses the Open provider reason as Telegram detail while keeping diagnostic metadata', () => {
        const diagnostic = buildGptApiFailureDiagnostic({
            openProtocol: true,
            raw: {
                status: 'failed',
                failureCode: 'EXISTING_SUBSCRIPTION_NOT_OURS',
                failureMessage: 'Account has an existing subscription or recent payment.'
            },
            rawStatus: 'failed',
            orderId: 'ord_open_1',
            status: 'failed',
            requestId: 'req-open-1',
            responseMeta: { requestId: 'req-open-1' },
            pollCount: 3
        });
        const message = formatTelegramMessage('failure', {
            email: 'user@example.com',
            planType: 'pro100',
            cdk: 'KC-TEST',
            jobKey: 'job-open-1',
            message: '本次开通未完成，已转人工确认，请联系客服处理后再试',
            diagnostic
        });

        expect(message).toContain('详情: Account has an existing subscription or recent payment.');
        expect(message).not.toContain('详情: 本次开通未完成');
        expect(message).not.toContain('失败原因:');
        expect(message).toContain('失败代码: EXISTING_SUBSCRIPTION_NOT_OURS');
        expect(message).toContain('订单: ord_open_1');
        expect(message).toContain('状态: failed');
        expect(message).toContain('请求 ID: req-open-1');
        expect(message).toContain('查询次数: 3');
    });

    it('extracts legacy provider errors and keeps absent code/message explicit', () => {
        const legacy = buildGptApiFailureDiagnostic({
            raw: {
                status: 'failed',
                result: { ok: false, status: 'failed', error: 'cf_challenge_unresolved', errorCode: 'CAPTCHA_FAILED' }
            },
            rawStatus: 'failed',
            orderId: 'legacy-order'
        });
        expect(legacy).toMatchObject({
            reason: 'cf_challenge_unresolved',
            code: 'CAPTCHA_FAILED',
            orderId: 'legacy-order',
            status: 'failed'
        });

        const missing = buildGptApiFailureDiagnostic({ rawStatus: 'failed' });
        expect(missing.reason).toBe('原因缺失（第三方未提供失败原因）');
        expect(missing.code).toBe('未提供');
        expect(missing.orderId).toBe('');
        expect(missing.status).toBe('failed');
    });

    it('describes poll-cap timeout with known order, status, and count', () => {
        const diagnostic = buildGptApiFailureDiagnostic({
            raw: { status: 'processing' },
            rawStatus: 'processing',
            orderId: 'ord-timeout',
            status: 'processing',
            requestId: 'req-timeout',
            pollCount: 120,
            timeout: true
        });
        const message = formatTelegramMessage('failure', {
            message: '订单处理超时，已转人工确认，请联系客服处理后再试',
            diagnostic
        });
        expect(message).toContain('详情: 轮询超时：已查询 120 次，订单未进入终态');
        expect(message).toContain('失败代码: POLL_TIMEOUT');
        expect(message).toContain('订单: ord-timeout');
        expect(message).toContain('状态: processing');
        expect(message).toContain('请求 ID: req-timeout');
    });

    it('prefers the current caught provider error over a stale processing message', () => {
        const error = new Error('Request failed with status code 503');
        error.providerMessage = 'Account has an existing subscription or recent payment.';
        const diagnostic = buildGptApiFailureDiagnostic({
            openProtocol: true,
            raw: { status: 'processing', message: '处理中' },
            rawStatus: 'processing',
            orderId: 'ord-catch',
            status: 'processing',
            error
        });

        expect(diagnostic.reason).toBe('Account has an existing subscription or recent payment.');
        expect(diagnostic.status).toBe('processing');
        expect(diagnostic.status).not.toBe('503');
    });

    it('redacts complete authorization, cookie, token, captcha, card, and CVV values', () => {
        const source = [
            'Authorization: Bearer opaque-value',
            'authorization="Basic quoted credential with spaces"',
            'Cookie: sid=cookie-secret; refresh=refresh-secret',
            'access_token="access secret" sessionToken=session-secret refreshToken=refresh-token',
            'apiKey=api-secret client_secret="client secret" securityCode=321 cvc=123 cvv=999',
            'cardNumber=4111111111111111 captchaUrl=https://provider.invalid/captcha?ticket=captcha-secret'
        ].join('\n');
        const redacted = redactSensitiveText(source, 1000);

        for (const secret of [
            'opaque-value',
            'quoted credential with spaces',
            'cookie-secret',
            'refresh-secret',
            'access secret',
            'session-secret',
            'refresh-token',
            'api-secret',
            'synthetic-secret',
            'client secret',
            '321',
            '123',
            '999',
            '4111111111111111',
            'captcha-secret'
        ]) {
            expect(redacted).not.toContain(secret);
        }
        expect(redacted).toContain('Authorization=[已隐藏]');
        expect(redacted).toContain('Cookie=[已隐藏]');
        expect(redactSensitiveText({ accessToken: 'object-secret' })).toBe('');
    });

    it('redacts a generic token field and preserves an ordinary bracket-prefixed error', () => {
        expect(redactSensitiveText('token=synthetic-secret')).toBe('token=[已隐藏]');

        const diagnostic = buildGptApiFailureDiagnostic({
            error: new Error('[ECONNRESET] connection reset')
        });
        expect(diagnostic.reason).toContain('[ECONNRESET] connection reset');
        expect(diagnostic.reason).not.toBe('原因缺失（第三方未提供失败原因）');
    });

    it('extracts only allowlisted text from a serialized error payload', () => {
        const error = new Error('代充提交失败: {"message":"Account has an existing subscription or recent payment.","accessToken":"object-secret","cardNumber":"4111111111111111","session":{"sessionToken":"nested-secret"}}');
        const diagnostic = buildGptApiFailureDiagnostic({
            openProtocol: true,
            raw: { status: 'processing', message: '处理中' },
            rawStatus: 'processing',
            error
        });

        expect(diagnostic.reason).toContain('Account has an existing subscription or recent payment.');
        expect(diagnostic.reason).not.toContain('object-secret');
        expect(diagnostic.reason).not.toContain('4111111111111111');
        expect(diagnostic.reason).not.toContain('nested-secret');
        expect(diagnostic.reason.length).toBeLessThanOrEqual(240);
    });

    it('keeps the old detail fallback and does not add diagnostics to success notifications', () => {
        const failure = formatTelegramMessage('failure', {
            message: '本次开通未完成，已转人工确认，请联系客服处理后再试'
        });
        expect(failure).toContain('详情: 本次开通未完成，已转人工确认，请联系客服处理后再试');

        const success = formatTelegramMessage('success', {
            message: '开通成功',
            diagnostic: {
                reason: 'should-not-be-shown',
                code: 'SHOULD_NOT_BE_SHOWN'
            }
        });
        expect(success).toContain('详情: 开通成功');
        expect(success).not.toContain('should-not-be-shown');
        expect(success).not.toContain('SHOULD_NOT_BE_SHOWN');
    });
});
