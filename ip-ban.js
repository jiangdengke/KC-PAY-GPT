'use strict';

const net = require('net');

// 网段下限：防止手滑封掉一大片（例如 1.0.0.0/8 或整个 IPv6 运营商）
const MIN_BAN_PREFIX = { 4: 16, 6: 32 };
const MAX_PREFIX = { 4: 32, 6: 128 };
// IPv6 自动封禁按 /48：2026-11 的撞库来自同一个 /48 下两万多个地址
const AUTO_BAN_IPV6_PREFIX = 48;

function stripZone(ip) {
    return String(ip || '').trim().toLowerCase().replace(/%.*$/, '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
}

function ipv4ToBigInt(ip) {
    return ip.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip) {
    let value = ip;
    // 末尾内嵌 IPv4（如 ::ffff:1.2.3.4）转成两个十六进制段
    const v4Tail = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Tail) {
        const n = ipv4ToBigInt(v4Tail[1]);
        value = `${value.slice(0, -v4Tail[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
    }
    const [head, tail = ''] = value.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const parts = value.includes('::')
        ? [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts]
        : headParts;
    return parts.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || '0', 16)), 0n);
}

function toBigInt(ip, family) {
    return family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
}

function maskNetwork(value, family, prefix) {
    const bits = BigInt(MAX_PREFIX[family]);
    const hostBits = bits - BigInt(prefix);
    return (value >> hostBits) << hostBits;
}

function formatIpv4(value) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

function formatIpv6(value) {
    const groups = [];
    for (let i = 7; i >= 0; i -= 1) {
        groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
    }
    // 压缩最长的一段连续 0
    let bestStart = -1;
    let bestLength = 0;
    for (let i = 0; i < 8;) {
        if (groups[i] !== '0') { i += 1; continue; }
        let j = i;
        while (j < 8 && groups[j] === '0') j += 1;
        if (j - i > bestLength && j - i > 1) { bestStart = i; bestLength = j - i; }
        i = j;
    }
    if (bestStart < 0) return groups.join(':');
    const left = groups.slice(0, bestStart).join(':');
    const right = groups.slice(bestStart + bestLength).join(':');
    return `${left}::${right}`;
}

function formatNetwork(value, family) {
    return family === 4 ? formatIpv4(value) : formatIpv6(value);
}

/**
 * 把用户输入的 IP 或 CIDR 规范成网络地址形式，例如 2a01:e5c0:2e15:d011::1/48 → 2a01:e5c0:2e15::/48。
 * 输入非法或网段过大时抛出带中文说明的 Error。
 */
function normalizeBanCidr(input) {
    const raw = String(input || '').trim();
    if (!raw) {
        throw new Error('请填写 IP 或网段');
    }
    const [addressPart, prefixPart, extra] = raw.split('/');
    if (extra !== undefined) {
        throw new Error(`无法识别：${raw}`);
    }
    const address = stripZone(addressPart);
    const family = net.isIP(address);
    if (!family) {
        throw new Error(`不是有效的 IP：${addressPart}`);
    }
    const prefix = prefixPart === undefined ? MAX_PREFIX[family] : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > MAX_PREFIX[family]) {
        throw new Error(`网段前缀无效：/${prefixPart}`);
    }
    if (prefix < MIN_BAN_PREFIX[family]) {
        throw new Error(`网段太大：IPv${family} 最大只能封到 /${MIN_BAN_PREFIX[family]}`);
    }
    const network = maskNetwork(toBigInt(address, family), family, prefix);
    return { cidr: `${formatNetwork(network, family)}/${prefix}`, family, prefix, network };
}

function parseClientIp(ip) {
    const address = stripZone(ip);
    const family = net.isIP(address);
    return family ? { family, value: toBigInt(address, family) } : null;
}

function cidrContainsIp(cidr, ip) {
    const parsed = parseClientIp(ip);
    if (!parsed) return false;
    let rule;
    try {
        rule = normalizeBanCidr(cidr);
    } catch (_) {
        return false;
    }
    return rule.family === parsed.family && maskNetwork(parsed.value, parsed.family, rule.prefix) === rule.network;
}

function isLoopback(ip) {
    const address = stripZone(ip);
    return address === '::1' || address.startsWith('127.');
}

/**
 * 按“地址族 → 前缀长度 → 网络地址”建索引，单次匹配只需按前缀种类查几次 Map。
 * rows: [{ id, cidr, expires_at }]；已过期或无法解析的规则会被跳过。
 */
function createBanMatcher(rows = [], now = Date.now()) {
    const index = { 4: new Map(), 6: new Map() };
    let size = 0;
    for (const row of rows) {
        const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
        if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now) continue;
        let rule;
        try {
            rule = normalizeBanCidr(row.cidr);
        } catch (_) {
            continue;
        }
        if (!index[rule.family].has(rule.prefix)) index[rule.family].set(rule.prefix, new Map());
        index[rule.family].get(rule.prefix).set(rule.network.toString(), { ...row, expiresAt });
        size += 1;
    }
    return {
        size,
        match(ip) {
            if (size === 0 || isLoopback(ip)) return null;
            const parsed = parseClientIp(ip);
            if (!parsed) return null;
            for (const [prefix, networks] of index[parsed.family]) {
                const hit = networks.get(maskNetwork(parsed.value, parsed.family, prefix).toString());
                if (hit && (hit.expiresAt === null || hit.expiresAt > Date.now())) return hit;
            }
            return null;
        }
    };
}

// 自动封禁的范围：IPv4 封单个地址，IPv6 封所在 /48
function autoBanCidrForIp(ip) {
    const parsed = parseClientIp(ip);
    if (!parsed) return '';
    const prefix = parsed.family === 4 ? 32 : AUTO_BAN_IPV6_PREFIX;
    return `${formatNetwork(maskNetwork(parsed.value, parsed.family, prefix), parsed.family)}/${prefix}`;
}

// 解析 Tor 官方出口列表（每行一个 IP），非法行直接丢弃
function parseTorExitList(text) {
    const ips = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
        const address = stripZone(line);
        if (address && net.isIP(address)) ips.add(address);
    }
    return ips;
}

module.exports = {
    parseTorExitList,
    MIN_BAN_PREFIX,
    AUTO_BAN_IPV6_PREFIX,
    normalizeBanCidr,
    cidrContainsIp,
    createBanMatcher,
    autoBanCidrForIp,
    isLoopback
};
