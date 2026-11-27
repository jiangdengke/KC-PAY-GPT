'use strict';

const {
    GPT_API_CUSTOMER_FAILURE_MESSAGE,
    GPT_API_CUSTOMER_TIMEOUT_MESSAGE,
    sanitizeCustomerTaskMessage
} = require('../src/utils/task-messages');

describe('customer task message sanitization', () => {
    it('hides provider submission details while preserving timeout and ordinary messages', () => {
        expect(sanitizeCustomerTaskMessage('代充提交失败 (HTTP 409): duplicate')).toBe(GPT_API_CUSTOMER_FAILURE_MESSAGE);
        expect(sanitizeCustomerTaskMessage('provider businessCode 40901')).toBe(GPT_API_CUSTOMER_FAILURE_MESSAGE);
        expect(sanitizeCustomerTaskMessage('Idempotency-Key conflict')).toBe(GPT_API_CUSTOMER_FAILURE_MESSAGE);
        expect(sanitizeCustomerTaskMessage(GPT_API_CUSTOMER_TIMEOUT_MESSAGE)).toBe(GPT_API_CUSTOMER_TIMEOUT_MESSAGE);
        expect(sanitizeCustomerTaskMessage('订单正在处理中')).toBe('订单正在处理中');
    });
});
