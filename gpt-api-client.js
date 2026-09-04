'use strict';

/**
 * 第三方 GPT 代充 API 客户端（协议见 协议api.md）
 *
 * 基础 URL:   旧协议可直接填写供应商地址；Desolate Open 平台可填写
 *             https://recharge.desolate.run 或完整 /api/v1/open 地址
 * 认证:       旧协议使用 Authorization: Bearer；Desolate Open 使用 X-API-Key
 * 幂等键:     Idempotency-Key（提交代充必须带上）
 *
 * 本模块仅做轻量封装：提交代充、查询订单/任务状态、查询套餐/余额、测试连通。
 */

const axios = require('axios');
const orbitcard = require('./orbitcard-client');

const DEFAULT_BASE_URL = 'https://kc.vpss.eu.cc/';
const DEFAULT_OPEN_BASE_URL = 'https://recharge.desolate.run/api/v1/open';
const OPEN_PROVIDER_HOST = 'recharge.desolate.run';
const OPEN_PLAN_ALIASES = Object.freeze({
    plus: 'chatgptplusplan',
    pro5x: 'chatgptprolite',
    pro_5x: 'chatgptprolite',
    pro20x: 'chatgptpro',
    pro_20x: 'chatgptpro'
});

function normalizeBaseUrl(raw) {
    const url = String(raw || '').trim().replace(/\/+$/, '');
    if (!url) return '';
    return url;
}

function isDesolateOpenProtocol(cfg = {}) {
    if (String(cfg.protocol || '').trim().toLowerCase() === 'desolate_open') return true;
    const raw = normalizeBaseUrl(cfg.base_url);
    if (!raw) return false;
    try {
        const url = new URL(raw);
        return url.hostname.toLowerCase() === OPEN_PROVIDER_HOST
            || /\/api\/v1\/open$/i.test(url.pathname);
    } catch (_) {
        return /recharge\.desolate\.run|\/api\/v1\/open$/i.test(raw);
    }
}

function resolveBaseUrl(cfg = {}) {
    const raw = normalizeBaseUrl(cfg.base_url)
        || (isDesolateOpenProtocol(cfg) ? DEFAULT_OPEN_BASE_URL : DEFAULT_BASE_URL);
    if (!isDesolateOpenProtocol(cfg)) return raw;
    if (/\/api\/v1\/open$/i.test(raw)) return raw;
    if (/\/api\/v1$/i.test(raw)) return raw.replace(/\/api\/v1$/i, '/api/v1/open');
    return `${raw}/api/v1/open`;
}

function resolveOpenPlanCode(planKey) {
    const value = String(planKey || '').trim();
    return OPEN_PLAN_ALIASES[value.toLowerCase()] || value || OPEN_PLAN_ALIASES.plus;
}

function resolveOpenPlanMappings(planKey) {
    const configured = String(planKey || '').trim();
    const standardCodes = new Set([
        'chatgptplusplan',
        'chatgptprolite',
        'chatgptpro',
        ...Object.keys(OPEN_PLAN_ALIASES)
    ]);
    if (configured && !standardCodes.has(configured.toLowerCase())) {
        return { plus: configured, pro_5x: configured, pro_20x: configured };
    }
    return {
        plus: resolveOpenPlanCode('plus'),
        pro_5x: resolveOpenPlanCode('pro_5x'),
        pro_20x: resolveOpenPlanCode('pro_20x')
    };
}

function maskApiKey(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    if (k.length <= 8) return '****';
    return `${k.slice(0, 6)}\u2026${k.slice(-4)}`;
}

/**
 * 统一请求封装，始终返回 { success, status?, data?, error? }
 */
