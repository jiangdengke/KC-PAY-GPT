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
});
