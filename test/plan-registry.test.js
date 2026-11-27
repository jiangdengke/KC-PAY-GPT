'use strict';

const registry = require('../src/config/plan-registry');
const subscription = require('../src/services/subscription-check');

describe('Plus-only plan registry with read-only legacy compatibility', () => {
    it('allows only Plus for canonical write operations and keeps historical Pro tiers readable only', () => {
        expect(registry.CANONICAL_PLAN_TYPES).toEqual(['plus']);
        expect(registry.READABLE_PLAN_TYPES).toEqual([
            'plus', 'pro100', 'pro200', 'pro500', 'pro_5x', 'pro_20x'
        ]);
        expect(registry.requireCanonicalPlanType(' Plus ')).toBe('plus');
        expect(() => registry.requireCanonicalPlanType('pro100')).toThrow(/必须是 plus/);
        expect(() => registry.requireCanonicalPlanType('pro200')).toThrow(/必须是 plus/);
        expect(() => registry.requireCanonicalPlanType('pro500')).toThrow(/必须是 plus/);
        expect(() => registry.requireCanonicalPlanType('pro_5x')).toThrow(/必须是 plus/);
        expect(registry.requireReadablePlanType('pro200')).toBe('pro200');
        expect(registry.requireReadablePlanType('pro_5x')).toBe('pro_5x');
        expect(registry.getPlanLabel('pro200')).toBe('Pro 200（历史）');
        expect(registry.getPlanLabel('pro_20x', { full: true })).toBe('ChatGPT Pro 20x');
        expect(registry.getPlanLabel('mystery')).toBe('未知套餐 (mystery)');
    });

    it('never silently converts unknown plan values to Plus', () => {
        expect(registry.normalizeCredentialPlan('enterprise-special', true)).toBe('enterprise-special');
        expect(() => registry.resolveCheckoutPlanName('mystery')).toThrow(/不受支持/);
        expect(() => registry.resolveDesolatePlanCode('mystery')).toThrow(/必须是 plus/);
        expect(registry.getOrbitcardPriceAliases('mystery')).toEqual([]);
    });

    it('preserves read-only Subscription Credential recognition across Plus and Pro tiers', () => {
        for (const planType of ['plus', 'pro100', 'pro200', 'pro500']) {
            expect(subscription.normalizeSubscriptionPlan(planType, true)).toBe(planType);
            const parsed = subscription.parseAccountCheckResponse({
                accounts: {
                    default: {
                        account: { account_id: 'acct_1' },
                        entitlement: {
                            has_active_subscription: true,
                            subscription_plan: planType
                        }
                    }
                }
            });
            expect(parsed.planKey).toBe(planType);
            expect(parsed.rawPlan).toBe(planType);
        }
    });
});
