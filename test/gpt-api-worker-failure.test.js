'use strict';

const { createGptApiWorker } = require('../src/services/gpt-api-worker');
const { formatTelegramMessage } = require('../src/services/telegram-notify');
const {
    GPT_API_CUSTOMER_FAILURE_MESSAGE: GENERIC_FAILURE_MESSAGE,
    GPT_API_CUSTOMER_TIMEOUT_MESSAGE: TIMEOUT_FAILURE_MESSAGE
} = require('../src/utils/task-messages');

function createHarness({
    openProtocol = true,
    queryResults = [],
    submitResult,
    maxPolls = 3,
    jobKey = 'job-synthetic'
} = {}) {
    const taskUpdates = [];
    const broadcasts = [];
    const notifications = [];
    const holdCalls = [];
    const holdRows = [];
    const holdByCdk = new Map();
    const releasedCards = [];
    const markedUnusedCdks = [];
    const resetCdks = [];
    const submitCalls = [];
    let queryIndex = 0;

    const store = {
        getGptApiConfig: async () => ({
            enabled: true,
            api_key: 'synthetic-api-key',
            card_source: 'local',
            country: 'US',
            currency: 'USD'
        }),
        getActiveProxy: async () => null,
        reserveCard: async () => ({
            id: 7,
            card_number: '4111111111111111',
            card_expiry: '12/30',
            card_cvc: '123',
            card_holder: 'Synthetic User'
        }),
        updateTaskLog: async (_jobKey, update) => {
            taskUpdates.push({ ...update });
        },
        updateOrbitcardRecharge: async () => null,
        createActivationManualHold: async (input) => {
            holdCalls.push({ ...input });
            const key = String(input.cdkCode || '');
            if (holdByCdk.has(key)) return holdByCdk.get(key);
            const row = { id: holdRows.length + 1, ...input };
            holdRows.push(row);
            holdByCdk.set(key, row);
            return row;
        },
        resetCdkFailure: async (cdk) => {
            resetCdks.push(cdk);
        },
        recordCardUsage: async () => null,
        releaseCard: async (id) => {
            releasedCards.push(id);
        },
        markCdkUnused: async (cdk) => {
            markedUnusedCdks.push(cdk);
        },
        getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
        setMaintenanceModeState: async () => null
    };

    const gptApi = {
        isDesolateOpenProtocol: () => openProtocol,
        resolveOpenPlanCode: () => 'chatgptplusplan',
        inspectPay: async () => ({ success: true }),
        submitPay: async (cfg, input) => {
            submitCalls.push({ cfg, ...input });
            return submitResult || {
                success: true,
                orderId: 'ord-synthetic',
                data: { orderId: 'ord-synthetic', status: 'pending', message: '订单处理中' },
                message: '订单处理中',
                responseMeta: { requestId: 'req-submit' },
                requestId: 'req-submit'
            };
        },
        queryTask: async () => ({ success: false, error: 'unused task endpoint' }),
        queryOrder: async () => {
            const result = queryResults[Math.min(queryIndex, Math.max(0, queryResults.length - 1))];
            queryIndex += 1;
            if (result instanceof Error) throw result;
            return result;
        },
        getGptOrderPollDelayMs: () => 0,
        extractProviderMessage: (data, fallback = '') => {
            if (!data || typeof data !== 'object') return String(fallback || '');
            return String(data.failureMessage || data.providerMessage || data.message || data.error || fallback || '');
        },
        extractCaptcha: () => null,
        normalizeOpenOrderSummary: (data, responseMeta) => ({
            status: data?.status,
            failureCode: data?.failureCode,
            failureMessage: data?.failureMessage,
            requestId: responseMeta?.requestId
        }),
        extractTopupCode: () => null,
        formatProgressMessage: () => '订单正在处理中'
    };

    const runGptApiWorker = createGptApiWorker({
        store,
        gptApi,
        orbitcard: {},
        activeTaskCaptchas: new Map(),
        broadcastToTask: (_jobKey, update) => broadcasts.push({ ...update }),
        notifyTaskOutcome: (payload) => notifications.push({ ...payload }),
        logTask: vi.fn(),
        releaseForegroundSlot: vi.fn(),
        getTotalActiveJobs: () => 1,
        sleep: async () => null,
        env: {
            GPT_API_MAX_POLLS: String(maxPolls),
            GPT_API_POLL_INTERVAL_MS: '0'
        },
        logger: {
            error: vi.fn(),
            warn: vi.fn(),
            log: vi.fn()
        }
    });

    const run = () => runGptApiWorker({
        task: { jobKey },
        token: 'synthetic-token',
        session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
        cdk: 'KC-SYNTHETIC',
        planType: 'plus'
    });

    return {
        run,
        taskUpdates,
        broadcasts,
        notifications,
        holdCalls,
        holdRows,
        releasedCards,
        markedUnusedCdks,
        resetCdks,
        submitCalls
    };
}