async function request(method, path, cfg, { body, headers: extraHeaders, timeoutMs } = {}) {
    const openProtocol = isDesolateOpenProtocol(cfg);
    const base = resolveBaseUrl(cfg);
    const apiKey = String(cfg?.api_key || '').trim();
    if (!apiKey) {
        return { success: false, error: '缺少 API Key' };
    }

    const headers = {
        ...(openProtocol ? { 'X-API-Key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(extraHeaders || {})
    };

    try {
        const response = await axios.request({
            method,
            url: `${base}${path}`,
            headers,
            data: body == null ? undefined : body,
            validateStatus: () => true,
            timeout: Number(timeoutMs) || 30000
        });
        let data = response.data;
        if (data == null) data = {};
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (_) { data = { _raw: data }; }
        }
        const ok = response.status >= 200 && response.status < 300
            && (!openProtocol || data?.code === 0);
        const responseHeaders = response.headers || {};
        const retryAfterRaw = responseHeaders['retry-after'] ?? responseHeaders['Retry-After'];
        const retryAfterSeconds = Number(retryAfterRaw);
        return {
            success: ok,
            status: response.status,
            data,
            headers: responseHeaders,
            retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
                ? retryAfterSeconds * 1000
                : null,
            error: ok ? undefined : extractErrorDetail(data, response.status)
        };
    } catch (error) {
        let detail = '请求失败';
        if (error?.response?.data) {
            detail = extractErrorDetail(error.response.data, error.response.status);
        } else if (error?.code === 'ECONNABORTED') {
            detail = '请求超时';
        } else if (error?.message) {
            detail = error.message;
        }
        return { success: false, error: detail };
    }
}

function unwrapOpenResponse(data) {
    return data && typeof data === 'object' && data.code === 0
        && Object.prototype.hasOwnProperty.call(data, 'data')
        ? data.data
        : data;
}

function normalizeOpenSession(session, sessionToken) {
    const source = session && typeof session === 'object' ? session : {};
    const normalized = { ...source };
    normalized.accessToken = String(normalized.accessToken || normalized.access_token || '').trim();
    normalized.sessionToken = String(normalized.sessionToken || normalized.session_token || sessionToken || '').trim();
    if (!normalized.user || typeof normalized.user !== 'object') normalized.user = {};
    if (!normalized.account || typeof normalized.account !== 'object') normalized.account = {};
    return normalized;
}

function validateOpenSession(session, sessionToken) {
    const value = normalizeOpenSession(session, sessionToken);
    const email = String(value.user?.email || '').trim();
    const userId = String(value.user?.id || '').trim();
    const accountId = String(value.account?.id || '').trim();
    if (!email || !userId) return { valid: false, error: 'Session 缺少 user.id 或 user.email' };
    if (!accountId) return { valid: false, error: 'Session 缺少 account.id' };
    if (!/^[^.]+\.[^.]+\.[^.]+$/.test(value.accessToken)) return { valid: false, error: 'Session 的 accessToken 不是有效 JWT' };
    if (!value.sessionToken) return { valid: false, error: 'Session 缺少 sessionToken，请导出完整 cookies' };
    if (value.sessionToken === value.accessToken) return { valid: false, error: 'Session 的 sessionToken 不能与 accessToken 相同' };
    if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value.sessionToken)) return { valid: false, error: 'Session 的 sessionToken 包含不支持的字符' };
    if (!value.expires || Number.isNaN(Date.parse(value.expires))) return { valid: false, error: 'Session 缺少有效 expires' };
    return { valid: true, session: value };
}

/**
 * 从上游响应中提取可读的错误信息（兼容 detail/message/error 等常见字段）
 */
function extractErrorDetail(data, status) {
    if (!data || typeof data !== 'object') {
        return `HTTP ${status || ''} ${JSON.stringify(data || '')}`.trim();
    }
    if (typeof data.detail === 'string' && data.detail) return data.detail;
    if (data.detail && typeof data.detail === 'object' && !Array.isArray(data.detail)) {
        const code = String(data.detail.error || data.detail.code || '').trim();
        const reason = String(data.detail.reason || '').trim();
        const upstream = data.detail.upstream_status ? `upstream ${data.detail.upstream_status}` : '';
        const parts = [code, reason, upstream].filter(Boolean);
        if (parts.length) return parts.join(' / ');
        return JSON.stringify(data.detail).slice(0, 300);
    }
    if (Array.isArray(data.detail) && data.detail.length) {
        return data.detail.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join('; ');
    }
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.error === 'string' && data.error) return data.error;
    if (typeof data.msg === 'string' && data.msg) return data.msg;
    const raw = JSON.stringify(data);
    if (raw && raw !== '{}') return raw.slice(0, 300);
    return `HTTP ${status || ''}`;
}

/**
 * 查询可用 GPT 套餐 (GET /plans)
 */
