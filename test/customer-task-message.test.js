'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverSource.indexOf('const GPT_API_CUSTOMER_FAILURE_MESSAGE');
const end = serverSource.indexOf('function mapGptApiPlanKey', start);
if (start < 0 || end < 0) {
    throw new Error('无法从 server.js 提取客户任务消息清理函数');
}
const context = vm.createContext({});
vm.runInContext(
    `${serverSource.slice(start, end)}\nthis.sanitizeCustomerTaskMessage = sanitizeCustomerTaskMessage;`,
    context,
    { filename: 'customer-task-message-extract.js' }
);

const sanitizeCustomerTaskMessage = context.sanitizeCustomerTaskMessage;
const GENERIC_FAILURE_MESSAGE = '本次开通未完成，已转人工确认，请联系客服处理后再试';
const TIMEOUT_MESSAGE = '订单处理超时，已转人工确认，请联系客服处理后再试';

describe('customer task message sanitization', () => {
    it('hides provider submission details while preserving timeout and ordinary messages', () => {
        expect(sanitizeCustomerTaskMessage('代充提交失败 (HTTP 409): duplicate')).toBe(GENERIC_FAILURE_MESSAGE);
        expect(sanitizeCustomerTaskMessage('provider businessCode 40901')).toBe(GENERIC_FAILURE_MESSAGE);
        expect(sanitizeCustomerTaskMessage('Idempotency-Key conflict')).toBe(GENERIC_FAILURE_MESSAGE);
        expect(sanitizeCustomerTaskMessage(TIMEOUT_MESSAGE)).toBe(TIMEOUT_MESSAGE);
        expect(sanitizeCustomerTaskMessage('订单正在处理中')).toBe('订单正在处理中');
    });
});
