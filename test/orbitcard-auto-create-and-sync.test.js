'use strict';

const orbitcard = require('../src/services/orbitcard-client');
const { syncAndAutoAssignOrbitcardCards } = require('../src/services/orbitcard-sync');

const SAMPLE_CATALOG = [
    {
        product_code: 'amzkeys:55565979',
        bin: '55565979',
        channel: 3,
        min_initial_amount: 20,
        min_retained_balance: 1,
        remaining_open_card_num: 10,
        gpt_plan_prices: [
            { id: 'plus', name: 'ChatGPT Plus', price: 20, currency: 'USD' },
            { id: 'pro200', name: 'ChatGPT Pro 200', price: 200, currency: 'USD' }
        ]
    }
];

describe('estimatePlusCapacityFromBalance', () => {
    it('computes Plus count from catalog price, retained balance, safety margin, and caps by reuse limit', () => {
        const res85 = orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 101, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: 85, currency: 'USD' },
            { productCatalog: SAMPLE_CATALOG, reuseLimits: { plus: 4 }, safetyMargins: { plus: 1 } }
        );
        expect(res85).toMatchObject({
            eligible: true,
            planType: 'plus',
            estimatedCount: 4,
            rawCount: 4,
            unitPrice: 20,
            minRetainedBalance: 1,
            safetyMargin: 1,
            priceSource: 'catalog'
        });

        // $200 card capped at reuse limit 4
        const res200 = orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 102, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: 200, currency: 'USD' },
            { productCatalog: SAMPLE_CATALOG, reuseLimits: { plus: 4 }, safetyMargins: { plus: 1 } }
        );
        expect(res200).toMatchObject({ eligible: true, estimatedCount: 4, rawCount: 9, cap: 4 });

        // Higher reuse limit allows higher cap
        const resCap8 = orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 103, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: 200, currency: 'USD' },
            { productCatalog: SAMPLE_CATALOG, reuseLimits: { plus: 8 }, safetyMargins: { plus: 1 } }
        );
        expect(resCap8).toMatchObject({ eligible: true, estimatedCount: 8, rawCount: 9, cap: 8 });
    });

    it('falls back to configured Plus unit price when product catalog is missing or unmatched', () => {
        const res = orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 201, status: 'ACTIVE', productCode: 'UNKNOWN_PROD', balance: 63, currency: 'USD' },
            { productCatalog: [], fallbackPlusPrice: 20.5, reuseLimits: { plus: 5 }, safetyMargins: { plus: 1 } }
        );
        expect(res).toMatchObject({
            eligible: true,
            planType: 'plus',
            estimatedCount: 3,
            unitPrice: 20.5,
            minRetainedBalance: 0,
            safetyMargin: 1,
            priceSource: 'fallback'
        });

        // Zero safety margin allows exact multiples like $20 / $60
        const exact = orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 202, status: 'ACTIVE', balance: 60 },
            { productCatalog: [], fallbackPlusPrice: 20, reuseLimits: { plus: 4 }, safetyMargins: { plus: 0 } }
        );
        expect(exact).toMatchObject({ eligible: true, estimatedCount: 3, spendable: 60 });
    });

    it('rejects insufficient balance, inactive cards, blocked 4002 BIN, and currency mismatch', () => {
        expect(orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 301, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: 21, currency: 'USD' },
            { productCatalog: SAMPLE_CATALOG, reuseLimits: { plus: 4 }, safetyMargins: { plus: 1 } }
        )).toMatchObject({ eligible: false, estimatedCount: 0, reason: 'insufficient_balance' });

        expect(orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 302, status: 'ACTIVE', balance: null }
        )).toMatchObject({ eligible: false, reason: 'missing_or_zero_balance' });

        expect(orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 303, status: 'CANCELLED', balance: 80 }
        )).toMatchObject({ eligible: false, reason: 'inactive' });

        expect(orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 304, status: 'ACTIVE', bin: '40021234', balance: 80 }
        )).toMatchObject({ eligible: false, reason: 'blocked_product' });

        expect(orbitcard.estimatePlusCapacityFromBalance(
            { cardId: 305, status: 'ACTIVE', balance: 80, currency: 'EUR' }
        )).toMatchObject({ eligible: false, reason: 'currency_mismatch' });
    });
});

