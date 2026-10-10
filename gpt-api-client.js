'use strict';

/**
 * 第三方 GPT 代充 API 客户端（协议见 协议api.md）
 *
 * 基础 URL:   旧协议可直接填写供应商地址；Desolate Open 平台可填写
 *             https://recharge.desolate.run 或完整 /api/v1/open 地址
 * 认证:       旧协议使用 Authorization: Bearer；Desolate Open 使用 X-API-Key
 * 幂等键: 旧协议提交必须带 Idempotency-Key；Desolate Open 提交使用 UUID 并在重试时复用
 * 请求追踪: Desolate Open 请求携带 UUID X-Request-ID；显式 requestId 必须是 UUID，
 *           同一提交操作的传输重试复用同一个追踪 ID；响应 requestId 与 Retry-After 会原样暴露
 *
 * 本模块仅做轻量封装：提交代充、查询订单/任务状态、查询套餐/余额、测试连通。
 */

const axios = require('axios');
const { validate: isUuid, v4: uuidv4, v5: uuidv5 } = require('uuid');
const orbitcard = require('./orbitcard-client');
const {
    CANONICAL_PLAN_TYPES,
    getPlanLabel,
    resolveDesolatePlanCode
} = require('./plan-registry');

const DEFAULT_BASE_URL = 'https://kc.vpss.eu.cc/';
const DEFAULT_OPEN_BASE_URL = 'https://recharge.desolate.run/api/v1/open';
const OPEN_PROVIDER_HOST = 'recharge.desolate.run';

function normalizeDesolateIdempotencyKey(seed) {
    const value = String(seed ?? '').trim();
    if (!value || isUuid(value)) return value;
    return uuidv5(value, uuidv5.URL);
}

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

function normalizeOpenPlanMappingConfig(config = {}) {
    if (config && typeof config === 'object') {
        const nested = config.plan_mappings || config.desolate_plan_codes || config;
        return Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
            planType,
            String(nested?.[planType] ?? (planType === 'plus' ? config.plan_key : '') ?? '').trim()
        ]));
    }
    const legacyPlus = String(config || '').trim();
    return { plus: legacyPlus, pro100: '', pro200: '', pro500: '' };
}

function resolveOpenPlanCode(planType, config = {}) {
    return resolveDesolatePlanCode(planType, normalizeOpenPlanMappingConfig(config));
}

function resolveOpenPlanMappings(config = {}) {
    const mappings = normalizeOpenPlanMappingConfig(config);
    return Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => {
        try {
            return [planType, resolveOpenPlanCode(planType, mappings)];
        } catch (_) {
            return [planType, null];
        }
    }));
}

function maskApiKey(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    if (k.length <= 8) return '****';
    return `${k.slice(0, 6)}\u2026${k.slice(-4)}`;
}

function normalizeRequestId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return uuidv4();
    return isUuid(raw) ? raw : null;
}

function getResponseHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return undefined;
    const wanted = String(name).toLowerCase();
    const key = Object.keys(headers).find((candidate) => String(candidate).toLowerCase() === wanted);
    return key ? headers[key] : undefined;
}

function withoutRequestIdHeader(headers) {
    return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => String(name).toLowerCase() !== 'x-request-id'));
}

function parseRetryAfter(value, now = Date.now()) {
    if (value == null || String(value).trim() === '') return { value: null, seconds: null, ms: null };
    const raw = String(value).trim();
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return { value: raw, seconds, ms: Math.round(seconds * 1000) };
    }
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) {
        return { value: raw, seconds: Math.max(0, (timestamp - now) / 1000), ms: Math.max(0, timestamp - now) };
    }
    return { value: raw, seconds: null, ms: null };
}