function getFinalUpdate(harness, status) {
    return [...harness.taskUpdates].reverse().find((item) => item.status === status);
}

function getFinalBroadcast(harness, status) {
    return [...harness.broadcasts].reverse().find((item) => item.status === status);
}

describe('runGptApiWorker failure notification wiring', () => {
    it('keeps submit HTTP 409/business 40901 details out of customer task state', async () => {
        const providerReason = 'Duplicate request belongs to an existing provider order.';
        const harness = createHarness({
            openProtocol: true,
            jobKey: 'job-submit-conflict',
            submitResult: {
                success: false,
                status: 409,
                businessCode: 40901,
                error: providerReason,
                data: { code: 40901, message: providerReason },
                requestId: 'req-submit-conflict',
                responseMeta: { requestId: 'req-submit-conflict', status: 409 }
            }
        });

        await harness.run();

        expect(getFinalUpdate(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(getFinalBroadcast(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(getFinalUpdate(harness, 'failed').message).not.toContain('409');
        expect(getFinalBroadcast(harness, 'failed').message).not.toContain(providerReason);
        expect(harness.notifications).toHaveLength(1);
        expect(harness.notifications[0]).toMatchObject({
            event: 'failure',
            message: GENERIC_FAILURE_MESSAGE,
            diagnostic: {
                reason: providerReason,
                code: '40901',
                requestId: 'req-submit-conflict'
            }
        });
        expect(harness.holdRows).toHaveLength(1);
        expect(harness.holdRows[0].reason).toContain('HTTP 409');
        expect(harness.holdRows[0].reason).toContain('businessCode 40901');
        expect(harness.holdRows[0].reason).toContain(providerReason);
        expect(harness.submitCalls[0].idempotencyKey).toBe('gpt-api-job-submit-conflict');
    });

    it('derives a stable idempotency seed from the unique job key', async () => {
        const createSuccessfulHarness = (jobKey) => createHarness({
            openProtocol: true,
            jobKey,
            queryResults: [{
                success: true,
                data: { status: 'succeeded', subscriptionCancelled: true },
                rawStatus: 'succeeded'
            }]
        });
        const first = createSuccessfulHarness('job-stable');
        const retry = createSuccessfulHarness('job-stable');
        const other = createSuccessfulHarness('job-other');

        await first.run();
        await retry.run();
        await other.run();

        expect(first.submitCalls[0].idempotencyKey).toBe('gpt-api-job-stable');
        expect(retry.submitCalls[0].idempotencyKey).toBe(first.submitCalls[0].idempotencyKey);
        expect(other.submitCalls[0].idempotencyKey).toBe('gpt-api-job-other');
        expect(other.submitCalls[0].idempotencyKey).not.toBe(first.submitCalls[0].idempotencyKey);
    });

    it('keeps customer text generic and sends an Open terminal reason/code to Telegram admins', async () => {
        const harness = createHarness({
            openProtocol: true,
            queryResults: [{
                success: true,
                data: {
                    status: 'failed',
                    failureCode: 'EXISTING_SUBSCRIPTION_NOT_OURS',
                    failureMessage: 'Account has an existing subscription or recent payment.'
                },
                rawStatus: 'failed',
                requestId: 'req-open-failed',
                responseMeta: { requestId: 'req-open-failed' }
            }]
        });

        await harness.run();

        expect(getFinalUpdate(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(getFinalBroadcast(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(harness.notifications).toHaveLength(1);
        expect(harness.notifications[0]).toMatchObject({
            event: 'failure',
            message: GENERIC_FAILURE_MESSAGE,
            diagnostic: {
                reason: 'Account has an existing subscription or recent payment.',
                code: 'EXISTING_SUBSCRIPTION_NOT_OURS',
                orderId: 'ord-synthetic',
                status: 'failed',
                requestId: 'req-open-failed',
                pollCount: 1
            }
        });
        expect(formatTelegramMessage('failure', harness.notifications[0]))
            .toContain('详情: Account has an existing subscription or recent payment.');

        expect(harness.holdCalls).toHaveLength(2);
        expect(harness.holdRows).toHaveLength(1);
        expect(harness.holdRows[0].reason).toContain('Account has an existing subscription or recent payment.');
        expect(harness.holdRows[0].reason).not.toBe(GENERIC_FAILURE_MESSAGE);
        expect(harness.markedUnusedCdks).toEqual(['KC-SYNTHETIC']);
    });

    it('wires a legacy terminal failure into the same admin diagnostic path', async () => {
        const harness = createHarness({
            openProtocol: false,
            queryResults: [{
                success: true,
                data: {
                    status: 'done',
                    result: {
                        ok: false,
                        status: 'failed',
                        error: 'cf_challenge_unresolved',
                        errorCode: 'CAPTCHA_FAILED'
                    }
                },
                rawStatus: 'failed'
            }]
        });

        await harness.run();

        expect(getFinalUpdate(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(harness.notifications[0].diagnostic).toMatchObject({
            reason: 'cf_challenge_unresolved',
            code: 'CAPTCHA_FAILED',
            status: 'failed'
        });
    });

    it('reports the poll timeout while preserving the last known processing state', async () => {
        const harness = createHarness({
            openProtocol: true,
            maxPolls: 1,
            queryResults: [{
                success: true,
                data: { status: 'processing', message: '处理中' },
                rawStatus: 'processing',
                responseMeta: { requestId: 'req-processing' }
            }]
        });

        await harness.run();

        expect(getFinalUpdate(harness, 'failed').message).toBe(TIMEOUT_FAILURE_MESSAGE);
        expect(getFinalBroadcast(harness, 'failed').message).toBe(TIMEOUT_FAILURE_MESSAGE);
        expect(harness.notifications[0].diagnostic).toMatchObject({
            reason: '轮询超时：已查询 1 次，订单未进入终态',
            code: 'POLL_TIMEOUT',
            status: 'processing',
            pollCount: 1
        });
        expect(harness.holdRows[0].reason).toBe('轮询超时：已查询 1 次，订单未进入终态');
    });

    it('prefers a caught provider exception and never replaces processing with HTTP 503', async () => {
        const queryError = new Error('Request failed with status code 503');
        queryError.status = 503;
        queryError.providerMessage = 'Account has an existing subscription or recent payment.';
        const harness = createHarness({
            openProtocol: true,
            queryResults: [
                {
                    success: true,
                    data: { status: 'processing', message: '处理中' },
                    rawStatus: 'processing'
                },
                queryError
            ]
        });

        await harness.run();

        expect(getFinalUpdate(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(getFinalBroadcast(harness, 'failed').message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(harness.notifications[0]).toMatchObject({
            message: GENERIC_FAILURE_MESSAGE,
            diagnostic: {
                reason: 'Account has an existing subscription or recent payment.',
                status: 'processing',
                pollCount: 1
            }
        });
        expect(harness.notifications[0].diagnostic.status).not.toBe('503');
    });

    it('uses explicit fallback fields when a failed order has no provider code or message', async () => {
        const harness = createHarness({
            openProtocol: true,
            queryResults: [{
                success: true,
                data: { status: 'failed' },
                rawStatus: 'failed'
            }]
        });

        await harness.run();

        expect(harness.notifications[0].diagnostic).toMatchObject({
            reason: '原因缺失（第三方未提供失败原因）',
            code: '未提供',
            status: 'failed'
        });
        const telegram = formatTelegramMessage('failure', harness.notifications[0]);
        expect(telegram).toContain('详情: 原因缺失（第三方未提供失败原因）');
        expect(telegram).toContain('失败代码: 未提供');
    });

    it('continues after an internally retried submission and creates no manual hold', async () => {
        const harness = createHarness({
            openProtocol: true,
            submitResult: {
                success: true,
                orderId: 'ord-recovered-after-retry',
                data: { orderId: 'ord-recovered-after-retry', status: 'pending' },
                retryCount: 2,
                retryHistory: [
                    { businessCode: 40011 },
                    { businessCode: 40012 },
                    { businessCode: null }
                ],
                requestId: 'req-submit-recovered'
            },
            queryResults: [{
                success: true,
                data: { status: 'succeeded', subscriptionCancelled: true },
                rawStatus: 'succeeded'
            }]
        });

        await harness.run();

        expect(getFinalUpdate(harness, 'success').message).toBe('开通成功');
        expect(getFinalBroadcast(harness, 'success').message).toBe('开通成功');
        expect(harness.notifications).toEqual([expect.objectContaining({
            event: 'success',
            message: '开通成功'
        })]);
        expect(harness.notifications[0].diagnostic).toBeUndefined();
        expect(harness.holdRows).toHaveLength(0);
        expect(harness.markedUnusedCdks).toHaveLength(0);
        expect(harness.resetCdks).toEqual(['KC-SYNTHETIC']);
    });
});
