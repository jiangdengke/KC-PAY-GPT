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

    it('auto-rolls back CDK without manual hold on customer-definite failure (EXISTING_SUBSCRIPTION_NOT_OURS) and still sends full diagnostic to admins', async () => {
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

        expect(getFinalUpdate(harness, 'failed').message).toContain('已有生效中的订阅');
        expect(getFinalBroadcast(harness, 'failed').message).toContain('原卡密已自动退回');
        expect(harness.notifications).toHaveLength(1);
        expect(harness.notifications[0]).toMatchObject({
            event: 'failure',
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

        expect(harness.holdCalls).toHaveLength(0);
        expect(harness.holdRows).toHaveLength(0);
        expect(harness.releasedCards).toEqual([7]);
        expect(harness.markedUnusedCdks).toEqual(['KC-SYNTHETIC']);
    });

    it('wires a legacy CAPTCHA_FAILED failure into customer-definite auto-rollback with admin diagnostic', async () => {
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

        expect(getFinalUpdate(harness, 'failed').message).toContain('人机验证超时或未通过');
        expect(harness.holdRows).toHaveLength(0);
        expect(harness.releasedCards).toEqual([7]);
        expect(harness.markedUnusedCdks).toEqual(['KC-SYNTHETIC']);
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

    it('auto-syncs upstream cards and estimates Plus capacity without calling createCard when auto-create is disabled', async () => {
        const orbitcardClient = require('../src/services/orbitcard-client');
        const taskUpdates = [];
        const broadcasts = [];
        const notifications = [];
        const holdRows = [];
        const markedUnusedCdks = [];
        const dbCards = new Map();

        const store = {
            getGptApiConfig: async () => ({
                enabled: true,
                api_key: 'synthetic-api-key',
                card_source: 'orbitcard',
                orbitcard_auto_create_card: false,
                orbitcard_plus_unit_price: 20,
                orbitcard_base_url: 'https://orbitcard.cc',
                orbitcard_api_key: 'ok',
                orbitcard_api_secret: 'os',
                orbitcard_reuse_limits: { plus: 4, pro100: 1, pro200: 1, pro500: 1 },
                orbitcard_safety_margins: { plus: 1, pro100: 1, pro200: 1, pro500: 1 },
                country: 'US',
                currency: 'USD'
            }),
            getOrbitcardCardMetaByIds: async (ids) => ids.map((id) => dbCards.get(id)).filter(Boolean),
            syncOrbitcardCards: async (cards) => {
                let autoAssigned = 0;
                for (const card of cards) {
                    const existing = dbCards.get(card.cardId);
                    if (!existing?.planType && card.autoPlanType) {
                        dbCards.set(card.cardId, {
                            cardId: card.cardId,
                            status: 'ACTIVE',
                            planType: card.autoPlanType,
                            usageCount: 0,
                            maxUsageCount: card.autoMaxUsageCount,
                            initialAmount: card.autoInitialAmount,
                            last4: card.last4
                        });
                        autoAssigned += 1;
                    }
                }
                return { total: cards.length, inserted: autoAssigned, updated: 0, autoAssigned, autoAssignedCards: [] };
            },
            reserveOrbitcardCard: async (cards, _owner, { planType }) => {
                for (const card of cards) {
                    const row = dbCards.get(card.cardId);
                    if (row && row.planType === planType && row.usageCount < row.maxUsageCount) {
                        return {
                            id: row.cardId,
                            orbitcard_id: row.cardId,
                            last4: row.last4 || '8888',
                            usage_count: row.usageCount,
                            max_usage_count: row.maxUsageCount,
                            plan_type: row.planType,
                            initial_amount: row.initialAmount
                        };
                    }
                }
                return null;
            },
            createOrbitcardRecharge: async () => true,
            updateOrbitcardRecharge: async () => null,
            recordOrbitcardCardUsage: async (cardId) => {
                const row = dbCards.get(cardId);
                row.usageCount += 1;
                return { usageCount: row.usageCount, maxUsageCount: row.maxUsageCount };
            },
            releaseOrbitcardCard: async () => null,
            retireOrbitcardCard: async () => null,
            updateTaskLog: async (_jobKey, update) => taskUpdates.push({ ...update }),
            createActivationManualHold: async (input) => {
                holdRows.push(input);
                return input;
            },
            resetCdkFailure: async () => null,
            markCdkUnused: async (cdk) => markedUnusedCdks.push(cdk),
            getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
            setMaintenanceModeState: async () => null
        };

        const createCardUntilReady = vi.fn();
        const mockOrbitcard = {
            ...orbitcardClient,
            getCardList: vi.fn(async () => ({
                success: true,
                data: [{ cardId: 901, status: 'ACTIVE', balance: 62, currency: 'USD', last4: '8888', productCode: 'P1' }]
            })),
            getProductCode: vi.fn(async () => ({ success: true, data: [] })),
            getCardDetail: vi.fn(async () => ({
                success: true,
                data: { cardId: 901, cardNumber: '5556597900008888', expiry: '12/30', cvc: '123', holder: 'Manual Card' }
            })),
            createCardUntilReady
        };

        const runWorker = createGptApiWorker({
            store,
            gptApi: {
                isDesolateOpenProtocol: () => true,
                resolveOpenPlanCode: () => 'chatgptplusplan',
                inspectPay: async () => ({ success: true }),
                submitPay: async () => ({ success: true, orderId: 'ord-manual-card', data: { status: 'pending' } }),
                queryTask: async () => ({ success: false }),
                queryOrder: async () => ({ success: true, data: { status: 'succeeded', subscriptionCancelled: true }, rawStatus: 'succeeded' }),
                getGptOrderPollDelayMs: () => 0,
                extractProviderMessage: () => '',
                extractCaptcha: () => null,
                normalizeOpenOrderSummary: (data) => data,
                extractTopupCode: () => null,
                formatProgressMessage: () => '处理中'
            },
            orbitcard: mockOrbitcard,
            activeTaskCaptchas: new Map(),
            broadcastToTask: (_jobKey, update) => broadcasts.push(update),
            notifyTaskOutcome: (payload) => notifications.push(payload),
            logTask: vi.fn(),
            releaseForegroundSlot: vi.fn(),
            getTotalActiveJobs: () => 1,
            sleep: async () => null,
            env: { GPT_API_MAX_POLLS: '3', GPT_API_POLL_INTERVAL_MS: '0' },
            logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() }
        });

        await runWorker({
            task: { jobKey: 'job-manual-sync-ok' },
            token: 'synthetic-token',
            session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
            cdk: 'KC-MANUAL-OK',
            planType: 'plus'
        });

        expect(createCardUntilReady).not.toHaveBeenCalled();
        expect(dbCards.get(901)).toMatchObject({ planType: 'plus', maxUsageCount: 3, usageCount: 1 });
        expect([...taskUpdates].reverse().find((u) => u.status === 'success')).toBeTruthy();
        expect(holdRows).toHaveLength(0);
        expect(markedUnusedCdks).toHaveLength(0);
    });

    it('emits card_pool_empty, rolls back CDK, and skips manual hold when auto-create is disabled and no cards are usable', async () => {
        const orbitcardClient = require('../src/services/orbitcard-client');
        const taskUpdates = [];
        const broadcasts = [];
        const notifications = [];
        const holdRows = [];
        const markedUnusedCdks = [];

        const store = {
            getGptApiConfig: async () => ({
                enabled: true,
                api_key: 'synthetic-api-key',
                card_source: 'orbitcard',
                orbitcard_auto_create_card: false,
                orbitcard_plus_unit_price: 20,
                orbitcard_base_url: 'https://orbitcard.cc',
                orbitcard_api_key: 'ok',
                orbitcard_api_secret: 'os',
                orbitcard_reuse_limits: { plus: 4, pro100: 1, pro200: 1, pro500: 1 },
                orbitcard_safety_margins: { plus: 1, pro100: 1, pro200: 1, pro500: 1 },
                country: 'US',
                currency: 'USD'
            }),
            getOrbitcardCardMetaByIds: async () => [],
            syncOrbitcardCards: async () => ({ total: 0, inserted: 0, updated: 0, autoAssigned: 0, autoAssignedCards: [] }),
            reserveOrbitcardCard: async () => null,
            updateTaskLog: async (_jobKey, update) => taskUpdates.push({ ...update }),
            createActivationManualHold: async (input) => {
                holdRows.push(input);
                return input;
            },
            markCdkUnused: async (cdk) => markedUnusedCdks.push(cdk),
            getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
            setMaintenanceModeState: async () => null
        };

        const createCardUntilReady = vi.fn();
        const runWorker = createGptApiWorker({
            store,
            gptApi: {
                isDesolateOpenProtocol: () => true,
                resolveOpenPlanCode: () => 'chatgptplusplan',
                inspectPay: async () => ({ success: true })
            },
            orbitcard: {
                ...orbitcardClient,
                getCardList: vi.fn(async () => ({ success: true, data: [] })),
                getProductCode: vi.fn(async () => ({ success: true, data: [] })),
                createCardUntilReady
            },
            activeTaskCaptchas: new Map(),
            broadcastToTask: (_jobKey, update) => broadcasts.push(update),
            notifyTaskOutcome: (payload) => notifications.push(payload),
            logTask: vi.fn(),
            releaseForegroundSlot: vi.fn(),
            getTotalActiveJobs: () => 1,
            sleep: async () => null,
            env: { GPT_API_MAX_POLLS: '3', GPT_API_POLL_INTERVAL_MS: '0' },
            logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() }
        });

        await runWorker({
            task: { jobKey: 'job-manual-empty' },
            token: 'synthetic-token',
            session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
            cdk: 'KC-MANUAL-EMPTY',
            planType: 'plus'
        });

        expect(createCardUntilReady).not.toHaveBeenCalled();
        expect(holdRows).toHaveLength(0);
        expect(markedUnusedCdks).toEqual(['KC-MANUAL-EMPTY']);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            event: 'card_pool_empty',
            cdk: 'KC-MANUAL-EMPTY',
            planType: 'plus'
        });
        expect([...taskUpdates].reverse().find((u) => u.status === 'failed')?.message)
            .toBe('当前暂无可用卡片，请稍后再试或联系客服');
    });

    it('retires a declined Orbitcard card and seamlessly swaps to a backup card once to succeed', async () => {
        const orbitcardClient = require('../src/services/orbitcard-client');
        const taskUpdates = [];
        const broadcasts = [];
        const notifications = [];
        const holdRows = [];
        const markedUnusedCdks = [];
        const retiredCards = [];
        const releasedCards = [];
        const rechargeCreates = [];
        const submitCalls = [];

        const dbCards = new Map([
            [901, { cardId: 901, status: 'ACTIVE', planType: 'plus', usageCount: 0, maxUsageCount: 2, initialAmount: 32, last4: '1111' }],
            [902, { cardId: 902, status: 'ACTIVE', planType: 'plus', usageCount: 0, maxUsageCount: 2, initialAmount: 32, last4: '2222' }]
        ]);

        const store = {
            getGptApiConfig: async () => ({
                enabled: true,
                api_key: 'synthetic-api-key',
                card_source: 'orbitcard',
                orbitcard_auto_create_card: false,
                orbitcard_plus_unit_price: 20,
                orbitcard_base_url: 'https://orbitcard.cc',
                orbitcard_api_key: 'ok',
                orbitcard_api_secret: 'os',
                orbitcard_reuse_limits: { plus: 2 },
                orbitcard_safety_margins: { plus: 0 },
                country: 'US',
                currency: 'USD'
            }),
            reserveOrbitcardCard: async (cards, _owner, { planType }) => {
                for (const card of cards) {
                    const row = dbCards.get(card.cardId);
                    if (row && row.status === 'ACTIVE' && row.planType === planType && row.usageCount < row.maxUsageCount) {
                        return {
                            id: row.cardId,
                            orbitcard_id: row.cardId,
                            last4: row.last4,
                            usage_count: row.usageCount,
                            max_usage_count: row.maxUsageCount,
                            plan_type: row.planType,
                            initial_amount: row.initialAmount
                        };
                    }
                }
                return null;
            },
            createOrbitcardRecharge: async (input) => {
                rechargeCreates.push({ ...input });
                return true;
            },
            updateOrbitcardRecharge: async () => null,
            recordOrbitcardCardUsage: async (cardId) => {
                const row = dbCards.get(cardId);
                row.usageCount += 1;
                return { usageCount: row.usageCount, maxUsageCount: row.maxUsageCount };
            },
            releaseOrbitcardCard: async (cardId) => {
                releasedCards.push(cardId);
            },
            retireOrbitcardCard: async (cardId) => {
                retiredCards.push(cardId);
                const row = dbCards.get(cardId);
                if (row) row.status = 'RETIRED';
            },
            updateTaskLog: async (_jobKey, update) => taskUpdates.push({ ...update }),
            createActivationManualHold: async (input) => {
                holdRows.push(input);
                return input;
            },
            resetCdkFailure: async () => null,
            markCdkUnused: async (cdk) => markedUnusedCdks.push(cdk),
            getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
            setMaintenanceModeState: async () => null
        };

        let orderAttempt = 0;
        const runWorker = createGptApiWorker({
            store,
            gptApi: {
                isDesolateOpenProtocol: () => true,
                resolveOpenPlanCode: () => 'chatgptplusplan',
                inspectPay: async () => ({ success: true }),
                submitPay: async (_cfg, input) => {
                    submitCalls.push({ ...input });
                    orderAttempt += 1;
                    return { success: true, orderId: `ord-swap-${orderAttempt}`, data: { status: 'pending' } };
                },
                queryTask: async () => ({ success: false }),
                queryOrder: async (_cfg, orderId) => {
                    if (orderId === 'ord-swap-1') {
                        return {
                            success: true,
                            data: {
                                status: 'failed',
                                failureCode: 'CARD_DECLINED',
                                failureMessage: '银行卡支付未获通过，本次充值失败。'
                            },
                            rawStatus: 'failed'
                        };
                    }
                    return {
                        success: true,
                        data: { status: 'succeeded', subscriptionCancelled: true },
                        rawStatus: 'succeeded'
                    };
                },
                getGptOrderPollDelayMs: () => 0,
                extractProviderMessage: (d) => d?.failureMessage || '',
                extractCaptcha: () => null,
                normalizeOpenOrderSummary: (d) => d,
                extractTopupCode: () => null,
                formatProgressMessage: () => '处理中'
            },
            orbitcard: {
                ...orbitcardClient,
                getCardList: vi.fn(async () => ({
                    success: true,
                    data: [
                        { cardId: 901, status: 'ACTIVE', balance: 32, currency: 'USD', last4: '1111' },
                        { cardId: 902, status: 'ACTIVE', balance: 32, currency: 'USD', last4: '2222' }
                    ]
                })),
                getCardDetail: vi.fn(async (_cfg, cardId) => ({
                    success: true,
                    data: {
                        cardId,
                        cardNumber: cardId === 901 ? '4466190707811111' : '4466190707812222',
                        expiry: '12/30',
                        cvc: '123',
                        holder: 'User'
                    }
                }))
            },
            activeTaskCaptchas: new Map(),
            broadcastToTask: (_jobKey, update) => broadcasts.push({ ...update }),
            notifyTaskOutcome: (payload) => notifications.push({ ...payload }),
            logTask: vi.fn(),
            releaseForegroundSlot: vi.fn(),
            getTotalActiveJobs: () => 1,
            sleep: async () => null,
            env: { GPT_API_MAX_POLLS: '3', GPT_API_POLL_INTERVAL_MS: '0' },
            logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() }
        });

        await runWorker({
            task: { jobKey: 'job-swap-ok' },
            token: 'synthetic-token',
            session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
            cdk: 'KC-SWAP-OK',
            planType: 'plus'
        });

        expect(retiredCards).toEqual([901]);
        expect(releasedCards).toEqual([902]);
        expect(dbCards.get(902).usageCount).toBe(1);
        expect(submitCalls.map((c) => c.idempotencyKey)).toEqual(['gpt-api-job-swap-ok', 'gpt-api-job-swap-ok-r1']);
        expect(rechargeCreates.map((r) => ({ cardId: r.cardId, jobKey: r.jobKey }))).toEqual([
            { cardId: 901, jobKey: 'job-swap-ok' },
            { cardId: 902, jobKey: 'job-swap-ok-r1' }
        ]);
        expect(holdRows).toHaveLength(0);
        expect(markedUnusedCdks).toHaveLength(0);
        expect([...taskUpdates].reverse().find((u) => u.status === 'success')?.message).toBe('开通成功');
        expect(notifications.map((n) => n.event)).toEqual(['failure', 'success']);
    });

    it('retires a declined Orbitcard card and rolls back CDK without manual hold when no backup card is available', async () => {
        const orbitcardClient = require('../src/services/orbitcard-client');
        const taskUpdates = [];
        const notifications = [];
        const holdRows = [];
        const markedUnusedCdks = [];
        const retiredCards = [];

        const dbCards = new Map([
            [901, { cardId: 901, status: 'ACTIVE', planType: 'plus', usageCount: 0, maxUsageCount: 2, initialAmount: 32, last4: '1111' }]
        ]);

        const store = {
            getGptApiConfig: async () => ({
                enabled: true,
                api_key: 'synthetic-api-key',
                card_source: 'orbitcard',
                orbitcard_auto_create_card: false,
                orbitcard_plus_unit_price: 20,
                orbitcard_base_url: 'https://orbitcard.cc',
                orbitcard_api_key: 'ok',
                orbitcard_api_secret: 'os',
                orbitcard_reuse_limits: { plus: 2 },
                orbitcard_safety_margins: { plus: 0 },
                country: 'US',
                currency: 'USD'
            }),
            getOrbitcardCardMetaByIds: async () => [],
            syncOrbitcardCards: async () => ({ total: 0, inserted: 0, updated: 0, autoAssigned: 0, autoAssignedCards: [] }),
            reserveOrbitcardCard: async (cards, _owner, { planType }) => {
                for (const card of cards) {
                    const row = dbCards.get(card.cardId);
                    if (row && row.status === 'ACTIVE' && row.planType === planType && row.usageCount < row.maxUsageCount) {
                        return {
                            id: row.cardId,
                            orbitcard_id: row.cardId,
                            last4: row.last4,
                            usage_count: row.usageCount,
                            max_usage_count: row.maxUsageCount,
                            plan_type: row.planType,
                            initial_amount: row.initialAmount
                        };
                    }
                }
                return null;
            },
            createOrbitcardRecharge: async () => true,
            updateOrbitcardRecharge: async () => null,
            releaseOrbitcardCard: async () => null,
            retireOrbitcardCard: async (cardId) => {
                retiredCards.push(cardId);
                const row = dbCards.get(cardId);
                if (row) row.status = 'RETIRED';
            },
            updateTaskLog: async (_jobKey, update) => taskUpdates.push({ ...update }),
            createActivationManualHold: async (input) => {
                holdRows.push(input);
                return input;
            },
            markCdkUnused: async (cdk) => markedUnusedCdks.push(cdk),
            getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
            setMaintenanceModeState: async () => null
        };

        const runWorker = createGptApiWorker({
            store,
            gptApi: {
                isDesolateOpenProtocol: () => true,
                resolveOpenPlanCode: () => 'chatgptplusplan',
                inspectPay: async () => ({ success: true }),
                submitPay: async () => ({ success: true, orderId: 'ord-declined-only', data: { status: 'pending' } }),
                queryTask: async () => ({ success: false }),
                queryOrder: async () => ({
                    success: true,
                    data: {
                        status: 'failed',
                        failureMessage: '该卡片已达订阅上限，请更换银行卡后重试。'
                    },
                    rawStatus: 'failed'
                }),
                getGptOrderPollDelayMs: () => 0,
                extractProviderMessage: (d) => d?.failureMessage || '',
                extractCaptcha: () => null,
                normalizeOpenOrderSummary: (d) => d,
                extractTopupCode: () => null,
                formatProgressMessage: () => '处理中'
            },
            orbitcard: {
                ...orbitcardClient,
                getCardList: vi.fn(async () => ({
                    success: true,
                    data: [{ cardId: 901, status: 'ACTIVE', balance: 32, currency: 'USD', last4: '1111' }]
                })),
                getProductCode: vi.fn(async () => ({ success: true, data: [] })),
                getCardDetail: vi.fn(async () => ({
                    success: true,
                    data: { cardId: 901, cardNumber: '4466190707811111', expiry: '12/30', cvc: '123', holder: 'User' }
                }))
            },
            activeTaskCaptchas: new Map(),
            broadcastToTask: vi.fn(),
            notifyTaskOutcome: (payload) => notifications.push({ ...payload }),
            logTask: vi.fn(),
            releaseForegroundSlot: vi.fn(),
            getTotalActiveJobs: () => 1,
            sleep: async () => null,
            env: { GPT_API_MAX_POLLS: '3', GPT_API_POLL_INTERVAL_MS: '0' },
            logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() }
        });

        await runWorker({
            task: { jobKey: 'job-swap-empty' },
            token: 'synthetic-token',
            session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
            cdk: 'KC-SWAP-EMPTY',
            planType: 'plus'
        });

        expect(retiredCards).toEqual([901]);
        expect(holdRows).toHaveLength(0);
        expect(markedUnusedCdks).toEqual(['KC-SWAP-EMPTY']);
        expect(notifications.map((n) => n.event)).toEqual(['failure', 'card_pool_empty']);
        expect([...taskUpdates].reverse().find((u) => u.status === 'failed')?.message)
            .toContain('暂无备用卡');
    });

    it('releases Orbitcard card back to pool without retiring or holding CDK on customer-definite or pre-submit HTTP 422 failure', async () => {
        const orbitcardClient = require('../src/services/orbitcard-client');
        const runCase = async ({ submitResult, queryResult }) => {
            const retiredCards = [];
            const releasedCards = [];
            const holdRows = [];
            const markedUnusedCdks = [];
            const taskUpdates = [];

            const store = {
                getGptApiConfig: async () => ({
                    enabled: true,
                    api_key: 'synthetic-api-key',
                    card_source: 'orbitcard',
                    orbitcard_auto_create_card: false,
                    orbitcard_plus_unit_price: 20,
                    orbitcard_base_url: 'https://orbitcard.cc',
                    orbitcard_api_key: 'ok',
                    orbitcard_api_secret: 'os',
                    orbitcard_reuse_limits: { plus: 2 },
                    orbitcard_safety_margins: { plus: 0 },
                    country: 'US',
                    currency: 'USD'
                }),
                reserveOrbitcardCard: async () => ({
                    id: 905,
                    orbitcard_id: 905,
                    last4: '5555',
                    usage_count: 0,
                    max_usage_count: 2,
                    plan_type: 'plus',
                    initial_amount: 32
                }),
                createOrbitcardRecharge: async () => true,
                updateOrbitcardRecharge: async () => null,
                releaseOrbitcardCard: async (cardId) => releasedCards.push(cardId),
                retireOrbitcardCard: async (cardId) => retiredCards.push(cardId),
                updateTaskLog: async (_jobKey, update) => taskUpdates.push({ ...update }),
                createActivationManualHold: async (input) => holdRows.push(input),
                markCdkUnused: async (cdk) => markedUnusedCdks.push(cdk),
                getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
                setMaintenanceModeState: async () => null
            };

            const runWorker = createGptApiWorker({
                store,
                gptApi: {
                    isDesolateOpenProtocol: () => true,
                    resolveOpenPlanCode: () => 'chatgptplusplan',
                    inspectPay: async () => ({ success: true }),
                    submitPay: async () => submitResult || { success: true, orderId: 'ord-cust', data: { status: 'pending' } },
                    queryTask: async () => ({ success: false }),
                    queryOrder: async () => queryResult,
                    getGptOrderPollDelayMs: () => 0,
                    extractProviderMessage: (d) => d?.failureMessage || d?.message || '',
                    extractCaptcha: () => null,
                    normalizeOpenOrderSummary: (d) => d,
                    extractTopupCode: () => null,
                    formatProgressMessage: () => '处理中'
                },
                orbitcard: {
                    ...orbitcardClient,
                    getCardList: vi.fn(async () => ({
                        success: true,
                        data: [{ cardId: 905, status: 'ACTIVE', balance: 32, currency: 'USD', last4: '5555' }]
                    })),
                    getCardDetail: vi.fn(async () => ({
                        success: true,
                        data: { cardId: 905, cardNumber: '4466190707815555', expiry: '12/30', cvc: '123', holder: 'User' }
                    }))
                },
                activeTaskCaptchas: new Map(),
                broadcastToTask: vi.fn(),
                notifyTaskOutcome: vi.fn(),
                logTask: vi.fn(),
                releaseForegroundSlot: vi.fn(),
                getTotalActiveJobs: () => 1,
                sleep: async () => null,
                env: { GPT_API_MAX_POLLS: '3', GPT_API_POLL_INTERVAL_MS: '0' },
                logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() }
            });

            await runWorker({
                task: { jobKey: 'job-safe-release' },
                token: 'synthetic-token',
                session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
                cdk: 'KC-SAFE-RELEASE',
                planType: 'plus'
            });
            return { retiredCards, releasedCards, holdRows, markedUnusedCdks, taskUpdates };
        };

        const existingSub = await runCase({
            queryResult: {
                success: true,
                data: { status: 'failed', failureCode: 'EXISTING_SUBSCRIPTION_NOT_OURS', failureMessage: 'Account already has subscription' },
                rawStatus: 'failed'
            }
        });
        expect(existingSub.retiredCards).toHaveLength(0);
        expect(existingSub.releasedCards).toEqual([905]);
        expect(existingSub.holdRows).toHaveLength(0);
        expect(existingSub.markedUnusedCdks).toEqual(['KC-SAFE-RELEASE']);

        const http422 = await runCase({
            submitResult: {
                success: false,
                status: 422,
                businessCode: 40013,
                error: 'Session token expired',
                data: { code: 40013, message: 'Session token expired' }
            }
        });
        expect(http422.retiredCards).toHaveLength(0);
        expect(http422.releasedCards).toEqual([905]);
        expect(http422.holdRows).toHaveLength(0);
        expect(http422.markedUnusedCdks).toEqual(['KC-SAFE-RELEASE']);
        expect([...http422.taskUpdates].reverse().find((u) => u.status === 'failed')?.message)
            .toContain('Session');
    });

    it('records CDK and IP cooldown counts only on client-side failures, appends 30-minute notice when triggered, and resets both on success', async () => {
        const runScenario = async ({
            inspectResult = { success: true },
            submitResult = null,
            queryResult = null,
            cdkTriggersCooldown = false,
            ipTriggersCooldown = false
        }) => {
            const taskUpdates = [];
            const broadcasts = [];
            const cdkFailures = [];
            const ipFailures = [];
            const cdkResets = [];
            const ipResets = [];

            const store = {
                getGptApiConfig: async () => ({
                    enabled: true,
                    api_key: 'synthetic-api-key',
                    card_source: 'local',
                    country: 'US',
                    currency: 'USD'
                }),
                reserveCard: async () => ({
                    id: 11,
                    card_number: '4111111111111111',
                    card_expiry: '12/30',
                    card_cvc: '123',
                    card_holder: 'Synthetic User'
                }),
                updateTaskLog: async (_jobKey, update) => taskUpdates.push({ ...update }),
                updateOrbitcardRecharge: async () => null,
                createActivationManualHold: async (input) => input,
                recordCdkFailure: async (cdk) => {
                    cdkFailures.push(cdk);
                    return cdkTriggersCooldown;
                },
                recordActivationAttemptFailure: async (scopeType, scopeKey) => {
                    ipFailures.push({ scopeType, scopeKey });
                    return ipTriggersCooldown;
                },
                resetCdkFailure: async (cdk) => cdkResets.push(cdk),
                resetActivationAttemptFailure: async (scopeType, scopeKey) => ipResets.push({ scopeType, scopeKey }),
                recordCardUsage: async () => null,
                releaseCard: async () => null,
                markCardExhausted: async () => null,
                markCdkUnused: async () => null,
                getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
                setMaintenanceModeState: async () => null
            };

            const runWorker = createGptApiWorker({
                store,
                gptApi: {
                    isDesolateOpenProtocol: () => true,
                    resolveOpenPlanCode: () => 'chatgptplusplan',
                    inspectPay: async () => inspectResult,
                    submitPay: async () => submitResult || {
                        success: true,
                        orderId: 'ord-cooldown',
                        data: { orderId: 'ord-cooldown', status: 'pending' }
                    },
                    queryTask: async () => ({ success: false }),
                    queryOrder: async () => queryResult,
                    getGptOrderPollDelayMs: () => 0,
                    extractProviderMessage: (d) => d?.failureMessage || d?.message || '',
                    extractCaptcha: () => null,
                    normalizeOpenOrderSummary: (d) => d,
                    extractTopupCode: () => null,
                    formatProgressMessage: () => '处理中'
                },
                orbitcard: {},
                activeTaskCaptchas: new Map(),
                broadcastToTask: (_jobKey, update) => broadcasts.push({ ...update }),
                notifyTaskOutcome: vi.fn(),
                logTask: vi.fn(),
                releaseForegroundSlot: vi.fn(),
                getTotalActiveJobs: () => 1,
                sleep: async () => null,
                env: { GPT_API_MAX_POLLS: '2', GPT_API_POLL_INTERVAL_MS: '0' },
                logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() }
            });

            await runWorker({
                task: { jobKey: 'job-cooldown-case' },
                token: 'synthetic-token',
                session: { user: { email: 'user@example.com' }, accessToken: 'synthetic-access-token' },
                cdk: 'KC-COOLDOWN-1',
                planType: 'plus',
                clientIp: '203.0.113.88'
            });

            return { taskUpdates, broadcasts, cdkFailures, ipFailures, cdkResets, ipResets };
        };

        // 1. customer_definite triggers failure counters and appends 30-min notice on 3rd failure
        const existingSub = await runScenario({
            queryResult: {
                success: true,
                data: { status: 'failed', failureCode: 'EXISTING_SUBSCRIPTION_NOT_OURS', failureMessage: 'Account already has subscription' },
                rawStatus: 'failed'
            },
            cdkTriggersCooldown: true,
            ipTriggersCooldown: true
        });
        expect(existingSub.cdkFailures).toEqual(['KC-COOLDOWN-1']);
        expect(existingSub.ipFailures).toEqual([{ scopeType: 'ip', scopeKey: '203.0.113.88' }]);
        expect([...existingSub.taskUpdates].reverse().find((u) => u.status === 'failed')?.message)
            .toContain('连续失败已达 3 次，请冷静 30 分钟后再试');

        // 2. inspect_failed counts as client-side failure
        const inspectFail = await runScenario({
            inspectResult: { success: false, status: 400, error: 'session_invalid' },
            cdkTriggersCooldown: false
        });
        expect(inspectFail.cdkFailures).toEqual(['KC-COOLDOWN-1']);
        expect(inspectFail.ipFailures).toEqual([{ scopeType: 'ip', scopeKey: '203.0.113.88' }]);
        expect([...inspectFail.taskUpdates].reverse().find((u) => u.status === 'failed')?.message)
            .not.toContain('冷静 30 分钟');

        // 3. submit HTTP 401 (upstream API auth problem) must NOT penalize customer CDK/IP
        const submit401 = await runScenario({
            submitResult: {
                success: false,
                status: 401,
                error: 'Invalid API key',
                data: { message: 'Invalid API key' }
            }
        });
        expect(submit401.cdkFailures).toHaveLength(0);
        expect(submit401.ipFailures).toHaveLength(0);

        // 4. card_declined must NOT penalize customer CDK/IP
        const declined = await runScenario({
            queryResult: {
                success: true,
                data: { status: 'failed', failureCode: 'CARD_DECLINED', failureMessage: '银行卡支付未获通过' },
                rawStatus: 'failed'
            }
        });
        expect(declined.cdkFailures).toHaveLength(0);
        expect(declined.ipFailures).toHaveLength(0);

        // 5. success resets both CDK and IP failure counters
        const ok = await runScenario({
            queryResult: {
                success: true,
                data: { status: 'succeeded', subscriptionCancelled: true },
                rawStatus: 'succeeded'
            }
        });
        expect(ok.cdkFailures).toHaveLength(0);
        expect(ok.ipFailures).toHaveLength(0);
        expect(ok.cdkResets).toEqual(['KC-COOLDOWN-1']);
        expect(ok.ipResets).toEqual([{ scopeType: 'ip', scopeKey: '203.0.113.88' }]);
    });
});
