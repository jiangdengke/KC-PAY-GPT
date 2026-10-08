'use strict';

const registry = require('../plan-registry');
const subscription = require('../subscription-check');

describe('four-tier plan registry', () => {
    it('defines exactly the canonical write tiers and keeps legacy values readable only', () => {
        expect(registry.CANONICAL_PLAN_TYPES).toEqual(['plus', 'pro100', 'pro200', 'pro500']);
        expect(registry.READABLE_PLAN_TYPES).toEqual([
            'plus', 'pro100', 'pro200', 'pro500', 'pro_5x', 'pro_20x'
        ]);
        expect(registry.requireCanonicalPlanType(' Pro200 ')).toBe('pro200');
        expect(() => registry.requireCanonicalPlanType('pro_5x')).toThrow(/必须是/);
        expect(registry.requireReadablePlanType('pro_5x')).toBe('pro_5x');
        expect(registry.getPlanLabel('pro_20x', { full: true })).toBe('ChatGPT Pro 20x');
        expect(registry.getPlanLabel('mystery')).toBe('未知套餐 (mystery)');
    });

    it('never silently converts unknown plan values to Plus', () => {
        expect(registry.normalizeCredentialPlan('enterprise-special', true)).toBe('enterprise-special');
        expect(() => registry.resolveCheckoutPlanName('mystery')).toThrow(/不受支持/);
        expect(() => registry.resolveDesolatePlanCode('mystery')).toThrow(/必须是/);
        expect(registry.getOrbitcardPriceAliases('mystery')).toEqual([]);
    });

    it('preserves exact four-tier Subscription Credential states', () => {
        for (const planType of registry.CANONICAL_PLAN_TYPES) {
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
