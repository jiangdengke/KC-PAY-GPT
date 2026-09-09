'use strict';

const axios = require('axios');
const orbitcard = require('../orbitcard-client');

describe('orbitcard client', () => {
    afterEach(() => vi.restoreAllMocks());

    it('signs the exact JSON body with HMAC headers', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 0, msg: 'ok', data: { available_balance: '100.00' } }
        });
        const out = await orbitcard.getAccountBalance({
            base_url: 'https://orbitcard.cc',
            api_key: 'orbit_test_key',
            api_secret: 'orbit_test_secret'
        });
        expect(out.success).toBe(true);
        const request = spy.mock.calls[0][0];
        expect(request.url).toBe('https://orbitcard.cc/api/open/v1/getAccountBalance');
        expect(request.data).toBe('{}');
        expect(request.headers).toMatchObject({
            'X-API-Key': 'orbit_test_key',
            'X-Timestamp': expect.any(String),
            'X-Nonce': expect.any(String),
            'X-Signature': expect.stringMatching(/^[a-f0-9]{64}$/)
        });
        expect(request.headers['Idempotency-Key']).toBeUndefined();
    });

    it('normalizes active cards and validates sensitive card details', async () => {
        vi.spyOn(axios, 'request')
            .mockResolvedValueOnce({
                status: 200,
                data: { code: 0, msg: 'ok', data: { list: [{ card_id: 42, status: 'ACTIVE', card_number: '•••• 4242' }] } }
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { code: 0, msg: 'ok', data: { card_number: '4242 4242 4242 4242', cvv: '123', expire: '12/30' } }
            });
        const list = await orbitcard.getCardList({ base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' });
        const detail = await orbitcard.getCardDetail({ base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' }, 42);
        expect(list.data[0]).toMatchObject({ cardId: 42, status: 'ACTIVE', last4: '4242' });
        expect(detail.data).toMatchObject({ cardId: 42, cardNumber: '4242424242424242', cvc: '123', expiry: '12/30' });
    });

    it('selects an available product and calculates a one-time card amount per plan', () => {
        const selection = orbitcard.chooseProductForPlan({ list: [
            {
                product_code: 'visa-1',
                remaining_open_card_num: 20,
                min_initial_amount: '20',
                min_retained_balance: '0.10',
                gpt_plan_prices: [
                    { id: 'plus', price: '15.78', currency: 'USD' },
                    { id: 'pro', price: '95.57', currency: 'USD' },
                    { id: 'pro_20x', price: '143.40', currency: 'USD' }
                ]
            }
        ] }, 'pro_5x');
        expect(selection).toMatchObject({
            success: true,
            amount: '100.00',
            product: { productCode: 'visa-1' },
            planPrice: { id: 'pro', price: 95.57 }
        });
        expect(orbitcard.chooseProductForPlan({ list: [
            { product_code: 'visa-1', remaining_open_card_num: 20, min_initial_amount: '20', min_retained_balance: '0.10', gpt_plan_prices: [{ id: 'pro_20x', price: '143.40' }] }
        ] }, 'pro_20x').amount).toBe('145.00');
    });

    it('budgets a Plus card for four sequential charges', () => {
        const selection = orbitcard.chooseProductForPlan({ list: [
            {
                product_code: 'visa-plus',
                remaining_open_card_num: 2,
                min_initial_amount: '20',
                min_retained_balance: '0.10',
                gpt_plan_prices: [{ id: 'plus', price: '15.75', currency: 'USD' }]
            }
        ] }, 'plus');
        expect(selection).toMatchObject({ success: true, amount: '65.00', maxUsageCount: 4 });
        expect(orbitcard.getPlanReuseLimit('pro_5x')).toBe(1);
        expect(orbitcard.getPlanReuseLimit('pro_20x')).toBe(1);
    });

    it('prefers channel 3 Mastercard, then its Visa fallbacks', () => {
        const selection = orbitcard.chooseProductForPlan({ list: [
            { product_code: 'tracked-cheap', bin: '555659', network: 'MASTERCARD', remaining_open_card_num: 500, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:40041641', bin: '40041641', network: 'UNKNOWN', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:55565979', bin: '55565979', network: 'UNKNOWN', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] }
        ] }, 'plus');
        expect(selection).toMatchObject({
            success: true,
            product: { productCode: 'amzkeys:55565979' },
            channel: 3,
            channelPriority: 0
        });
        expect(orbitcard.getChannel3Priority({ productCode: 'amzkeys:400242001', bin: '400242001' })).toBe(1);
        expect(orbitcard.getProductSelectionsForPlan({ list: [
            { product_code: 'amzkeys:40041641', bin: '40041641', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'visa-40041641-duplicate', bin: '40041641', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '16.00' }] },
            { product_code: 'amzkeys:55565979', bin: '55565979', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:400242001', bin: '400242001', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '15', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] }
        ] }, 'plus').map((item) => item.product.productCode)).toEqual([
            'amzkeys:55565979', 'amzkeys:400242001', 'amzkeys:40041641'
        ]);
    });

    it('creates exactly one card with the documented idempotency key', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 201,
            data: { code: 0, msg: 'ok', data: { card_id: 77, quantity: 1, status: 'PENDING' } }
        });
        const result = await orbitcard.createCard(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            { productCode: 'visa-1', amount: '100.00', quantity: 1, idempotencyKey: 'orbitcard-job-1' }
        );
        expect(result.success).toBe(true);
        expect(orbitcard.extractCreatedCardId(result.data)).toBe(77);
        expect(JSON.parse(spy.mock.calls[0][0].data)).toEqual({ product_code: 'visa-1', amount: '100.00', quantity: 1 });
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toBe('orbitcard-job-1');
    });

    it('reads a non-sensitive card balance when the provider includes one', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                code: 0,
                msg: 'ok',
                data: {
                    card: {
                        card_id: 42,
                        status: 'ACTIVE',
                        last4: '4242',
                        balance_info: { available_balance: '37.50', currency: 'USD' }
                    }
                }
            }
        });
        const result = await orbitcard.getCardSummary(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            42
        );
        expect(result).toMatchObject({
            success: true,
            data: { cardId: 42, last4: '4242', balance: 37.5, balanceField: 'balance_info.available_balance', currency: 'USD' }
        });
        expect(spy.mock.calls[0][0].url).toBe('https://orbitcard.cc/api/open/v1/cardDetail');
        expect(JSON.parse(spy.mock.calls[0][0].data)).toEqual({ card_id: 42, reveal_sensitive: false });
    });

    it('uses an idempotent request to unfreeze a card', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 0, msg: 'ok', data: { card_id: 42, status: 'ACTIVE' } }
        });
        const result = await orbitcard.setCardStatus(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            42,
            'ACTIVE',
            'restore-card-42'
        );
        expect(result.success).toBe(true);
        expect(JSON.parse(spy.mock.calls[0][0].data)).toEqual({ card_id: 42, status: 'ACTIVE' });
        expect(spy.mock.calls[0][0].headers['Idempotency-Key']).toBe('restore-card-42');
    });
});
