'use strict';

const CANONICAL_PLAN_TYPES = Object.freeze(['plus', 'pro100', 'pro200', 'pro500']);
const LEGACY_PLAN_TYPES = Object.freeze(['pro_5x', 'pro_20x']);

const PLAN_REGISTRY = Object.freeze({
    plus: Object.freeze({
        type: 'plus',
        label: 'Plus',
        displayLabel: 'ChatGPT Plus',
        checkoutPlanName: 'chatgptplusplan',
        desolatePlanCode: 'chatgptplusplan',
        credentialAliases: Object.freeze(['plus', 'plus plan', 'chatgptplus', 'chatgpt plus', 'chatgptplusplan', 'chatgpt plus plan']),
        orbitcardPriceAliases: Object.freeze(['plus', 'chatgptplusplan']),
        defaultReuseLimit: 4,
        defaultSafetyMargin: 1
    }),
    pro100: Object.freeze({
        type: 'pro100',
        label: 'Pro 100',
        displayLabel: 'ChatGPT Pro 100',
        checkoutPlanName: '',
        desolatePlanCode: '',
        credentialAliases: Object.freeze(['pro100', 'pro_100', 'pro-100', 'pro 100', 'chatgptpro100', 'chatgpt_pro100', 'chatgpt-pro100', 'chatgpt pro 100']),
        orbitcardPriceAliases: Object.freeze(['pro100', 'pro_100', 'pro-100', 'pro 100']),
        defaultReuseLimit: 1,
        defaultSafetyMargin: 1
    }),
    pro200: Object.freeze({
        type: 'pro200',
        label: 'Pro 200',
        displayLabel: 'ChatGPT Pro 200',
        checkoutPlanName: '',
        desolatePlanCode: '',
        credentialAliases: Object.freeze(['pro200', 'pro_200', 'pro-200', 'pro 200', 'chatgptpro200', 'chatgpt_pro200', 'chatgpt-pro200', 'chatgpt pro 200']),
        orbitcardPriceAliases: Object.freeze(['pro200', 'pro_200', 'pro-200', 'pro 200']),
        defaultReuseLimit: 1,
        defaultSafetyMargin: 1
    }),
    pro500: Object.freeze({
        type: 'pro500',
        label: 'Pro 500',
        displayLabel: 'ChatGPT Pro 500',
        checkoutPlanName: '',
        desolatePlanCode: '',
        credentialAliases: Object.freeze(['pro500', 'pro_500', 'pro-500', 'pro 500', 'chatgptpro500', 'chatgpt_pro500', 'chatgpt-pro500', 'chatgpt pro 500']),
        orbitcardPriceAliases: Object.freeze(['pro500', 'pro_500', 'pro-500', 'pro 500']),
        defaultReuseLimit: 1,
        defaultSafetyMargin: 1
    })
});

const PLAN_NAME_MAP = Object.freeze(Object.fromEntries(
    CANONICAL_PLAN_TYPES.map((planType) => [planType, PLAN_REGISTRY[planType].checkoutPlanName])
));

const LEGACY_PLAN_REGISTRY = Object.freeze({
    pro_5x: Object.freeze({
        type: 'pro_5x',
        label: 'Pro 5x（历史）',
        displayLabel: 'ChatGPT Pro 5x',
        checkoutPlanName: 'chatgptprolite',
        orbitcardPriceAliases: Object.freeze(['pro_5x', 'pro5x', 'prolite', 'pro']),
        defaultReuseLimit: 1,
        defaultSafetyMargin: 1
    }),
    pro_20x: Object.freeze({
        type: 'pro_20x',
        label: 'Pro 20x（历史）',
        displayLabel: 'ChatGPT Pro 20x',
        checkoutPlanName: 'chatgptpro',
        orbitcardPriceAliases: Object.freeze(['pro_20x', 'pro20x', 'pro-20x']),
        defaultReuseLimit: 1,
        defaultSafetyMargin: 1
    })
});

const READABLE_PLAN_TYPES = Object.freeze([...CANONICAL_PLAN_TYPES, ...LEGACY_PLAN_TYPES]);
const CANONICAL_PLAN_SET = new Set(CANONICAL_PLAN_TYPES);
const READABLE_PLAN_SET = new Set(READABLE_PLAN_TYPES);