describe('syncAndAutoAssignOrbitcardCards', () => {
    it('auto-assigns unassigned ACTIVE cards from balance without overwriting existing bound cards', async () => {
        const syncedBatches = [];
        const store = {
            getOrbitcardCardMetaByIds: async () => ([
                { cardId: 10, status: 'ACTIVE', planType: 'pro200', usageCount: 0, maxUsageCount: 1 },
                { cardId: 11, status: 'ACTIVE', planType: null, usageCount: 0, maxUsageCount: 1 }
            ]),
            syncOrbitcardCards: async (cards) => {
                syncedBatches.push(cards);
                return {
                    total: cards.length,
                    inserted: 1,
                    updated: 2,
                    autoAssigned: cards.filter((c) => c.autoPlanType).length,
                    autoAssignedCards: cards.filter((c) => c.autoPlanType).map((c) => ({
                        cardId: c.cardId,
                        planType: c.autoPlanType,
                        maxUsageCount: c.autoMaxUsageCount
                    }))
                };
            },
            markMissingOrbitcardCards: vi.fn(async () => 0)
        };

        const mockOrbitcard = {
            ...orbitcard,
            getCardList: vi.fn(async () => ({
                success: true,
                data: [
                    { cardId: 10, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: 210, currency: 'USD', last4: '1111' },
                    { cardId: 11, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: null, currency: 'USD', last4: '2222' },
                    { cardId: 12, status: 'ACTIVE', productCode: 'amzkeys:55565979', balance: 45, currency: 'USD', last4: '3333' },
                    { cardId: 13, status: 'ACTIVE', bin: '40029999', productCode: 'amzkeys:40029999', balance: 100, currency: 'USD', last4: '4444' }
                ]
            })),
            getProductCode: vi.fn(async () => ({ success: true, data: SAMPLE_CATALOG })),
            getCardSummary: vi.fn(async (_cfg, cardId) => ({
                success: true,
                data: { cardId, balance: 65, currency: 'USD', status: 'ACTIVE', productCode: 'amzkeys:55565979' }
            }))
        };

        const result = await syncAndAutoAssignOrbitcardCards({
            store,
            orbitcard: mockOrbitcard,
            cfg: {
                orbitcard_base_url: 'https://orbitcard.cc',
                orbitcard_api_key: 'k',
                orbitcard_api_secret: 's',
                orbitcard_reuse_limits: { plus: 4, pro100: 1, pro200: 1, pro500: 1 },
                orbitcard_safety_margins: { plus: 1, pro100: 1, pro200: 1, pro500: 1 },
                orbitcard_plus_unit_price: 20
            },
            fetchDetails: false,
            markMissing: false
        });

        expect(result.success).toBe(true);
        expect(result.autoAssigned).toBe(2);
        // getCardSummary called ONLY for card 11 (unassigned with null balance), NOT for bound card 10 or blocked card 13
        expect(mockOrbitcard.getCardSummary).toHaveBeenCalledTimes(1);
        expect(mockOrbitcard.getCardSummary).toHaveBeenCalledWith(expect.any(Object), 11);

        const byId = new Map(syncedBatches[0].map((c) => [c.cardId, c]));
        // Already bound pro200 card must NOT be auto-assigned
        expect(byId.get(10).autoPlanType).toBeNull();
        // Unassigned card 11 fetched balance 65 -> floor((65-1-1)/20) = 3 Plus
        expect(byId.get(11)).toMatchObject({ autoPlanType: 'plus', autoMaxUsageCount: 3, autoInitialAmount: 65 });
        // Brand new card 12 with balance 45 -> floor((45-1-1)/20) = 2 Plus
        expect(byId.get(12)).toMatchObject({ autoPlanType: 'plus', autoMaxUsageCount: 2, autoInitialAmount: 45 });
        // Blocked 4002 card 13 must NOT be auto-assigned
        expect(byId.get(13).autoPlanType).toBeNull();
    });

    it('falls back to orbitcard_plus_unit_price when getProductCode fails', async () => {
        const syncedBatches = [];
        const store = {
            getOrbitcardCardMetaByIds: async () => [],
            syncOrbitcardCards: async (cards) => {
                syncedBatches.push(cards);
                return { total: cards.length, inserted: cards.length, updated: 0, autoAssigned: 1, autoAssignedCards: [] };
            }
        };
        const mockOrbitcard = {
            ...orbitcard,
            getProductCode: vi.fn(async () => ({ success: false, error: 'timeout' }))
        };

        const result = await syncAndAutoAssignOrbitcardCards({
            store,
            orbitcard: mockOrbitcard,
            cfg: {
                orbitcard_reuse_limits: { plus: 5 },
                orbitcard_safety_margins: { plus: 0 },
                orbitcard_plus_unit_price: 21
            },
            providerCards: [{ cardId: 50, status: 'ACTIVE', balance: 64, currency: 'USD', last4: '5555' }],
            fetchDetails: false,
            markMissing: false
        });

        expect(result.success).toBe(true);
        expect(syncedBatches[0][0]).toMatchObject({
            autoPlanType: 'plus',
            autoMaxUsageCount: 3
        });
    });
});
