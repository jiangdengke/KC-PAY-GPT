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

    it('lists all undeleted cards when the status filter is omitted', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 0, msg: 'ok', data: { list: [{ card_id: 43, status: 'CANCELLED' }], total: 1 } }
        });
        const result = await orbitcard.getCardList(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            { status: '' }
        );
        expect(result.data).toMatchObject([{ cardId: 43, status: 'CANCELLED' }]);
        expect(JSON.parse(spy.mock.calls[0][0].data)).toEqual({ page: 1, page_size: 100 });
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

    it('resolves canonical tiers from historical Orbitcard IDs and explicit price names', () => {
        const data = { list: [{
            product_code: 'visa-four-tier',
            remaining_open_card_num: 20,
            min_initial_amount: '20',
            min_retained_balance: '0.10',
            gpt_plan_prices: [
                { id: 'plus', name: 'Plus', price: '15.69', currency: 'USD' },
                { id: 'pro', name: 'Pro 100', price: '92.49', currency: 'USD' },
                { id: 'pro_20x', name: 'Pro 200', price: '142.38', currency: 'USD' },
                { id: 'pro500', name: 'Pro 500', price: '500.00', currency: 'USD' }
            ]
        }] };
        const expected = {
            plus: { id: 'plus', price: 15.69, amount: '65.00' },
            pro100: { id: 'pro', price: 92.49, amount: '95.00' },
            pro200: { id: 'pro_20x', price: 142.38, amount: '145.00' },
            pro500: { id: 'pro500', price: 500, amount: '505.00' }
        };

        for (const [planType, result] of Object.entries(expected)) {
            const selection = orbitcard.chooseProductForPlan(data, planType);
            expect(selection).toMatchObject({
                success: true,
                amount: result.amount,
                planPrice: { id: result.id, price: result.price }
            });
        }
    });

    it('lets an explicit price name override a conflicting generic legacy ID', () => {
        const data = { list: [{
            product_code: 'named-pro500',
            remaining_open_card_num: 20,
            min_initial_amount: '20',
            gpt_plan_prices: [{ id: 'pro', name: 'ChatGPT Pro 500', price: '500.00' }]
        }] };

        expect(orbitcard.chooseProductForPlan(data, 'pro500')).toMatchObject({
            success: true,
            planPrice: { id: 'pro', name: 'ChatGPT Pro 500', price: 500 }
        });
        expect(orbitcard.chooseProductForPlan(data, 'pro100')).toMatchObject({
            success: false
        });
    });

    it('flattens grouped channel responses, normalizes aliases, and deduplicates products', () => {
        const products = orbitcard.normalizeProductList({
            channels: {
                vmcardio: { products: [{ product_code: 'channel-1' }] },
                channel2: { products: [{ product_code: 'explicit-channel', channel: 1 }] },
                3: { list: [{ product_code: 'channel-3' }] }
            },
            providers: {
                fizzbolt: [{ product_code: 'provider-channel-2' }],
                amzkeys: [{ product_code: 'channel-3' }]
            },
            list: [{ product_code: 'channel-1' }]
        });
        expect(products.map((product) => product.productCode).sort()).toEqual([
            'channel-1', 'channel-3', 'explicit-channel', 'provider-channel-2'
        ]);
        expect(Object.fromEntries(products.map((product) => [product.productCode, product.channel]))).toEqual({
            'channel-1': 1,
            'explicit-channel': 1,
            'channel-3': 3,
            'provider-channel-2': 2
        });
    });

    it('infers flat product-code channels after explicit and grouped metadata', () => {
        const products = orbitcard.normalizeProductList({
            channels: {
                channel3: { products: [
                    { product_code: 'P5556XV' },
                    { product_code: 'P40005224', bin: 'grouped-bin' }
                ] },
                channel1: { products: [{ product_code: 'S24600L' }] }
            },
            list: [
                { product_code: 'P5378OX', channel: 2 },
                { product_code: 'amzkeys:55565979' },
                { product_code: 'P40005224', channel: 2, bin: 'explicit-bin' },
                { product_code: 'P40005224', bin: 'prefix-bin' }
            ]
        });
        expect(Object.fromEntries(products.map((product) => [product.productCode, product.channel]))).toEqual({
            P5556XV: 3,
            P5378OX: 2,
            P40005224: 2,
            S24600L: 1,
            'amzkeys:55565979': 3
        });
        expect(products.find((product) => product.productCode === 'P40005224')).toMatchObject({
            channel: 2,
            bin: 'explicit-bin'
        });

        const flatProducts = orbitcard.normalizeProductList([
            { product_code: 'P5556XV' },
            { product_code: 'P5378OX' },
            { product_code: 'P40005224' },
            { product_code: 'S24600L' },
            { product_code: 'S53211329' },
            { product_code: 'amzkeys:40041641' }
        ]);
        expect(Object.fromEntries(flatProducts.map((product) => [product.productCode, product.channel]))).toEqual({
            P5556XV: 1,
            P5378OX: 1,
            P40005224: 1,
            S24600L: 2,
            S53211329: 2,
            'amzkeys:40041641': 3
        });
    });

    it('merges duplicate rows without losing catalog details when channel metadata wins', () => {
        const products = orbitcard.normalizeProductList({
            list: [
                {
                    product_code: 'P5556XV',
                    bin: '555659',
                    open_card_inventory_mode: 'tracked',
                    remaining_open_card_num: 10,
                    gpt_plan_prices: [{ id: 'plus', price: '15.70' }]
                },
                {
                    product_code: 'S24600L',
                    provider: 'fizzbolt',
                    bin: '53211329',
                    open_card_inventory_mode: 'provider_validated',
                    remaining_open_card_num: 10,
                    gpt_plan_prices: [{ id: 'plus', price: '16.00' }]
                },
                {
                    product_code: 'amzkeys:55565979',
                    bin: '55565979',
                    open_card_inventory_mode: 'provider_validated',
                    remaining_open_card_num: 10,
                    gpt_plan_prices: [{ id: 'plus', price: '15.00' }]
                }
            ],
            channels: {
                channel3: { products: [{ product_code: 'P5556XV', gpt_plan_prices: [] }] },
                channel1: { products: [{ product_code: 'S24600L' }] },
                channel2: { products: [{ product_code: 'amzkeys:55565979' }] }
            }
        });
        expect(Object.fromEntries(products.map((product) => [product.productCode, product.channel]))).toEqual({
            P5556XV: 3,
            S24600L: 2,
            'amzkeys:55565979': 2
        });
        expect(products).toEqual(expect.arrayContaining([
            expect.objectContaining({
                productCode: 'P5556XV',
                bin: '555659',
                remainingOpenCardNum: 10,
                prices: [{ id: 'plus', name: '', price: 15.7, currency: 'USD' }]
            }),
            expect.objectContaining({
                productCode: 'S24600L',
                channel: 2,
                bin: '53211329',
                prices: [{ id: 'plus', name: '', price: 16, currency: 'USD' }]
            })
        ]));

        const explicitProvider = orbitcard.normalizeProductList({
            channels: { channel1: { products: [{ product_code: 'amzkeys:40041641' }] } },
            list: [{ product_code: 'amzkeys:40041641', provider: 'amzkeys' }]
        });
        expect(explicitProvider[0].channel).toBe(3);
    });

    it('keeps channel 2 products visible without changing channel 3 then channel 1 automatic priority', () => {
        const data = { list: [
            {
                product_code: 'S24600L',
                bin: '55565979',
                open_card_inventory_mode: 'provider_validated',
                remaining_open_card_num: 10,
                min_initial_amount: '20',
                gpt_plan_prices: [{ id: 'plus', price: '1.00' }]
            },
            {
                product_code: 'P5556XV',
                bin: '555659',
                open_card_inventory_mode: 'tracked',
                remaining_open_card_num: 10,
                min_initial_amount: '20',
                gpt_plan_prices: [{ id: 'plus', price: '20.00' }]
            }
        ] };
        expect(orbitcard.getProductOptionsForPlan(data, 'plus').map((item) => item.product.productCode)).toEqual([
            'S24600L', 'P5556XV'
        ]);
        expect(orbitcard.getProductSelectionsForPlan(data, 'plus').map((item) => item.product.productCode)).toEqual([
            'P5556XV'
        ]);
        expect(orbitcard.getProductSelectionsForPlan(data, 'plus', {
            preferredProductCode: 'S24600L'
        })).toMatchObject([{ product: { productCode: 'S24600L' }, channel: 2 }]);
    });

    it('preserves catalog channel fields while keeping automatic priority and 4002 exclusion', () => {
        const catalog = orbitcard.buildProductStrategyCatalog({
            channels: {
                vmcardio: { products: [{
                    product_code: 'channel-1-product',
                    bin: '53211329',
                    open_card_inventory_mode: 'provider_validated',
                    remaining_open_card_num: 0,
                    min_initial_amount: '20',
                    gpt_plan_prices: [{ id: 'plus', price: '20.00' }]
                }] },
                fizzbolt: { products: [{
                    product_code: 'channel-2-product',
                    bin: '40005224',
                    open_card_inventory_mode: 'provider_validated',
                    remaining_open_card_num: 0,
                    min_initial_amount: '20',
                    gpt_plan_prices: [{ id: 'plus', price: '16.00' }]
                }] },
                amzkeys: { products: [
                    {
                        product_code: 'amzkeys:55565979',
                        bin: '55565979',
                        open_card_inventory_mode: 'provider_validated',
                        remaining_open_card_num: 0,
                        min_initial_amount: '20',
                        gpt_plan_prices: [{ id: 'plus', price: '15.00' }]
                    },
                    {
                        product_code: 'blocked-4002',
                        bin: '400242001',
                        open_card_inventory_mode: 'provider_validated',
                        remaining_open_card_num: 0,
                        min_initial_amount: '20',
                        gpt_plan_prices: [{ id: 'plus', price: '15.00' }]
                    }
                ] }
            }
        });
        expect(catalog.products.map((product) => [product.product_code, product.channel])).toEqual([
            ['channel-1-product', 1],
            ['channel-2-product', 2],
            ['amzkeys:55565979', 3]
        ]);
        expect(catalog.automatic.plus).toMatchObject({
            product_code: 'amzkeys:55565979',
            channel: 3
        });
    });

    it('does not let an explicit channel 2 product claim channel 3 or channel 1 priority', () => {
        const data = {
            channels: {
                channel2: { products: [{
                    product_code: 'channel-2-masquerade',
                    bin: '55565979',
                    open_card_inventory_mode: 'provider_validated',
                    remaining_open_card_num: 10,
                    min_initial_amount: '20',
                    gpt_plan_prices: [{ id: 'plus', price: '1.00' }]
                }] },
                channel1: { products: [{
                    product_code: 'channel-1-priority',
                    bin: '555659',
                    open_card_inventory_mode: 'tracked',
                    remaining_open_card_num: 10,
                    min_initial_amount: '20',
                    gpt_plan_prices: [{ id: 'plus', price: '2.00' }]
                }] }
            }
        };

        expect(orbitcard.getChannel3Priority({ channel: 2, productCode: 'amzkeys:55565979', bin: '55565979' })).toBe(null);
        expect(orbitcard.getChannel1Priority({ channel: 2, inventoryMode: 'tracked', bin: '555659' })).toBe(null);
        expect(orbitcard.getProductSelectionsForPlan(data, 'plus').map((item) => item.product.productCode)).toEqual([
            'channel-1-priority'
        ]);
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

    it('uses configured reuse limits when calculating card funding and cap', () => {
        const selection = orbitcard.chooseProductForPlan({ list: [
            {
                product_code: 'visa-plus',
                remaining_open_card_num: 2,
                min_initial_amount: '20',
                min_retained_balance: '0.10',
                gpt_plan_prices: [{ id: 'plus', price: '15.75', currency: 'USD' }]
            }
        ] }, 'plus', { reuseLimits: { plus: 6 } });
        expect(selection).toMatchObject({ amount: '100.00', maxUsageCount: 6 });
        expect(orbitcard.getPlanReuseLimit('plus', { plus: 6 })).toBe(6);
    });

    it('prefers channel 3 Mastercard, then the 4004 Visa fallback', () => {
        const selection = orbitcard.chooseProductForPlan({ list: [
            { product_code: 'tracked-cheap', bin: '555659', network: 'MASTERCARD', remaining_open_card_num: 500, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:400242001', bin: '400242001', network: 'UNKNOWN', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:40041641', bin: '40041641', network: 'UNKNOWN', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:55565979', bin: '55565979', network: 'UNKNOWN', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] }
        ] }, 'plus');
        expect(selection).toMatchObject({
            success: true,
            product: { productCode: 'amzkeys:55565979' },
            channel: 3,
            channelPriority: 0
        });
        expect(orbitcard.getChannel3Priority({ productCode: 'amzkeys:400242001', bin: '400242001' })).toBe(null);
        expect(orbitcard.getProductSelectionsForPlan({ list: [
            { product_code: 'amzkeys:400242001', bin: '400242001', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'amzkeys:55565979', bin: '55565979', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'visa-40041641-duplicate', bin: '40041641', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '16.00' }] },
            { product_code: 'amzkeys:40041641', bin: '40041641', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '15', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] }
        ] }, 'plus').map((item) => item.product.productCode)).toEqual([
            'amzkeys:55565979', 'amzkeys:40041641'
        ]);
    });

    it('uses only 5556 Mastercard products for channel 1', () => {
        const selections = orbitcard.getProductSelectionsForPlan({ list: [
            { product_code: 'G5321KC', bin: '53211359', network: 'MASTERCARD', open_card_inventory_mode: 'tracked', remaining_open_card_num: 89, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '20.00' }] },
            { product_code: 'P5378OX', bin: '537872', network: 'MASTERCARD', open_card_inventory_mode: 'tracked', remaining_open_card_num: 10979, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.70' }] },
            { product_code: 'P5556XV', bin: '555659', network: 'MASTERCARD', open_card_inventory_mode: 'tracked', remaining_open_card_num: 2187, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.70' }] },
            { product_code: 'G5554LC', bin: '555671544015', network: 'MASTERCARD', open_card_inventory_mode: 'tracked', remaining_open_card_num: 1775, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '16.05' }] }
        ] }, 'plus');
        expect(selections.map((item) => item.product.productCode)).toEqual(['P5556XV', 'G5554LC']);
        expect(selections[0]).toMatchObject({
            product: { productCode: 'P5556XV', bin: '555659' },
            channel: 1,
            channelPriority: 0
        });
        expect(selections[1]).toMatchObject({
            product: { productCode: 'G5554LC', bin: '555671544015' },
            channel: 1,
            channelPriority: 0
        });
    });

    it('does not fall back to another channel 1 BIN when 5556 is unavailable', () => {
        const selections = orbitcard.getProductSelectionsForPlan({ list: [
            { product_code: 'P5378OX', bin: '537872', open_card_inventory_mode: 'tracked', remaining_open_card_num: 10, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.70' }] },
            { product_code: 'G5321KC', bin: '53211359', open_card_inventory_mode: 'tracked', remaining_open_card_num: 10, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '20.00' }] }
        ] }, 'plus');
        expect(selections).toEqual([]);
    });

    it('honors a one-time preferred product code across channels', () => {
        const catalog = { list: [
            { product_code: 'amzkeys:55565979', bin: '55565979', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'P5556XV', bin: '555659', open_card_inventory_mode: 'tracked', remaining_open_card_num: 10, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.70' }] }
        ] };
        const selection = orbitcard.getProductSelectionsForPlan(catalog, 'plus', { preferredProductCode: 'P5556XV' });
        expect(selection).toHaveLength(1);
        expect(selection[0]).toMatchObject({ product: { productCode: 'P5556XV' }, channel: 1 });
        expect(orbitcard.getProductOptionsForPlan(catalog, 'plus').map((item) => item.product.productCode)).toEqual([
            'amzkeys:55565979', 'P5556XV'
        ]);
    });

    it('honors a manually selected available product outside the automatic channel allowlist', () => {
        const catalog = { list: [
            { product_code: 'amzkeys:55565979', bin: '55565979', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] },
            { product_code: 'G5321KC', bin: '53211329', network: 'MASTERCARD', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '20.00' }] },
            { product_code: 'NO-PLUS-PRICE', bin: '40005224', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'pro', price: '90.00' }] },
            { product_code: 'amzkeys:400242001', bin: '400242001', open_card_inventory_mode: 'tracked', remaining_open_card_num: 10, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] }
        ] };

        const automatic = orbitcard.getProductSelectionsForPlan(catalog, 'plus');
        expect(automatic.map((item) => item.product.productCode)).toEqual(['amzkeys:55565979']);
        expect(orbitcard.getProductOptionsForPlan(catalog, 'plus').map((item) => item.product.productCode)).toEqual([
            'amzkeys:55565979'
        ]);

        const manual = orbitcard.getProductSelectionsForPlan(catalog, 'plus', { preferredProductCode: 'G5321KC' });
        expect(manual).toHaveLength(1);
        expect(manual[0]).toMatchObject({
            product: { productCode: 'G5321KC', bin: '53211329' },
            planPrice: { id: 'plus', price: 20 },
            channel: null,
            amount: '85.00'
        });
        expect(orbitcard.getProductSelectionsForPlan(catalog, 'plus', {
            preferredProductCode: 'NO-PLUS-PRICE'
        })).toEqual([]);
        expect(orbitcard.getProductSelectionsForPlan(catalog, 'plus', {
            preferredProductCode: 'amzkeys:400242001'
        })).toEqual([]);
    });

    it('includes every available non-blocked product in the strategy catalog without changing automatic priority', () => {
        const catalog = orbitcard.buildProductStrategyCatalog({ list: [
            { product_code: 'G5321KC', bin: '53211329', network: 'MASTERCARD', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '20.00' }] },
            { product_code: 'P5556XV', bin: '555659', network: 'MASTERCARD', open_card_inventory_mode: 'tracked', remaining_open_card_num: 2187, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.70' }] },
            { product_code: 'G4000KC', bin: '40005224', network: 'VISA', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '16.00' }] },
            { product_code: 'OUT-OF-STOCK', bin: '53219999', open_card_inventory_mode: 'tracked', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '16.00' }] },
            { product_code: 'BLOCKED-4002', bin: '400242001', open_card_inventory_mode: 'provider_validated', remaining_open_card_num: 0, min_initial_amount: '20', gpt_plan_prices: [{ id: 'plus', price: '15.00' }] }
        ] });

        expect(catalog.products.map((product) => product.product_code)).toEqual([
            'P5556XV', 'G4000KC', 'G5321KC'
        ]);
        expect(catalog.products.find((product) => product.product_code === 'G5321KC')).toMatchObject({
            channel: null,
            plans: { plus: { plan_price: 20 } }
        });
        expect(catalog.automatic.plus).toMatchObject({
            product_code: 'P5556XV',
            channel: 1
        });
    });

    it('builds one live product catalog with amounts for all supported plans', () => {
        const catalog = orbitcard.buildProductStrategyCatalog({ list: [{
            product_code: 'P5556XV',
            bin: '555659',
            network: 'MASTERCARD',
            open_card_inventory_mode: 'tracked',
            remaining_open_card_num: 2035,
            min_initial_amount: '20',
            min_retained_balance: '0.10',
            gpt_plan_prices: [
                { id: 'plus', price: '15.70', currency: 'USD' },
                { id: 'pro100', price: '92.61', currency: 'USD' },
                { id: 'pro200', price: '142.55', currency: 'USD' },
                { id: 'pro500', price: '499.00', currency: 'USD' }
            ]
        }] });
        expect(catalog.products).toHaveLength(1);
        expect(catalog.products[0]).toMatchObject({
            product_code: 'P5556XV',
            remaining_open_card_num: 2035,
            plans: {
                plus: { amount: '65.00', plan_price: 15.7, max_usage_count: 4 },
                pro100: { amount: '95.00', plan_price: 92.61, max_usage_count: 1 },
                pro200: { amount: '145.00', plan_price: 142.55, max_usage_count: 1 },
                pro500: { amount: '505.00', plan_price: 499, max_usage_count: 1 }
            }
        });
        expect(catalog.automatic.plus).toMatchObject({
            product_code: 'P5556XV',
            amount: '65.00',
            max_usage_count: 4
        });
    });

    it('blocks existing 4002 cards from reuse', () => {
        expect(orbitcard.isBlockedCardProduct({
            productCode: 'amzkeys:400242001',
            bin: '400242001',
            raw: { card_number_masked: '400242******5810' }
        })).toBe(true);
        expect(orbitcard.isBlockedCardProduct({
            productCode: 'amzkeys:40041641',
            bin: '40041641'
        })).toBe(false);
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

    it('waits for pending_confirm with the same request and idempotency key', async () => {
        const spy = vi.spyOn(axios, 'request')
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    code: 0,
                    msg: 'ok',
                    data: { order_no: 'OC-PENDING-1', status: 'pending_confirm', initial_amount: '65.00' }
                }
            })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    code: 0,
                    msg: 'ok',
                    data: { order_no: 'OC-PENDING-1', card_id: 88, status: 'success', initial_amount: '65.00' }
                }
            });
        const wait = vi.fn().mockResolvedValue(undefined);
        const onPending = vi.fn().mockResolvedValue(undefined);
        const result = await orbitcard.createCardUntilReady(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            { productCode: 'amzkeys:55565979', amount: '65.00', quantity: 1, idempotencyKey: 'orbitcard-job-pending-1' },
            { maxAttempts: 3, pollIntervalMs: 1, wait, onPending }
        );
        expect(result).toMatchObject({
            success: true,
            cardId: 88,
            orderNo: 'OC-PENDING-1',
            createStatus: 'success',
            attempts: 2,
            pending: false
        });
        expect(wait).toHaveBeenCalledOnce();
        expect(onPending).toHaveBeenCalledWith(expect.objectContaining({
            attempt: 1,
            orderNo: 'OC-PENDING-1',
            status: 'pending_confirm'
        }));
        expect(spy).toHaveBeenCalledTimes(2);
        for (const request of spy.mock.calls.map((call) => call[0])) {
            expect(request.data).toBe('{"product_code":"amzkeys:55565979","amount":"65.00","quantity":1}');
            expect(request.headers['Idempotency-Key']).toBe('orbitcard-job-pending-1');
        }
    });

    it('returns an unresolved pending order without creating a different request', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                code: 0,
                msg: 'ok',
                data: { order_no: 'OC-PENDING-2', status: 'processing', initial_amount: '65.00' }
            }
        });
        const result = await orbitcard.createCardUntilReady(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            { productCode: 'amzkeys:55565979', amount: '65.00', quantity: 1, idempotencyKey: 'orbitcard-job-pending-2' },
            { maxAttempts: 3, pollIntervalMs: 0, wait: vi.fn().mockResolvedValue(undefined) }
        );
        expect(result).toMatchObject({
            success: false,
            pending: true,
            orderNo: 'OC-PENDING-2',
            createStatus: 'processing',
            attempts: 3
        });
        expect(spy).toHaveBeenCalledTimes(3);
        expect(new Set(spy.mock.calls.map((call) => call[0].headers['Idempotency-Key']))).toEqual(
            new Set(['orbitcard-job-pending-2'])
        );
    });

    it('treats a successful response without card_id as ambiguous and does not retry it', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                code: 0,
                msg: 'ok',
                data: { order_no: 'OC-UNKNOWN-1', status: 'unexpected_state', initial_amount: '65.00' }
            }
        });
        const result = await orbitcard.createCardUntilReady(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            { productCode: 'amzkeys:55565979', amount: '65.00', quantity: 1, idempotencyKey: 'orbitcard-job-unknown-1' },
            { maxAttempts: 3, pollIntervalMs: 0 }
        );
        expect(result).toMatchObject({
            success: false,
            pending: false,
            ambiguous: true,
            orderNo: 'OC-UNKNOWN-1',
            createStatus: 'unexpected_state',
            attempts: 1
        });
        expect(spy).toHaveBeenCalledOnce();
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

    it('reads the documented available_amount card balance field', async () => {
        vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: { code: 0, msg: 'ok', data: { available_amount: '42.75', status: 'ACTIVE' } }
        });
        const result = await orbitcard.getCardSummary(
            { base_url: 'https://orbitcard.cc', api_key: 'k', api_secret: 's' },
            99
        );
        expect(result).toMatchObject({
            success: true,
            data: { cardId: 99, balance: 42.75, balanceField: 'available_amount' }
        });
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
