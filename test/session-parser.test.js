'use strict';

const sessionParser = require('../src/utils/session-parser');

function createJwt(header, payload) {
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${h}.${p}.sig`;
}

function buildValidAccessToken(overrides = {}) {
    return createJwt(
        { typ: 'JWT', alg: 'RS256' },
        {
            iss: 'https://auth.openai.com',
            aud: ['https://api.openai.com/v1'],
            scp: ['model.request', 'openid'],
            exp: Math.floor(Date.now() / 1000) + 3600,
            'https://api.openai.com/auth': {
                chatgpt_account_id: 'acct_parser_1',
                chatgpt_user_id: 'user_parser_1'
            },
            'https://api.openai.com/profile': {
                email: 'Parser@Example.com'
            },
            ...overrides
        }
    );
}

describe('session-parser', () => {
    it('validates a well-formed OpenAI access token and rejects invalid ones', () => {
        const validToken = buildValidAccessToken();
        expect(sessionParser.validateAccessToken(validToken)).toEqual({
            valid: true,
            message: 'AccessToken 校验通过',
            email: 'Parser@Example.com'
        });

        expect(sessionParser.validateAccessToken('').valid).toBe(false);
        expect(sessionParser.validateAccessToken('bad.token').valid).toBe(false);
        expect(sessionParser.validateAccessToken(buildValidAccessToken({ exp: 100 })).valid).toBe(false);
        expect(sessionParser.validateAccessToken(buildValidAccessToken({ scp: ['openid'] })).valid).toBe(false);
        expect(sessionParser.validateAccessToken(buildValidAccessToken({ aud: ['https://other.example'] })).valid).toBe(false);
    });

    it('parses session JSON, resolves raw JWT input, and preserves opaque fields', () => {
        const token = buildValidAccessToken();
        const rawJson = JSON.stringify({
            user: { email: 'user@example.com' },
            accessToken: token,
            opaqueFlag: 'keep-me'
        });

        const parsed = sessionParser.parseSessionJson(`\uFEFF ${rawJson}`);
        expect(parsed).toMatchObject({ accessToken: token, opaqueFlag: 'keep-me' });

        const resolvedFromJson = sessionParser.resolveSessionInput(rawJson);
        expect(resolvedFromJson.accessToken).toBe(token);
        expect(resolvedFromJson.sessionData.opaqueFlag).toBe('keep-me');

        const resolvedFromJwt = sessionParser.resolveSessionInput(`token=${token}`);
        expect(resolvedFromJwt.accessToken).toBe(token);
        expect(resolvedFromJwt.sessionData.user.email).toBe('Parser@Example.com');

        const stored = JSON.parse(sessionParser.buildStoredSessionPayload('', { user: { email: 'u@e.com' } }, token));
        expect(stored.accessToken).toBe(token);
    });

    it('derives stable activation account keys with accountId > email > token hash priority', () => {
        const token = buildValidAccessToken();
        expect(sessionParser.getActivationAccountKey({ account: { id: 'Acct_XYZ' }, user: { email: 'a@b.com' } }, token))
            .toBe('acct:acct_xyz');
        expect(sessionParser.getActivationAccountKey({ user: { email: 'Alice@Example.com' } }, 'raw-token'))
            .toBe('email:alice@example.com');
        expect(sessionParser.getActivationAccountKey({}, 'opaque-token'))
            .toMatch(/^token:[0-9a-f]{32}$/);
    });
});
