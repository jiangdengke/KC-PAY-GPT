'use strict';

const {
    MAX_REASON_LENGTH,
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

    it('preserves ordinary URLs while hiding explicit credential-bearing query and fragment keys', () => {
        const ordinaryUrl = 'http://api.example.com/orders/view?orderId=1234567890123456&requestId=req-123&errorCode=40013&statusCode=422';
        const source = [
            'Docs: https://recharge.desolate.run/api/v1/openapi.yaml',
            `Order: ${ordinaryUrl}`,
            'Userinfo: https://operator:password@example.com/orders/1',
            'Encoded query: https://example.com/callback?access%5Ftoken=query-secret',
            'Encoded fragment: https://example.com/#/done?security%5Fcode=fragment-secret',
            'JWT: https://example.com/callback?value=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
            'Captcha: https://example.com/captcha/challenge-1',
            'Card number: https://example.com/pay?cardNumber=4111111111111111',
            'Encoded card number: https://example.com/pay?card%5Fnumber=4111111111111111',
            'PAN: https://example.com/pay?PAN=4111111111111111',
            'Card verification: https://example.com/#/pay?cvv=123&cvc=456',
            'Password hash: https://example.com/reset?passwordHash=hash-secret',
            'Auth code: https://example.com/callback?authCode=auth-secret'
        ].join('\n');
        const redacted = redactSensitiveText(source, MAX_REASON_LENGTH);

        expect(redacted).toContain('https://recharge.desolate.run/api/v1/openapi.yaml');
        expect(redacted).toContain(ordinaryUrl);
        expect(redacted.match(/\[已隐藏链接\]/g)).toHaveLength(10);
        expect(redacted).toContain('PAN=[已隐藏]');
        for (const secret of [
            'operator:password',
            'query-secret',
            'fragment-secret',
            'eyJhbGciOiJIUzI1NiJ9',
            '/captcha/challenge-1',
            '4111111111111111',
            'cvv=123',
            'cvc=456',
            'hash-secret',
            'auth-secret'
        ]) {
            expect(redacted).not.toContain(secret);
        }
    });

    it('redacts encoded credential pairs in URL queries and route fragments', () => {
        const credentialUrls = [
            'https://example.invalid/callback?token%3DSYNTHETIC_ONLY',
            'https://example.invalid/callback?orderId%3Dord-1%26token%3DSYNTHETIC_ONLY',
            'https://example.invalid/callback#token%3DSYNTHETIC_ONLY',
            'https://example.invalid/callback#/done%3ForderId%3Dord-1%26token%3DSYNTHETIC_ONLY',
            'https://example.invalid/callback?orderId%253Dord-1%2526token%253DSYNTHETIC_ONLY'
        ];
        for (const url of credentialUrls) {
            const redacted = redactSensitiveText(url, MAX_REASON_LENGTH);
            expect(redacted).toBe('[已隐藏链接]');
            expect(redacted).not.toContain('SYNTHETIC_ONLY');
        }

        const ordinaryUrls = [
            'https://example.invalid/docs?orderId=1234567890123456&errorCode=40013',
            'https://example.invalid/docs/orderId%3D1234567890123456%26errorCode%3D40013',
            'https://example.invalid/docs?example=orderId%3D1234567890123456%26errorCode%3D40013',
            'https://example.invalid/#/docs%3ForderId%3D1234567890123456%26errorCode%3D40013'
        ];
        for (const url of ordinaryUrls) {
            expect(redactSensitiveText(url, MAX_REASON_LENGTH)).toBe(url);
        }
    });

    it('preserves ordinary URLs through the builder and HTML formatter', () => {
        const ordinaryUrl = 'http://api.example.com/orders/view?orderId=1234567890123456&requestId=req-123&errorCode=40013&statusCode=422';
        const diagnostic = buildGptApiFailureDiagnostic({
            providerReason: `Provider details: ${ordinaryUrl}`,
            providerCode: '40013',
            orderId: '1234567890123456',
            requestId: 'req-123',
            status: 'failed'
        });
        const message = formatTelegramMessage('failure', { diagnostic });

        expect(diagnostic.reason).toContain(ordinaryUrl);
        expect(message).toContain('http://api.example.com/orders/view?orderId=1234567890123456&amp;requestId=req-123&amp;errorCode=40013&amp;statusCode=422');
        expect(message).toContain('失败代码: 40013');
        expect(message).toContain('订单: 1234567890123456');
        expect(message).toContain('请求 ID: req-123');
    });

    it('shares the 1600-character provider reason bound across builder and formatter', () => {
        const longReason = 'R'.repeat(MAX_REASON_LENGTH + 200);
        const expectedReason = `${'R'.repeat(MAX_REASON_LENGTH - 1)}…`;
        const diagnostic = buildGptApiFailureDiagnostic({
            providerReason: longReason,
            providerCode: 'PROVIDER_FAILURE',
            orderId: 'ord-long-reason',
            status: 'failed'
        });
        const message = formatTelegramMessage('failure', {
            email: 'user@example.com',
            planType: 'pro500',
            message: 'fallback',
            diagnostic
        });

        expect(MAX_REASON_LENGTH).toBe(1600);
        expect(diagnostic.reason).toBe(expectedReason);
        expect(diagnostic.reason).toHaveLength(MAX_REASON_LENGTH);
        expect(message).toContain(`详情: ${expectedReason}`);
        expect(message).not.toContain(longReason);
        expect(message.length).toBeLessThan(4096);
    });

    it('preserves numeric diagnostic identifiers while still redacting explicit credentials', () => {
        const diagnostic = buildGptApiFailureDiagnostic({
            providerReason: 'Payment card 4111111111111111 was rejected',
            providerCode: '4001312345678901',
            orderId: '1234567890123456',
            requestId: '6543210987654321',
            status: '1234567890123456'
        });
        const message = formatTelegramMessage('failure', { diagnostic });

        expect(diagnostic.reason).toBe('Payment card [已隐藏卡号] was rejected');
        expect(diagnostic.code).toBe('4001312345678901');
        expect(diagnostic.orderId).toBe('1234567890123456');
        expect(diagnostic.requestId).toBe('6543210987654321');
        expect(diagnostic.status).toBe('1234567890123456');
        expect(message).toContain('失败代码: 4001312345678901');
        expect(message).toContain('订单: 1234567890123456');
        expect(message).toContain('请求 ID: 6543210987654321');
        expect(message).toContain('状态: 1234567890123456');

        const explicitSecret = buildGptApiFailureDiagnostic({
            providerCode: 'errorCode=40013, passwordHash=code-secret',
            orderId: 'orderId=1234567890123456, PAN=4111111111111111',
            requestId: 'requestId=req-123, cvv=123',
            status: 'statusCode=422, authCode=status-secret'
        });
        expect(explicitSecret.code).toBe('errorCode=40013, passwordHash=[已隐藏]');
        expect(explicitSecret.orderId).toBe('orderId=1234567890123456, PAN=[已隐藏]');
        expect(explicitSecret.requestId).toBe('requestId=req-123, cvv=[已隐藏]');
        expect(explicitSecret.status).toBe('statusCode=422, authCode=[已隐藏]');

        const explicitSecretMessage = formatTelegramMessage('failure', { diagnostic: explicitSecret });
        expect(explicitSecretMessage).toContain('失败代码: errorCode=40013, passwordHash=[已隐藏]');
        expect(explicitSecretMessage).toContain('订单: orderId=1234567890123456, PAN=[已隐藏]');
        expect(explicitSecretMessage).toContain('请求 ID: requestId=req-123, cvv=[已隐藏]');
        expect(explicitSecretMessage).toContain('状态: statusCode=422, authCode=[已隐藏]');
        expect(explicitSecretMessage).not.toContain('code-secret');
        expect(explicitSecretMessage).not.toContain('4111111111111111');
        expect(explicitSecretMessage).not.toContain('cvv=123');
        expect(explicitSecretMessage).not.toContain('status-secret');
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
        expect(diagnostic.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
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