async function fetchPlans(cfg) {
    const cardSource = await testCardSource(cfg);
    if (!cardSource.success) return cardSource;
    if (isDesolateOpenProtocol(cfg)) {
        const account = await queryAccount(cfg);
        if (!account.success) return account;
        const planMappings = resolveOpenPlanMappings(cfg.plan_key);
        return {
            success: true,
            status: account.status,
            plans: [],
            gptPlans: [],
            creditPlans: [],
            configuredPlan: planMappings.plus,
            planMappings,
            account: account.data,
            raw: account.raw,
            cardSource: cardSource.data,
            cardSourceMessage: cardSource.message
        };
    }
    const res = await request('GET', '/plans', cfg);
    if (!res.success) return res;
    const raw = res.data;
    const gptPlans = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.gpt) ? raw.gpt : (raw?.plans || raw?.data || []));
    const creditPlans = Array.isArray(raw?.credit) ? raw.credit : [];
    return {
        success: true,
        status: res.status,
        plans: Array.isArray(gptPlans) ? gptPlans : [],
        gptPlans: Array.isArray(gptPlans) ? gptPlans : [],
        creditPlans,
        cardSource: cardSource.data,
        cardSourceMessage: cardSource.message,
        raw
    };
}

/**
 * 建單前驗證 Session 與當前套餐 (POST /pay/inspect)
 */
async function inspectPay(cfg, { planKey, session, sessionToken }) {
    if (isDesolateOpenProtocol(cfg)) {
        const checked = validateOpenSession(session, sessionToken);
        return {
            success: checked.valid,
            status: checked.valid ? 204 : 400,
            skipped: true,
            data: checked.valid ? { verified: true, planCode: planKey } : null,
            error: checked.valid ? undefined : checked.error
        };
    }
    const sessionBody = session && typeof session === 'object'
        ? session
        : (sessionToken ? { access_token: sessionToken } : {});
    const body = {
        plan_key: planKey || 'plus',
        session: sessionBody
    };
    const res = await request('POST', '/pay/inspect', cfg, { body, timeoutMs: 30000 });
    if (!res.success) return res;
    return {
        success: Boolean(res.data?.verified && res.data?.ok),
        status: res.status,
        data: res.data,
        error: res.data?.error || undefined,
        reason: res.data?.reason || undefined,
        upstreamStatus: res.data?.upstream_status ?? null
    };
}

/**
 * 提交 GPT 代充 (POST /pay)
 * @returns { success, orderId?, taskId?, data, error? }
 */
async function submitPay(cfg, { planKey, session, sessionToken, country, currency, newCard, cardId, cvc, acceptWarnings, billingAddress, proxy, clientRef, idempotencyKey }) {
    if (isDesolateOpenProtocol(cfg)) {
        const checked = validateOpenSession(session, sessionToken);
        if (!checked.valid) return { success: false, status: 400, error: checked.error };
        const card = newCard && typeof newCard === 'object' ? newCard : {};
        const cardNumber = String(card.number || card.cardNumber || '').replace(/\s+/g, '');
        const expiryMonth = Number(card.exp_month ?? card.expiryMonth);
        const expiryYear = Number(card.exp_year ?? card.expiryYear);
        const securityCode = String(card.cvc || card.securityCode || '').trim();
        if (!/^\d{13,19}$/.test(cardNumber) || !Number.isInteger(expiryMonth) || !Number.isInteger(expiryYear) || !/^\d{3,4}$/.test(securityCode)) {
            return { success: false, status: 400, error: '银行卡字段不完整或格式无效' };
        }
        const body = {
            planCode: String(planKey || '').trim(),
            cardNumber,
            expiryMonth,
            expiryYear,
            securityCode,
            session: checked.session
        };
        const headers = {};
        if (idempotencyKey && /^[0-9a-f-]{16,}$/i.test(String(idempotencyKey))) {
            headers['X-Request-ID'] = String(idempotencyKey);
        }
        const res = await request('POST', '/orders', cfg, { body, headers, timeoutMs: 60000 });
        if (!res.success) return res;
        const payload = unwrapOpenResponse(res.data) || {};
        const orderId = payload.orderId || null;
        return {
            success: true,
            status: res.status,
            orderId,
            taskId: null,
            id: orderId,
            data: payload,
            raw: res.data
        };
    }
    const body = {
        plan_key: planKey,
        country: country || 'PH',
        currency: currency || 'PHP'
    };
    if (newCard && typeof newCard === 'object') {
        body.new_card = newCard;
    } else if (Number.isInteger(Number(cardId)) && Number(cardId) > 0) {
        body.card_id = Number(cardId);
        if (cvc) body.cvc = String(cvc);
        if (acceptWarnings === true) body.accept_warnings = true;
    }
    if (billingAddress && typeof billingAddress === 'object') body.billing_address = billingAddress;
    if (clientRef) body.client_ref = String(clientRef);
    if (proxy) {
        body.proxy = String(proxy).trim();
    }
    if (session && typeof session === 'object') {
        body.session = session;
    } else if (sessionToken) {
        body.session = { access_token: sessionToken };
    }
    const headers = {};
    if (idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey;
    }

    const res = await request('POST', '/pay', cfg, { body, headers, timeoutMs: 60000 });
    if (!res.success) return res;

    const orderId = extractOrderId(res.data);
    const taskId = extractTaskId(res.data);
    return {
        success: true,
        status: res.status,
        orderId,
        taskId,
        id: orderId || taskId || extractId(res.data) || null,
        alreadySubmitted: Boolean(res.data?.already_submitted),
        topupCode: extractTopupCode(res.data),
        data: res.data
    };
}

