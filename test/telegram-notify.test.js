'use strict';

const { formatTelegramMessage } = require('../telegram-notify');
const { extractEmailFromSession } = require('../session-auth');

describe('telegram task notifications', () => {
    it('includes the account and selected plan in task messages', () => {
        const message = formatTelegramMessage('success', {
            email: 'user@example.com',
            planType: 'pro_20x',
            cdk: 'KC-TEST',
            jobKey: 'job-test',
            message: '第三方代充开通成功'
        });
        expect(message).toContain('账号: user@example.com');
        expect(message).toContain('套餐: ChatGPT Pro 20x');
        expect(message).toContain('CDK: KC-TEST');
    });

    it('extracts email from an object Session payload', () => {
        expect(extractEmailFromSession({
            user: { email: 'plus@example.com' },
            accessToken: 'not-a-jwt'
        })).toBe('plus@example.com');
    });
});