function buildResponseMeta(headers, status = null) {
    const requestId = getResponseHeader(headers, 'x-request-id');
    const replayed = getResponseHeader(headers, 'idempotency-replayed');
    const retryAfter = parseRetryAfter(getResponseHeader(headers, 'retry-after'));
    const cacheControl = getResponseHeader(headers, 'cache-control');
    const location = getResponseHeader(headers, 'location');
    return {
        status: Number.isFinite(Number(status)) ? Number(status) : null,
        requestId: requestId == null ? null : String(requestId),
        idempotencyReplayed: replayed != null && String(replayed).trim().toLowerCase() === 'true',
        retryAfter: retryAfter.value,
        retryAfterSeconds: retryAfter.seconds,
        retryAfterMs: retryAfter.ms,
        cacheControl: cacheControl == null ? null : String(cacheControl),
        location: location == null ? null : String(location)
    };
}

function isRetryableOpenOrderResponse(result) {
    return Boolean(result?.networkError)
        || Number(result?.status) === 429
        || Number(result?.status) >= 500;
}

function getRetryOptions(cfg = {}, options = {}) {
    const configuredMax = options.maxRetries ?? cfg.open_order_max_retries ?? process.env.DESOLATE_OPEN_ORDER_MAX_RETRIES ?? 2;
    const configuredBase = options.baseDelayMs ?? cfg.open_order_retry_base_ms ?? process.env.DESOLATE_OPEN_RETRY_BASE_MS ?? 1000;
    return {
        maxRetries: Math.max(0, Number.isInteger(Number(configuredMax)) ? Number(configuredMax) : 2),
        baseDelayMs: Math.max(0, Number.isFinite(Number(configuredBase)) ? Number(configuredBase) : 1000)
    };
}

