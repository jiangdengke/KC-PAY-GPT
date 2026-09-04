'use strict';

const crypto = require('crypto');
const axios = require('axios');

const DEFAULT_BASE_URL = 'https://orbitcard.cc';

function normalizeBaseUrl(raw) {
    return String(raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function isOrbitcardConfigured(cfg = {}) {
    return String(cfg.card_source || '').trim().toLowerCase() === 'orbitcard';
}

function maskApiKey(key) {
    const value = String(key || '').trim();
    if (!value) return '';
    if (value.length <= 8) return '****';
    return `${value.slice(0, 6)}\u2026${value.slice(-4)}`;
}

function createSignedHeaders(cfg, path, rawBody, idempotencyKey = '') {
    const apiKey = String(cfg.api_key || '').trim();
    const secret = String(cfg.api_secret || '').trim();
    if (!apiKey) throw new Error('Orbitcard API Key 未配置');
    if (!secret) throw new Error('Orbitcard API Secret 未配置');

    const base = new URL(normalizeBaseUrl(cfg.base_url));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(24).toString('base64url');
    const idempotency = String(idempotencyKey || '');
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const canonical = [
        'ORBITCARD-HMAC-SHA256-V1',
        apiKey,
        timestamp,
        nonce,
        'POST',
        base.host,
        path,
        '',
        bodyHash,
        idempotency
    ].join('\n');
    const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': apiKey,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': signature
    };
    if (idempotency) headers['Idempotency-Key'] = idempotency;
    return headers;
}

async function request(path, cfg, body = {}, { idempotencyKey = '', timeoutMs = 30000 } = {}) {
    const rawBody = JSON.stringify(body == null ? {} : body);
    let headers;
    try {
        headers = createSignedHeaders(cfg, path, rawBody, idempotencyKey);
    } catch (error) {
        return { success: false, error: error.message };
    }

    try {
        const response = await axios.request({
            method: 'POST',
            url: `${normalizeBaseUrl(cfg.base_url)}${path}`,
            headers,
            data: rawBody,
            transformRequest: [(data) => data],
            validateStatus: () => true,
            timeout: Number(timeoutMs) || 30000
        });
        let payload = response.data;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (_) { payload = { _raw: payload }; }
        }
        const ok = response.status >= 200 && response.status < 300 && payload?.code === 0;
        return {
            success: ok,
            status: response.status,
            data: payload?.data,
            raw: payload,
            error: ok ? undefined : String(payload?.msg || payload?.message || `HTTP ${response.status}`)
        };
    } catch (error) {
        return { success: false, error: error.message || 'Orbitcard 请求失败' };
    }
}

async function getAccountBalance(cfg) {
    return request('/api/open/v1/getAccountBalance', cfg, {});
}

async function getProductCode(cfg) {
    return request('/api/open/v1/getProductCode', cfg, {});
}

const PLAN_PRICE_ALIASES = Object.freeze({
    plus: ['plus'],
    pro_5x: ['pro_5x', 'pro5x', 'prolite', 'pro'],
    pro_20x: ['pro_20x', 'pro20x', 'pro-20x']
});

const FALLBACK_CARD_AMOUNTS = Object.freeze({
    plus: 20,
    pro_5x: 100,
    pro_20x: 150
});

function normalizeProduct(row = {}) {
    const prices = Array.isArray(row.gpt_plan_prices)
        ? row.gpt_plan_prices.map((price) => ({
            id: String(price?.id || '').trim().toLowerCase(),
            name: String(price?.name || '').trim(),
            price: Number(price?.price),
            currency: String(price?.currency || 'USD').trim().toUpperCase()
        })).filter((price) => price.id && Number.isFinite(price.price) && price.price > 0)
        : [];
    const remaining = Number(row.remaining_open_card_num);
    return {
        productCode: String(row.product_code || row.productCode || '').trim(),
        minInitialAmount: Number(row.min_initial_amount),
        minRetainedBalance: Number(row.min_retained_balance),
        remainingOpenCardNum: Number.isFinite(remaining) ? remaining : null,
        inventoryMode: String(row.open_card_inventory_mode || '').trim(),
        cardType: String(row.card_type || '').trim(),
        network: String(row.network || '').trim(),
        issuingArea: String(row.issuing_area || '').trim(),
        prices,
        raw: row
    };
}

