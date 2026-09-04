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
    const cards = await getCardList(cfg);
    if (!cards.success) return { success: false, error: `Orbitcard 卡列表查询失败: ${cards.error}` };
    const balanceData = balance.data || {};
    return {
        success: true,
        message: `Orbitcard 连接成功（可用卡 ${cards.data.length} 张，账户余额 ${balanceData.available_balance ?? '—'}）`,
        balance: balanceData,
        cards: cards.data.map((card) => ({ cardId: card.cardId, last4: card.last4, status: card.status })),
        cardCount: cards.data.length
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
    getCardList,
    getCardDetail,
    testConnection
};