function sleepForRetry(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 统一请求封装，始终返回 { success, status?, data?, error? }
 */
async function request(method, path, cfg, { body, headers: extraHeaders, timeoutMs, requestId } = {}) {
    const openProtocol = isDesolateOpenProtocol(cfg);
    const base = resolveBaseUrl(cfg);
    const apiKey = String(cfg?.api_key || '').trim();
    if (!apiKey) {
        return { success: false, error: '缺少 API Key' };
    }

    const suppliedRequestId = requestId ?? getResponseHeader(extraHeaders, 'x-request-id');
    const outboundRequestId = openProtocol ? normalizeRequestId(suppliedRequestId) : undefined;
    if (openProtocol && !outboundRequestId) {
        return {
            success: false,
            status: 400,
            requestId: null,
            error: 'X-Request-ID 必须是 UUID'
        };
    }
    const headers = {
        ...(openProtocol ? { 'X-API-Key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...withoutRequestIdHeader(extraHeaders),
        ...(openProtocol ? { 'X-Request-ID': outboundRequestId } : {})
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
        const responseMeta = buildResponseMeta(responseHeaders, response.status);
        return {
            success: ok,
            status: response.status,
            data,
            headers: responseHeaders,
            responseMeta,
            requestId: responseMeta.requestId,
            outboundRequestId,
            idempotencyReplayed: responseMeta.idempotencyReplayed,
            retryAfter: responseMeta.retryAfter,
            retryAfterSeconds: responseMeta.retryAfterSeconds,
            retryAfterMs: responseMeta.retryAfterMs,
            businessCode: openProtocol && Number.isInteger(Number(data?.code)) && Number(data.code) !== 0
                ? Number(data.code)
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
        const responseMeta = buildResponseMeta(error?.response?.headers, error?.response?.status);
        return {
            success: false,
            status: error?.response?.status,
            data: error?.response?.data,
            error: detail,
            networkError: !error?.response,
            responseMeta,
            requestId: responseMeta.requestId,
            outboundRequestId,
            idempotencyReplayed: responseMeta.idempotencyReplayed,
            retryAfter: responseMeta.retryAfter,
            retryAfterSeconds: responseMeta.retryAfterSeconds,
            retryAfterMs: responseMeta.retryAfterMs,
            businessCode: openProtocol && Number.isInteger(Number(error?.response?.data?.code))
                && Number(error.response.data.code) !== 0
                ? Number(error.response.data.code)
                : null
        };
    }
}

function unwrapOpenResponse(data) {
    return data && typeof data === 'object' && data.code === 0
        && Object.prototype.hasOwnProperty.call(data, 'data')
        ? data.data
        : data;
}

const OPEN_ORDER_SUMMARY_KEYS = Object.freeze([
    'orderId', 'status', 'targetEmail', 'planCode', 'regionCode', 'paymentRegion', 'amount', 'currency',
    'createdAt', 'updatedAt', 'completedAt', 'message', 'failureCode', 'failureMessage',
    'subscriptionCancelled', 'stage', 'captcha', 'payment'
]);

function normalizeOpenOrderSummary(data, responseMeta = null) {
    const envelope = data && typeof data === 'object' ? data : {};
    const source = envelope.code === 0 && envelope.data && typeof envelope.data === 'object'
        ? envelope.data
        : envelope;
    const summary = {};
    for (const key of OPEN_ORDER_SUMMARY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (key === 'payment' && source.payment && typeof source.payment === 'object') {
            summary.payment = {};
            for (const paymentKey of ['amount', 'currency']) {
                if (Object.prototype.hasOwnProperty.call(source.payment, paymentKey)) summary.payment[paymentKey] = source.payment[paymentKey];
            }
            continue;
        }
        if (key === 'captcha' && source.captcha && typeof source.captcha === 'object') {
            summary.captcha = {};
            for (const captchaKey of ['id', 'status', 'expires_at', 'expiresAt']) {
                if (Object.prototype.hasOwnProperty.call(source.captcha, captchaKey)) summary.captcha[captchaKey] = source.captcha[captchaKey];
            }
            continue;
        }
        summary[key] = source[key];
    }
    const providerMessage = source._providerMessage || envelope._providerMessage || envelope.message;
    if (!summary.message && providerMessage) summary.message = String(providerMessage);
    if (Number.isInteger(Number(envelope.code)) && Number(envelope.code) !== 0) {
        summary.businessCode = Number(envelope.code);
    }
    if (source.session && typeof source.session === 'object') summary.sessionUpdated = true;
    if (responseMeta && typeof responseMeta === 'object') {
        const safeMeta = {};
        for (const key of ['status', 'requestId', 'idempotencyReplayed', 'retryAfter', 'retryAfterSeconds', 'retryAfterMs', 'cacheControl', 'location']) {
            if (Object.prototype.hasOwnProperty.call(responseMeta, key)) safeMeta[key] = responseMeta[key];
        }
        if (Object.keys(safeMeta).length) summary.responseMeta = safeMeta;
    }
    return summary;
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
        const planMappings = resolveOpenPlanMappings(cfg);
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
    const normalizedPlanKey = String(planKey || '').trim();
    if (!normalizedPlanKey) {
        return { success: false, status: 400, error: '缺少 plan_key，禁止默认回退 Plus' };
    }
    const body = {
        plan_key: normalizedPlanKey,
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
async function submitPay(cfg, { planKey, session, sessionToken, country, currency, paymentRegion, newCard, cardId, cvc, acceptWarnings, billingAddress, proxy, clientRef, idempotencyKey, requestId, retryOptions }) {
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
        const normalizedPlanCode = String(planKey || '').trim();
        if (!normalizedPlanCode) return { success: false, status: 400, error: '缺少 planCode，禁止默认回退 Plus' };
        const selectedPaymentRegion = String(paymentRegion || '').trim().toUpperCase();
        if (selectedPaymentRegion && (!/^[A-Z]{2}$/.test(selectedPaymentRegion) || selectedPaymentRegion === 'ZZ')) {
            return { success: false, status: 400, error: 'paymentRegion 必须是有效的两位大写地区代码' };
        }
        const body = {
            planCode: normalizedPlanCode,
            ...(selectedPaymentRegion ? { paymentRegion: selectedPaymentRegion } : {}),
            cardNumber,
            expiryMonth,
            expiryYear,
            securityCode,
            session: checked.session
        };
        const seed = String(idempotencyKey ?? '').trim() || String(clientRef ?? '').trim();
        const idempotencyHeader = normalizeDesolateIdempotencyKey(seed) || uuidv4();
        const outboundRequestId = normalizeRequestId(requestId);
        if (!outboundRequestId) return { success: false, status: 400, error: 'X-Request-ID 必须是 UUID' };
        const headers = { 'Idempotency-Key': idempotencyHeader };
        const retry = getRetryOptions(cfg, retryOptions);
        const retryHistory = [];
        let res = null;
        let retryCount = 0;
        while (true) {
            res = await request('POST', '/orders', cfg, { body, headers, requestId: outboundRequestId, timeoutMs: 60000 });
            retryHistory.push({
                status: res.status ?? null,
                requestId: res.requestId || null,
                businessCode: res.businessCode ?? null,
                retryAfter: res.retryAfter ?? null,
                retryAfterSeconds: res.retryAfterSeconds ?? null,
                retryAfterMs: res.retryAfterMs ?? null
            });
            if (!isRetryableOpenOrderResponse(res) || retryCount >= retry.maxRetries) break;
            const retryAfterMs = Number(res.retryAfterMs);
            const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
                ? retryAfterMs
                : Math.min(60000, retry.baseDelayMs * (2 ** retryCount));
            retryCount += 1;
            await sleepForRetry(backoffMs);
        }
        if (!res.success) return { ...res, idempotencyKey: idempotencyHeader, requestId: res.requestId || null, outboundRequestId, retryCount, retryHistory };
        const payload = unwrapOpenResponse(res.data) || {};
        const orderId = payload.orderId || null;
        return {
            success: true,
            status: res.status,
            businessCode: res.businessCode,
            orderId,
            taskId: null,
            id: orderId,
            data: payload,
            message: extractProviderMessage(payload, res.data?.message),
            raw: res.data,
            responseMeta: res.responseMeta,
            requestId: res.requestId,
            outboundRequestId,
            idempotencyReplayed: res.idempotencyReplayed,
            retryAfter: res.retryAfter,
            retryAfterSeconds: res.retryAfterSeconds,
            retryAfterMs: res.retryAfterMs,
            idempotencyKey: idempotencyHeader,
            retryCount,
            retryHistory
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
        data: res.data,
        message: extractProviderMessage(res.data)
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

function normalizeCaptcha(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id ?? value.captcha_id ?? value.captchaId ?? '').trim();
    const status = String(value.status ?? '').trim().toLowerCase();
    const url = String(value.url ?? '').trim();
    const expiresAt = value.expires_at ?? value.expiresAt ?? value.expire_at ?? value.expireAt ?? null;
    return {
        id: id || null,
        status: status || null,
        url: url || null,
        expiresAt: expiresAt == null || String(expiresAt).trim() === '' ? null : String(expiresAt).trim()
    };
}

function extractCaptcha(data) {
    if (!data || typeof data !== 'object') return null;
    return normalizeCaptcha(
        data.captcha
        ?? data.order?.captcha
        ?? data.result?.captcha
        ?? null
    );
}

function extractStage(data) {
    if (!data || typeof data !== 'object') return '';
    return String(
        data.stage
        ?? data.order?.stage
        ?? data.result?.stage
        ?? ''
    ).trim().toLowerCase();
}

const GENERIC_PROVIDER_MESSAGES = new Set(['成功', 'ok', 'success', '请求成功', '操作成功']);

function extractProviderMessage(data, fallback = '') {
    const source = data && typeof data === 'object' ? data : {};
    const result = source.result && typeof source.result === 'object' ? source.result : {};
    const candidates = [source.providerMessage, source._providerMessage, source.message, source.msg, result.message, result.msg, fallback];
    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (value && !GENERIC_PROVIDER_MESSAGES.has(value.toLowerCase())) return value;
    }
    return '';
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
        message: extractProviderMessage(data, res.data?.message),
        rawStatus: extractStatus(data),
        stage: extractStage(data),
        captcha: extractCaptcha(data),
        responseMeta: res.responseMeta,
        requestId: res.requestId,
        idempotencyReplayed: res.idempotencyReplayed,
        retryAfter: res.retryAfter,
        retryAfterSeconds: res.retryAfterSeconds,
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
        message: extractProviderMessage(res.data),
        rawStatus: extractStatus(res.data),
        stage: extractStage(res.data),
        captcha: extractCaptcha(res.data),
        responseMeta: res.responseMeta,
        requestId: res.requestId,
        retryAfter: res.retryAfter,
        retryAfterSeconds: res.retryAfterSeconds,
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
    if (!data || typeof data !== 'object') return { success: false, status: res.status, error: '账户接口返回格式无效', responseMeta: res.responseMeta };
    return {
        success: true,
        status: res.status,
        data,
        raw: res.data,
        availablePoints: data.availablePoints ?? null,
        responseMeta: res.responseMeta,
        requestId: res.requestId,
        retryAfter: res.retryAfter,
        retryAfterSeconds: res.retryAfterSeconds,
        retryAfterMs: res.retryAfterMs
    };
}

async function queryPaymentRegions(cfg, planCode) {
    if (!isDesolateOpenProtocol(cfg)) {
        return { success: false, status: 400, error: '当前 API 不是 Desolate Open 协议' };
    }
    const normalizedPlanCode = String(planCode || '').trim();
    if (!normalizedPlanCode) {
        return { success: false, status: 400, error: '缺少 planCode，禁止默认回退 Plus' };
    }
    const res = await request('GET', `/plans/${encodeURIComponent(normalizedPlanCode)}/payment-regions`, cfg);
    if (!res.success) return res;
    const data = unwrapOpenResponse(res.data);
    if (!data || typeof data !== 'object' || !Array.isArray(data.paymentRegions)) {
        return { success: false, status: res.status, error: '支付地区接口返回格式无效', responseMeta: res.responseMeta };
    }
    return {
        success: true,
        status: res.status,
        data,
        planCode: data.planCode || normalizedPlanCode,
        paymentRegions: data.paymentRegions,
        raw: res.data,
        responseMeta: res.responseMeta,
        requestId: res.requestId,
        idempotencyReplayed: res.idempotencyReplayed,
        retryAfter: res.retryAfter,
        retryAfterSeconds: res.retryAfterSeconds,
        retryAfterMs: res.retryAfterMs
    };
}

const fetchPaymentRegions = queryPaymentRegions;
const listPaymentRegions = queryPaymentRegions;

function extractStatus(data) {
    if (!data || typeof data !== 'object') return '';
    const resultStatus = data.result && typeof data.result === 'object' ? data.result.status : '';
    if (resultStatus) return resultStatus;
    const outer = data.status ?? data.state ?? data.order?.status ?? data.task?.status ?? '';
    if (String(outer).toLowerCase() === 'done' && data.result && data.result.ok === false) return 'failed';
    return outer;
}

const IN_PROGRESS_STATUS_MESSAGES = Object.freeze({
    queued: '订单已进入处理队列，等待处理',
    pending: '订单已进入处理队列，等待处理',
    waiting: '订单已进入处理队列，等待处理',
    accepted: '订单已受理，等待处理',
    processing: '订单正在处理中',
    running: '订单正在处理中',
    in_progress: '订单正在处理中',
    requires_cvc: '订单正在进行安全验证',
    system_error: '系统暂时繁忙，正在重试',
    stalled: '订单处理较慢，系统仍在等待结果'
});

/**
 * 将供应商订单状态转换为面向用户的进度提示，不把原始英文状态直接展示。
 */
function formatProgressMessage(data, pollCount = 0) {
    const source = data && typeof data === 'object' ? data : {};
    const result = source.result && typeof source.result === 'object' ? source.result : {};
    const captcha = source.captcha || result.captcha;
    const stage = String(source.stage ?? result.stage ?? '').trim().toLowerCase();
    const captchaStatus = String(captcha?.status || '').trim().toLowerCase();
    if (stage === 'awaiting_captcha' || captchaStatus === 'pending') {
        return '需要完成人机验证，请点击页面中的验证按钮';
    }
    if (stage === 'captcha_submitted' || captchaStatus === 'submitted') {
        const count = Number(pollCount);
        const suffix = Number.isFinite(count) && count > 0 ? `（已查询 ${Math.floor(count)} 次）` : '';
        return `人机验证已提交，系统正在确认${suffix}`;
    }
    const displayStatus = String(
        source.display_status
        ?? source.displayStatus
        ?? source.queue_status
        ?? result.display_status
        ?? result.displayStatus
        ?? result.queue_status
        ?? ''
    ).trim().toLowerCase();
    const businessStatus = String(source.status ?? source.state ?? result.status ?? '').trim().toLowerCase();
    const key = displayStatus || businessStatus;
    const providerMessage = extractProviderMessage(source);
    const count = Number(pollCount);
    if (providerMessage) {
        return Number.isFinite(count) && count > 0
            ? `${providerMessage}（已查询 ${Math.floor(count)} 次）`
            : providerMessage;
    }
    const message = IN_PROGRESS_STATUS_MESSAGES[key] || '订单已提交，正在同步最新状态';
    return Number.isFinite(count) && count > 0 ? `${message}（已查询 ${Math.floor(count)} 次）` : message;
}

function getGptOrderPollDelayMs({
    pollCount = 0,
    baseDelayMs = 5000,
    maxDelayMs = 60000,
    status = '',
    retryAfterMs = null,
    captchaPending = false
} = {}) {
    const base = Math.max(0, Number.isFinite(Number(baseDelayMs)) ? Number(baseDelayMs) : 5000);
    const max = Math.max(base, Number.isFinite(Number(maxDelayMs)) ? Number(maxDelayMs) : 60000);
    const retryAfter = Number(retryAfterMs);
    if (String(status).trim() === '429' && Number.isFinite(retryAfter) && retryAfter >= 0) {
        return retryAfter;
    }
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const pending = captchaPending || normalizedStatus === 'pending' || normalizedStatus === 'processing';
    if (!pending) return base;
    const count = Math.max(0, Math.floor(Number(pollCount) || 0));
    return Math.min(max, base * (2 ** Math.min(count, 10)));
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
        const planMappings = resolveOpenPlanMappings(cfg);
        const points = account.data?.availablePoints;
        const mappingText = CANONICAL_PLAN_TYPES
            .map((planType) => `${getPlanLabel(planType)}=${planMappings[planType] || '未配置'}`)
            .join('、');
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
    const planAmounts = {};
    const planProducts = {};
    for (const planType of CANONICAL_PLAN_TYPES) {
        const selection = orbitcard.chooseProductForPlan(result.products, planType);
        planAmounts[planType] = selection.success ? selection.amount : null;
        planProducts[planType] = selection.success
            ? {
                productCode: selection.product.productCode,
                bin: selection.product.bin,
                network: selection.product.network,
                channel: selection.channel,
                channelPriority: selection.channelPriority,
                maxUsageCount: selection.maxUsageCount
            }
            : null;
    }
    return {
        success: true,
        data: {
            source: 'orbitcard',
            cardCount: result.cardCount,
            productCount: result.productCount,
            balance: result.balance,
            planAmounts,
            planProducts
        },
        message: `${result.message}；渠道 3 Mastercard 优先，Visa 为备选；首充建议 ${CANONICAL_PLAN_TYPES.map((planType) => `${getPlanLabel(planType)} ${planAmounts[planType] || '—'} USD`).join('、')}`,
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
    normalizeCaptcha,
    extractCaptcha,
    extractStage,
    extractProviderMessage,
    extractStatus,
    formatProgressMessage,
    getGptOrderPollDelayMs,
    isDesolateOpenProtocol,
    resolveBaseUrl,
    resolveOpenPlanCode,
    resolveOpenPlanMappings,
    normalizeOpenPlanMappingConfig,
    queryAccount,
    queryPaymentRegions,
    fetchPaymentRegions,
    listPaymentRegions,
    normalizeOpenOrderSummary,
    validateOpenSession
};