function normalizeProductList(data) {
    const source = data && typeof data === 'object' ? data : {};
    const rows = Array.isArray(source)
        ? source
        : (Array.isArray(source.list) ? source.list : (Array.isArray(source.products) ? source.products : []));
    return rows.map(normalizeProduct).filter((product) => product.productCode);
}

function resolveProductPlanPrice(product, planType) {
    const aliases = PLAN_PRICE_ALIASES[String(planType || 'plus').trim()] || PLAN_PRICE_ALIASES.plus;
    for (const alias of aliases) {
        const match = product.prices.find((price) => price.id === alias);
        if (match) return match;
    }
    return null;
}

function chooseProductForPlan(data, planType = 'plus') {
    const products = normalizeProductList(data)
        .filter((product) => product.remainingOpenCardNum == null || product.remainingOpenCardNum > 0)
        .map((product) => ({ product, planPrice: resolveProductPlanPrice(product, planType) }));
    if (!products.length) return { success: false, error: 'Orbitcard 当前没有可开卡产品库存' };

    // Prefer a product with a live plan price, then the lowest current price.
    products.sort((a, b) => {
        if (Boolean(a.planPrice) !== Boolean(b.planPrice)) return a.planPrice ? -1 : 1;
        if (a.planPrice && b.planPrice && a.planPrice.price !== b.planPrice.price) {
            return a.planPrice.price - b.planPrice.price;
        }
        return a.product.productCode.localeCompare(b.product.productCode);
    });
    const selected = products[0];
    const product = selected.product;
    const minimum = Number.isFinite(product.minInitialAmount) && product.minInitialAmount > 0
        ? product.minInitialAmount
        : 20;
    const retained = Number.isFinite(product.minRetainedBalance) && product.minRetainedBalance > 0
        ? product.minRetainedBalance
        : 0;
    const fallback = FALLBACK_CARD_AMOUNTS[String(planType || 'plus').trim()] || FALLBACK_CARD_AMOUNTS.plus;
    const priceTarget = selected.planPrice ? selected.planPrice.price + retained + 1 : fallback;
    const rawAmount = Math.max(minimum, priceTarget);
    const amount = (Math.ceil(rawAmount / 5) * 5).toFixed(2);
    return {
        success: true,
        product,
        planPrice: selected.planPrice,
        amount,
        candidates: products.map(({ product: item, planPrice }) => ({
            productCode: item.productCode,
            remainingOpenCardNum: item.remainingOpenCardNum,
            minInitialAmount: item.minInitialAmount,
            minRetainedBalance: item.minRetainedBalance,
            planPrice: planPrice?.price ?? null,
            currency: planPrice?.currency || 'USD'
        }))
    };
}

async function createCard(cfg, { productCode, amount, quantity = 1, idempotencyKey } = {}) {
    const code = String(productCode || '').trim();
    const value = Number(amount);
    const count = Number(quantity);
    if (!code) return { success: false, error: 'Orbitcard product_code 未配置' };
    if (!Number.isFinite(value) || value <= 0) return { success: false, error: 'Orbitcard 开卡金额无效' };
    if (!Number.isInteger(count) || count !== 1) return { success: false, error: 'Orbitcard 当前仅支持单卡开卡' };
    return request('/api/open/v1/createCard', cfg, {
        product_code: code,
        amount: value.toFixed(2),
        quantity: 1
    }, { idempotencyKey: String(idempotencyKey || '').trim() });
}

