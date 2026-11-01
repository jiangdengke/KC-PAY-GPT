'use strict';

const ipBan = require('../ip-ban');

describe('normalizeBanCidr', () => {
    it('normalizes single IPs and networks to their network address', () => {
        expect(ipBan.normalizeBanCidr('109.120.178.219').cidr).toBe('109.120.178.219/32');
        expect(ipBan.normalizeBanCidr('2a01:e5c0:2e15:d011::1/48').cidr).toBe('2a01:e5c0:2e15::/48');
        expect(ipBan.normalizeBanCidr('10.1.2.3/16').cidr).toBe('10.1.0.0/16');
        expect(ipBan.normalizeBanCidr(' 2A01:E5C0:2E15::1 ').cidr).toBe('2a01:e5c0:2e15::1/128');
        expect(ipBan.normalizeBanCidr('::ffff:1.2.3.4').cidr).toBe('1.2.3.4/32');
    });

    it('rejects invalid input and networks that are too large', () => {
        expect(() => ipBan.normalizeBanCidr('')).toThrow('请填写');
        expect(() => ipBan.normalizeBanCidr('300.1.1.1')).toThrow('不是有效的 IP');
        expect(() => ipBan.normalizeBanCidr('1.2.3.4/33')).toThrow('前缀无效');
        expect(() => ipBan.normalizeBanCidr('1.0.0.0/8')).toThrow('网段太大');
        expect(() => ipBan.normalizeBanCidr('2a01::/16')).toThrow('网段太大');
        expect(() => ipBan.normalizeBanCidr('1.2.3.4/24/1')).toThrow('无法识别');
    });
});

describe('createBanMatcher', () => {
    const rows = [
        { id: 1, cidr: '2a01:e5c0:2e15::/48', expires_at: null },
        { id: 2, cidr: '109.120.178.219/32', expires_at: new Date(Date.now() + 60_000) },
        { id: 3, cidr: '198.51.100.0/24', expires_at: new Date(Date.now() - 60_000) },
        { id: 4, cidr: 'garbage', expires_at: null }
    ];

    it('matches IPv4 and IPv6 sources inside active bans only', () => {
        const matcher = ipBan.createBanMatcher(rows);
        expect(matcher.size).toBe(2);
        expect(matcher.match('2a01:e5c0:2e15:d044::1')?.id).toBe(1);
        expect(matcher.match('109.120.178.219')?.id).toBe(2);
        expect(matcher.match('::ffff:109.120.178.219')?.id).toBe(2);
        expect(matcher.match('198.51.100.7')).toBeNull();
        expect(matcher.match('2a01:e5c0:2e16::1')).toBeNull();
        expect(matcher.match('23.226.70.138')).toBeNull();
        expect(matcher.match('not-an-ip')).toBeNull();
    });

    it('never blocks loopback even when a rule covers it', () => {
        const matcher = ipBan.createBanMatcher([{ id: 9, cidr: '127.0.0.0/16', expires_at: null }]);
        expect(matcher.match('127.0.0.1')).toBeNull();
        expect(matcher.match('::1')).toBeNull();
    });
});

describe('ban helpers', () => {
    it('computes auto-ban scope: single IPv4, IPv6 /48', () => {
        expect(ipBan.autoBanCidrForIp('109.120.178.219')).toBe('109.120.178.219/32');
        expect(ipBan.autoBanCidrForIp('2a01:e5c0:2e15:d011::1')).toBe('2a01:e5c0:2e15::/48');
        expect(ipBan.autoBanCidrForIp('bad')).toBe('');
    });

    it('checks whether a network contains an IP', () => {
        expect(ipBan.cidrContainsIp('23.226.0.0/16', '23.226.70.138')).toBe(true);
        expect(ipBan.cidrContainsIp('23.227.0.0/16', '23.226.70.138')).toBe(false);
        expect(ipBan.cidrContainsIp('2a01:e5c0:2e15::/48', '2a01:e5c0:2e15:ffff::1')).toBe(true);
        expect(ipBan.cidrContainsIp('2a01:e5c0:2e15::/48', '1.2.3.4')).toBe(false);
    });
});
