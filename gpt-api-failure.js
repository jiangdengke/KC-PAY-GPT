'use strict';

const UNKNOWN_FAILURE_REASON = '原因缺失（第三方未提供失败原因）';
const UNKNOWN_FAILURE_CODE = '未提供';
const UNKNOWN_FAILURE_STATUS = '未知';
const MAX_REASON_LENGTH = 1600;
const MAX_FIELD_LENGTH = 120;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const JWT_PATTERN = /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i;
const IDENTIFIER_REDACTION_OPTIONS = Object.freeze({ skipPanHeuristic: true });
const SENSITIVE_CREDENTIAL_KEY_PATTERN = /^(?:token|(?:access|refresh|id|session|auth|authorization|bearer|api|client|captcha|security)token|session(?:id|token|key)?|(?:password|passwd|pwd)(?:hash|digest|salt)?|passcode|api(?:key|secret)|client(?:key|secret)|auth|authorization|(?:auth|oauth|authorization)(?:code|token|key|secret)|cookie|setcookie|captcha(?:url|token|ticket)|ticket|signature|secret(?:key)?|card|card(?:number|no|pan|cvc|cvv|securitycode)|paymentcard(?:number|cvc|cvv)|primaryaccountnumber|cc(?:number|num)|pan|cvc2?|cvv2?|securitycode|otp|otpcode|totp|mfacode|onetimepassword|verificationcode)$/;

function isScalar(value) {
    return value !== null
        && value !== undefined
        && !['object', 'function', 'symbol'].includes(typeof value);
}

function truncateText(text, maxLength) {
    return text.length > maxLength
        ? `${text.slice(0, Math.max(0, maxLength - 1))}…`
        : text;
}

function getDecodedUrlForms(value) {
    const forms = [];
    let decoded = String(value || '');
    for (let attempt = 0; attempt <= 2; attempt += 1) {
        if (!forms.includes(decoded)) forms.push(decoded);
        if (attempt === 2) break;
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch (_) {
            break;
        }
    }
    return forms;
}

function decodeUrlPart(value) {
    const forms = getDecodedUrlForms(value);
    return forms[forms.length - 1] || '';
}

function isSensitiveCredentialKey(value) {
    const compact = decodeUrlPart(value)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join('');
    return SENSITIVE_CREDENTIAL_KEY_PATTERN.test(compact);
}

function hasSensitiveUrlParams(params) {
    for (const [key, value] of params) {
        if (isSensitiveCredentialKey(key) || JWT_PATTERN.test(decodeUrlPart(value))) return true;
    }
    return false;
}