function extractId(data) {
    if (!data || typeof data !== 'object') return null;
    return data.id ?? data.order_id ?? data.task_id ?? data._id ?? null;
}

function extractOrderId(data) {
    if (!data || typeof data !== 'object') return null;
    return data.order_id
        ?? data.order?.id
        ?? data.orderId
        ?? data.pay_order_id
        ?? null;
}

function extractTaskId(data) {
    if (!data || typeof data !== 'object') return null;
    return data.task_id
        ?? data.task?.id
        ?? data.taskId
        ?? null;
}

function extractTopupCode(data) {
    if (!data || typeof data !== 'object') return null;
    const code = data.topup_code ?? data.order?.topup_code ?? null;
    return code == null || String(code).trim() === '' ? null : String(code).trim();
}

/**
 * 查询单笔代充订单状态 (GET /pay/orders/{order_id})
 */
async function queryOrder(cfg, orderId) {
    if (!orderId) {
        return { success: false, error: '缺少订单号' };
    }
    const res = await request('GET', isDesolateOpenProtocol(cfg)
        ? `/orders/${encodeURIComponent(orderId)}`
        : `/pay/orders/${encodeURIComponent(orderId)}`, cfg);
    if (!res.success) return res;
    const data = isDesolateOpenProtocol(cfg) ? (unwrapOpenResponse(res.data) || {}) : res.data;
    return {
        success: true,
        status: res.status,
        data,
        raw: res.data,
        rawStatus: extractStatus(data),
        retryAfterMs: res.retryAfterMs
    };
}

/**
 * 查询任务状态 (GET /tasks/{task_id})
 */
async function queryTask(cfg, taskId) {
    if (!taskId) {
        return { success: false, error: '缺少任务号' };
    }
    if (isDesolateOpenProtocol(cfg)) return { success: false, error: 'Desolate Open 平台不提供 task 接口' };
    const res = await request('GET', `/tasks/${encodeURIComponent(taskId)}`, cfg);
    if (!res.success) return res;
    return {
        success: true,
        status: res.status,
        data: res.data,
        rawStatus: extractStatus(res.data),
        retryAfterMs: res.retryAfterMs
    };
}

/**
 * 查询积分与账户余额 (GET /balance)
 */
async function queryBalance(cfg) {
    if (isDesolateOpenProtocol(cfg)) {
        const account = await queryAccount(cfg);
        if (!account.success) return account;
        return {
            success: true,
            status: account.status,
            data: account.data,
            credits: account.data?.availablePoints ?? null,
            availablePoints: account.data?.availablePoints ?? null,
            balance: null,
            balanceUsd: null,
            raw: account.raw
        };
    }
    const res = await request('GET', '/balance', cfg);
    if (!res.success) return res;
    return {
        success: true,
        status: res.status,
        data: res.data,
        credits: res.data?.credits ?? null,
        balance: res.data?.balance ?? null,
        balanceUsd: res.data?.balance_usd ?? null
    };
}