function normalizePlanValue(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function isCanonicalPlanType(value) {
    return CANONICAL_PLAN_SET.has(normalizePlanValue(value));
}

function isReadablePlanType(value) {
    return READABLE_PLAN_SET.has(normalizePlanValue(value));
}

function requireCanonicalPlanType(value, fieldName = 'plan_type') {
    const normalized = normalizePlanValue(value);
    if (!CANONICAL_PLAN_SET.has(normalized)) {
        throw new Error(`${fieldName} 必须是 ${CANONICAL_PLAN_TYPES.join(' / ')}`);
    }
    return normalized;
}

function requireReadablePlanType(value, fieldName = 'plan_type') {
    const normalized = normalizePlanValue(value);
    if (!READABLE_PLAN_SET.has(normalized)) {
        throw new Error(`${fieldName} 不受支持: ${String(value || '空值')}`);
    }
    return normalized;
}

function getPlanDefinition(value, options = {}) {
    const normalized = normalizePlanValue(value);
    if (PLAN_REGISTRY[normalized]) return PLAN_REGISTRY[normalized];
    if (options.includeLegacy && LEGACY_PLAN_REGISTRY[normalized]) return LEGACY_PLAN_REGISTRY[normalized];
    return null;
}

function getPlanLabel(value, options = {}) {
    const definition = getPlanDefinition(value, { includeLegacy: options.includeLegacy !== false });
    if (definition) return options.full ? definition.displayLabel : definition.label;
    const raw = String(value || '').trim();
    return raw ? `未知套餐 (${raw})` : '未知套餐';
}

function normalizeCredentialPlan(value, hasActive = true) {
    const raw = normalizePlanValue(value);
    if (!raw) return hasActive ? 'unknown' : 'free';
    const compact = raw.replace(/[\s_-]+/g, '');
    for (const type of CANONICAL_PLAN_TYPES) {
        const aliases = PLAN_REGISTRY[type].credentialAliases;
        if (aliases.includes(raw) || aliases.some((alias) => alias.replace(/[\s_-]+/g, '') === compact)) return type;
    }
    if (raw.includes('team')) return 'team';
    if (raw.includes('free')) return 'free';
    return raw.slice(0, 40);
}

function resolveCheckoutPlanName(value, overrides = {}) {
    const type = requireReadablePlanType(value);
    const override = String(overrides[type] || '').trim();
    if (override) return override;
    const definition = getPlanDefinition(type, { includeLegacy: true });
    const planName = String(definition?.checkoutPlanName || '').trim();
    if (!planName) {
        throw new Error(`${getPlanLabel(type)} 的 Checkout plan_name 未配置`);
    }
    return planName;
}

function resolveDesolatePlanCode(value, mappings = {}) {
    const type = requireCanonicalPlanType(value);
    const configured = String(mappings[type] || '').trim();
    if (configured) return configured;
    const documented = String(PLAN_REGISTRY[type].desolatePlanCode || '').trim();
    if (documented) return documented;
    throw new Error(`${getPlanLabel(type)} 的 Desolate planCode 未配置，供应商公开文档未提供该套餐代码`);
}

function getOrbitcardPriceAliases(value, options = {}) {
    const definition = getPlanDefinition(value, { includeLegacy: options.includeLegacy === true });
    return definition ? [...definition.orbitcardPriceAliases] : [];
}

function getDefaultReuseLimit(value, options = {}) {
    const definition = getPlanDefinition(value, { includeLegacy: options.includeLegacy === true });
    return definition ? definition.defaultReuseLimit : null;
}

function getDefaultSafetyMargin(value, options = {}) {
    const definition = getPlanDefinition(value, { includeLegacy: options.includeLegacy === true });
    return definition ? definition.defaultSafetyMargin : null;
}

module.exports = {
    PLAN_REGISTRY,
    LEGACY_PLAN_REGISTRY,
    PLAN_NAME_MAP,
    CANONICAL_PLAN_TYPES,
    LEGACY_PLAN_TYPES,
    READABLE_PLAN_TYPES,
    normalizePlanValue,
    isCanonicalPlanType,
    isReadablePlanType,
    requireCanonicalPlanType,
    requireReadablePlanType,
    getPlanDefinition,
    getPlanLabel,
    normalizeCredentialPlan,
    resolveCheckoutPlanName,
    resolveDesolatePlanCode,
    getOrbitcardPriceAliases,
    getDefaultReuseLimit,
    getDefaultSafetyMargin
};