function urlPartContainsCredentials(value) {
    const candidates = new Set();
    for (const form of getDecodedUrlForms(value)) {
        const normalized = form.replace(/^[?#]+/, '');
        if (normalized.includes('=')) candidates.add(normalized);
        for (const match of form.matchAll(/[?#]/g)) {
            const nested = form.slice(match.index + 1).replace(/^[?#]+/, '');
            if (nested.includes('=')) candidates.add(nested);
        }
    }
    for (const candidate of candidates) {
        if (hasSensitiveUrlParams(new URLSearchParams(candidate))) return true;
    }
    return false;
}

function urlContainsCredentials(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        return true;
    }

    if (parsed.username || parsed.password) return true;
    if (/captcha/i.test(decodeUrlPart(parsed.pathname))) return true;
    if (JWT_PATTERN.test(decodeUrlPart(parsed.href))) return true;
    if (urlPartContainsCredentials(parsed.search.slice(1))) return true;
    return urlPartContainsCredentials(parsed.hash.slice(1));
}

function splitTrailingUrlPunctuation(value) {
    const match = String(value).match(/^(.*?)([),.;!?\]}，。；！？]*)$/);
    return {
        url: match?.[1] || String(value),
        suffix: match?.[2] || ''
    };
}

function protectOrdinaryUrls(value) {
    const urls = [];
    const text = String(value).replace(URL_PATTERN, (candidate) => {
        const { url, suffix } = splitTrailingUrlPunctuation(candidate);
        if (urlContainsCredentials(url)) return `[已隐藏链接]${suffix}`;
        const marker = `\uE000URL${urls.length.toString(36).toUpperCase()}\uE001`;
        urls.push(url);
        return `${marker}${suffix}`;
    });
    return {
        text,
        restore(redacted) {
            return redacted.replace(/\uE000URL([0-9A-Z]+)\uE001/g, (_match, index) => {
                const original = urls[Number.parseInt(index, 36)];
                return original === undefined ? '[已隐藏链接]' : original;
            });
        }
    };
}

function redactSensitiveText(value, maxLength = MAX_FIELD_LENGTH, options = {}) {
    if (!isScalar(value)) return '';
    if (maxLength && typeof maxLength === 'object') {
        options = maxLength;
        maxLength = MAX_FIELD_LENGTH;
    }

    let text = String(value);
    if (!text.trim()) return '';

    // Redact complete credential headers before whitespace normalization so a
    // Cookie line cannot leak its later key/value pairs.
    text = text
        .replace(/\b(?:set-cookie|cookie)\b\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\r\n}]*)/gi, 'Cookie=[已隐藏]')
        .replace(/\bauthorization\b\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|(?:bearer|basic)\s+[^\s,;，；}\]}]+|[^\s,;，；}\]}]+)/gi, 'Authorization=[已隐藏]')
        .replace(/\b(?:bearer|basic)\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[a-z0-9._~+/=-]+)/gi, '[已隐藏凭据]');

    const protectedUrls = protectOrdinaryUrls(text);
    text = protectedUrls.text
        .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[已隐藏令牌]')
        .replace(
            /["']?\b([a-z][a-z0-9_.-]*)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\[[^\]]*已隐藏[^\]]*\]|[^\s,;，；}\]}]+)/gi,
            (match, key) => isSensitiveCredentialKey(key) ? `${key}=[已隐藏]` : match
        );
    if (!options || options.skipPanHeuristic !== true) {
        text = text.replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, '[已隐藏卡号]');
    }
    text = protectedUrls.restore(text)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) return '';
    const boundedLength = Number.isFinite(Number(maxLength))
        ? Math.max(0, Math.floor(Number(maxLength)))
        : MAX_FIELD_LENGTH;
    return truncateText(text, boundedLength);
}

function firstScalar(values, maxLength = MAX_FIELD_LENGTH, options = {}) {
    for (const value of values) {
        const safe = redactSensitiveText(value, maxLength, options);
        if (safe) return safe;
    }
    return '';
}

function getField(source, keys) {
    if (!source || typeof source !== 'object') return undefined;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
    }
    return undefined;
}

function getFailureReasonCandidates({ openProtocol, raw, result, providerReason }) {
    const common = [
        providerReason,
        raw?.failureMessage,
        raw?.failure_message,
        raw?.providerMessage,
        raw?._providerMessage
    ];
    if (openProtocol) {
        return [
            ...common,
            raw?.message
        ];
    }
    return [
        ...common,
        result?.error,
        result?.errorMessage,
        result?.failureMessage,
        result?.failure_message,
        raw?.error,
        raw?.errorMessage,
        raw?.message
    ];
}

function getFailureCodeCandidates({ openProtocol, raw, result, providerCode }) {
    const common = [
        providerCode,
        raw?.failureCode,
        raw?.failure_code,
        result?.failureCode,
        result?.failure_code
    ];
    return openProtocol
        ? [...common, raw?.code, raw?.businessCode]
        : [...common, result?.errorCode, result?.error_code, result?.code, raw?.errorCode, raw?.error_code, raw?.code, raw?.businessCode];
}

function getSerializedMessageCandidates(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const nested = source.data && typeof source.data === 'object' && !Array.isArray(source.data)
        ? source.data
        : {};
    return [
        source.failureMessage,
        source.failure_message,
        source.providerMessage,
        source.errorMessage,
        source.error,
        source.reason,
        source.message,
        nested.failureMessage,
        nested.failure_message,
        nested.providerMessage,
        nested.errorMessage,
        nested.error,
        nested.reason,
        nested.message
    ];
}