async function queryAccount(cfg) {
    if (!isDesolateOpenProtocol(cfg)) return { success: false, error: '当前 API 不是 Desolate Open 协议' };
    const res = await request('GET', '/account', cfg);
    if (!res.success) return res;
    const data = unwrapOpenResponse(res.data);
    if (!data || typeof data !== 'object') return { success: false, status: res.status, error: '账户接口返回格式无效' };
    return { success: true, status: res.status, data, raw: res.data, availablePoints: data.availablePoints ?? null };
}

function extractStatus(data) {
    if (!data || typeof data !== 'object') return '';
    const resultStatus = data.result && typeof data.result === 'object' ? data.result.status : '';
    if (resultStatus) return resultStatus;
    const outer = data.status ?? data.state ?? data.order?.status ?? data.task?.status ?? '';
    if (String(outer).toLowerCase() === 'done' && data.result && data.result.ok === false) return 'failed';
    return outer;
}

/**
 * 测试连接：查询套餐 + 余额，返回摘要
 */
async function testConnection(cfg) {
    const cardSource = await testCardSource(cfg);
    if (!cardSource.success) return cardSource;
    if (isDesolateOpenProtocol(cfg)) {
        const account = await queryAccount(cfg);
        if (!account.success) return { success: false, error: `账户查询失败: ${account.error}` };
        const planMappings = resolveOpenPlanMappings(cfg.plan_key);
        const points = account.data?.availablePoints;
        const mappingText = `Plus=${planMappings.plus}、Pro 5x=${planMappings.pro_5x}、Pro 20x=${planMappings.pro_20x}`;
        return {
            success: true,
            message: `${cardSource.message}；API 连接成功（可用积分 ${points == null ? '—' : points}；套餐映射 ${mappingText}）`,
            plans: [],
            gptPlans: [],
            creditPlans: [],
            configuredPlan: planMappings.plus,
            planMappings,
            account: account.data,
            balance: account.data,
            cardSource: cardSource.data,
            cardSourceMessage: cardSource.message
        };
    }
    const [plansRes, balanceRes] = await Promise.all([
        fetchPlans(cfg),
        queryBalance(cfg)
    ]);

    if (!plansRes.success) {
        return { success: false, error: `套餐查询失败: ${plansRes.error}` };
    }

    const messages = [];
    if (plansRes.success) {
        messages.push(`套餐 ${Array.isArray(plansRes.plans) ? plansRes.plans.length : 0} 个`);
    }
    if (balanceRes.success) {
        const b = balanceRes.data || {};
        const balance = b.balance ?? b.credits ?? b.amount ?? '';
        if (balance !== '') {
            messages.push(`余额 ${balance}`);
        }
    }

    return {
        success: true,
        message: `${cardSource.message}；API 连接成功（${messages.join('，')}）`,
        plans: plansRes.plans || [],
        gptPlans: plansRes.gptPlans || [],
        creditPlans: plansRes.creditPlans || [],
        balance: balanceRes.success ? balanceRes.data : null,
        cardSource: cardSource.data,
        cardSourceMessage: cardSource.message
    };
}

async function testCardSource(cfg = {}) {
    const source = String(cfg.card_source || 'local').trim().toLowerCase();
    if (source !== 'orbitcard') {
        return {
            success: true,
            data: { source: 'local' },
            message: '卡源：本地卡池'
        };
    }
    const result = await orbitcard.testConnection({
        base_url: cfg.orbitcard_base_url,
        api_key: cfg.orbitcard_api_key,
        api_secret: cfg.orbitcard_api_secret
    });
    if (!result.success) return result;
    return {
        success: true,
        data: { source: 'orbitcard', cardCount: result.cardCount, balance: result.balance },
        message: result.message,
        cards: result.cards
    };
}

module.exports = {
    DEFAULT_BASE_URL,
    normalizeBaseUrl,
    maskApiKey,
    request,
    fetchPlans,
    inspectPay,
    submitPay,
    queryOrder,
    queryTask,
    queryBalance,
    testConnection,
    testCardSource,
    extractOrderId,
    extractTaskId,
    extractTopupCode,
    extractStatus,
    isDesolateOpenProtocol,
    resolveBaseUrl,
    resolveOpenPlanCode,
    resolveOpenPlanMappings,
    queryAccount,
    validateOpenSession
};
