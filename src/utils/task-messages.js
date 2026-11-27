'use strict';

const GPT_API_CUSTOMER_FAILURE_MESSAGE = '本次开通未完成，已转人工确认，请联系客服处理后再试';
const GPT_API_CUSTOMER_TIMEOUT_MESSAGE = '订单处理超时，已转人工确认，请联系客服处理后再试';

function sanitizeCustomerTaskMessage(message) {
    if (typeof message !== 'string') {
        return message;
    }
    if (message.includes('订单处理超时')) {
        return GPT_API_CUSTOMER_TIMEOUT_MESSAGE;
    }
    if (/代充提交失败|businessCode|Idempotency-Key/i.test(message)) {
        return GPT_API_CUSTOMER_FAILURE_MESSAGE;
    }
    return message;
}

function getManualReviewMessage(message) {
    const text = String(message || '').trim();
    if (!text) {
        return '本次开通未完成，已转人工确认，请联系客服处理后再试';
    }
    if (text.includes('人工确认')) {
        return text;
    }
    return `${text}，已转人工确认，请联系客服处理后再试`;
}

function getRemainingCooldownMinutes(cooldownUntil) {
    if (!cooldownUntil) {
        return 0;
    }
    const diffMs = new Date(cooldownUntil).getTime() - Date.now();
    if (diffMs <= 0) {
        return 0;
    }
    return Math.ceil(diffMs / 60000);
}

function parseEpochMs(value) {
    if (value == null || value === '') {
        return null;
    }
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 1e12) return Math.trunc(value);
        if (value > 1e9) return Math.trunc(value * 1000);
        return null;
    }
    const normalized = String(value).trim();
    if (!normalized) return null;
    if (/^\d{13}$/.test(normalized)) return Number(normalized);
    if (/^\d{10}$/.test(normalized)) return Number(normalized) * 1000;
    const candidate = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    GPT_API_CUSTOMER_FAILURE_MESSAGE,
    GPT_API_CUSTOMER_TIMEOUT_MESSAGE,
    sanitizeCustomerTaskMessage,
    getManualReviewMessage,
    getRemainingCooldownMinutes,
    parseEpochMs,
    sleep
};