function extractCreatedCardId(data) {
    const source = data && typeof data === 'object' ? data : {};
    const item = Array.isArray(source.items) ? source.items[0] : null;
    const card = source.card && typeof source.card === 'object' ? source.card : null;
    const value = source.card_id ?? source.cardId ?? source.id ?? card?.card_id ?? card?.cardId ?? card?.id
        ?? item?.card_id ?? item?.cardId ?? item?.id;
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeCard(row = {}) {
    const cardId = row.card_id ?? row.cardId ?? row.id;
    return {
        cardId: Number(cardId),
        status: String(row.status || 'ACTIVE').trim().toUpperCase(),
        last4: String(row.last4 || row.card_last4 || row.cardLast4 || row.card_number || row.cardNumber || '').slice(-4),
        productCode: String(row.product_code || row.productCode || '').trim(),
        raw: row
    };
}

async function getCardList(cfg, { pageSize = 100 } = {}) {
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 100, 100));
    const list = [];
    for (let page = 1; page <= 100; page += 1) {
        const result = await request('/api/open/v1/getCardList', cfg, {
            page,
            page_size: safePageSize,
            status: 'ACTIVE'
        });
        if (!result.success) return result;
        const data = result.data || {};
        const rows = Array.isArray(data)
            ? data
            : (Array.isArray(data.list) ? data.list : (Array.isArray(data.cards) ? data.cards : []));
        list.push(...rows.map(normalizeCard).filter((card) => Number.isInteger(card.cardId) && card.cardId > 0));
        const total = Number(data.total);
        if (!rows.length || rows.length < safePageSize || (Number.isFinite(total) && list.length >= total)) break;
    }
    return { success: true, status: 200, data: list, raw: list };
}

async function getCardDetail(cfg, cardId) {
    const id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'Orbitcard card_id 无效' };
    const result = await request('/api/open/v1/cardDetail', cfg, { card_id: id, reveal_sensitive: true });
    if (!result.success) return result;
    const row = result.data?.card && typeof result.data.card === 'object'
        ? { ...result.data, ...result.data.card }
        : (result.data || {});
    const cardNumber = String(row.card_number || row.cardNumber || row.pan || '').replace(/[\s-]+/g, '');
    const cvc = String(row.cvv || row.cvc || row.security_code || row.securityCode || '').trim();
    const expiry = String(row.expire || row.expiry || row.expiration || row.card_expiry || '').trim();
    if (!/^\d{13,19}$/.test(cardNumber) || !/^\d{3,4}$/.test(cvc) || !expiry) {
        return { success: false, status: result.status, error: 'Orbitcard 卡详情未返回完整卡资料，请确认 API Key 具备 cards:sensitive Scope' };
    }
    return {
        success: true,
        status: result.status,
        data: {
            cardId: id,
            cardNumber,
            cvc,
            expiry,
            holder: String(row.cardholder_name || row.card_holder || row.cardholderName || '').trim(),
            country: String(row.country || '').trim(),
            raw: row
        },
        raw: result.raw
    };
}

async function testConnection(cfg) {
    const balance = await getAccountBalance(cfg);
    if (!balance.success) return { success: false, error: `Orbitcard 余额查询失败: ${balance.error}` };
    const products = await getProductCode(cfg);
    if (!products.success) return { success: false, error: `Orbitcard 产品目录查询失败: ${products.error}` };
    const cards = await getCardList(cfg);
    if (!cards.success) return { success: false, error: `Orbitcard 卡列表查询失败: ${cards.error}` };
    const balanceData = balance.data || {};
    const productList = normalizeProductList(products.data);
    return {
        success: true,
        message: `Orbitcard 连接成功（可开卡产品 ${productList.length} 个，现有卡 ${cards.data.length} 张，账户余额 ${balanceData.available_balance ?? '—'}）`,
        balance: balanceData,
        cards: cards.data.map((card) => ({ cardId: card.cardId, last4: card.last4, status: card.status })),
        cardCount: cards.data.length,
        productCount: productList.length,
        products: productList.map((product) => ({
            productCode: product.productCode,
            remainingOpenCardNum: product.remainingOpenCardNum,
            minInitialAmount: product.minInitialAmount,
            minRetainedBalance: product.minRetainedBalance,
            prices: product.prices
        }))
    };
}

module.exports = {
    DEFAULT_BASE_URL,
    normalizeBaseUrl,
    isOrbitcardConfigured,
    maskApiKey,
    request,
    getAccountBalance,
    getProductCode,
    normalizeProduct,
    normalizeProductList,
    resolveProductPlanPrice,
    chooseProductForPlan,
    createCard,
    extractCreatedCardId,
    getCardList,
    getCardDetail,
    testConnection
};