function sanitizeErrorReason(value, maxLength = MAX_REASON_LENGTH) {
    if (!isScalar(value)) return '';
    const raw = String(value).trim();
    if (!raw) return '';

    const bracketTag = raw.match(/^\[(?:[A-Z][A-Z0-9_.:/-]{2,}|(?:Error|Warn(?:ing)?|HTTP)[^\]]*)\](?=\s|$)/);
    let objectIndex = raw.search(/[\[{]/);
    if (objectIndex === 0 && bracketTag) {
        const tailIndex = raw.slice(bracketTag[0].length).search(/[\[{]/);
        objectIndex = tailIndex < 0 ? -1 : bracketTag[0].length + tailIndex;
    }
    if (objectIndex < 0) return redactSensitiveText(raw, maxLength);

    const prefix = raw.slice(0, objectIndex).replace(/[\s:：=-]+$/g, '').trim();
    const serialized = raw.slice(objectIndex).trim();
    let parsed = null;
    try {
        parsed = JSON.parse(serialized);
    } catch (_) {
        // A raw object dump is not safe notification text. If it cannot be
        // parsed, retain only the human prefix and discard the serialized tail.
        return redactSensitiveText(prefix, maxLength);
    }

    const extracted = firstScalar(getSerializedMessageCandidates(parsed), maxLength);
    if (!extracted) return redactSensitiveText(prefix, maxLength);
    if (!prefix) return extracted;
    return redactSensitiveText(`${prefix}: ${extracted}`, maxLength);
}

function firstErrorReason(error, maxLength = MAX_REASON_LENGTH) {
    if (!error || typeof error !== 'object') return '';
    for (const value of [
        error.providerMessage,
        error.failureMessage,
        error.failure_message,
        error.reason,
        error.message
    ]) {
        const safe = sanitizeErrorReason(value, maxLength);
        if (safe) return safe;
    }
    return '';
}

/**
 * Build an admin-only, bounded diagnostic. The customer message remains a
 * separate value owned by the task worker.
 */
function buildGptApiFailureDiagnostic({
    openProtocol = false,
    raw = null,
    businessResult = null,
    rawStatus = '',
    providerReason,
    providerCode,
    orderId,
    status,
    requestId,
    responseMeta,
    pollCount,
    timeout = false,
    error
} = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const result = businessResult && typeof businessResult === 'object'
        ? businessResult
        : (source.result && typeof source.result === 'object' ? source.result : {});
    const count = Number.isFinite(Number(pollCount)) && Number(pollCount) >= 0
        ? Math.floor(Number(pollCount))
        : null;

    const safeOrderId = firstScalar([orderId], MAX_FIELD_LENGTH, IDENTIFIER_REDACTION_OPTIONS);
    const safeStatus = firstScalar([
        status,
        rawStatus,
        getField(source, ['status', 'state']),
        getField(result, ['status', 'state'])
    ], MAX_FIELD_LENGTH, IDENTIFIER_REDACTION_OPTIONS) || UNKNOWN_FAILURE_STATUS;
    const safeRequestId = firstScalar([
        requestId,
        responseMeta?.requestId
    ], MAX_FIELD_LENGTH, IDENTIFIER_REDACTION_OPTIONS);

    let reason;
    let code;
    if (timeout) {
        reason = count == null
            ? '轮询超时：订单未进入终态'
            : `轮询超时：已查询 ${count} 次，订单未进入终态`;
        code = 'POLL_TIMEOUT';
    } else {
        // A caught exception describes the current failure and must win over a
        // stale prior poll body such as "处理中". Terminal provider responses
        // have no exception and therefore continue to use their failure fields.
        reason = firstErrorReason(error, MAX_REASON_LENGTH)
            || firstScalar(
                getFailureReasonCandidates({ openProtocol, raw: source, result, providerReason }),
                MAX_REASON_LENGTH
            )
            || UNKNOWN_FAILURE_REASON;
        code = firstScalar([
            error?.providerCode,
            error?.businessCode,
            error?.code,
            ...getFailureCodeCandidates({ openProtocol, raw: source, result, providerCode })
        ], MAX_FIELD_LENGTH, IDENTIFIER_REDACTION_OPTIONS) || UNKNOWN_FAILURE_CODE;
    }

    return {
        reason,
        code,
        orderId: safeOrderId,
        status: safeStatus,
        requestId: safeRequestId,
        ...(count == null ? {} : { pollCount: count })
    };
}

module.exports = {
    UNKNOWN_FAILURE_REASON,
    UNKNOWN_FAILURE_CODE,
    MAX_REASON_LENGTH,
    redactSensitiveText,
    buildGptApiFailureDiagnostic
};
