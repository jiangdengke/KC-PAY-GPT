'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const axios = require('axios');
const adminAuth = require('./admin-auth');
const ipBan = require('./ip-ban');
const {
    sendSecurityAlert,
    notifyAdminSecurityEvent,
    notifyTelegramEvent
} = require('../services/telegram-notify');

const PUBLIC_CDK_QUOTAS = {
    lookup: { limit: 60, windowMs: 10 * 60 * 1000 },
    activation: { limit: 15, windowMs: 10 * 60 * 1000 }
};

const IP_BAN_DURATION_DAYS = {
    '1d': 1,
    '7d': 7,
    '30d': 30,
    permanent: null
};

const AUTO_BAN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_BAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_BAN_THRESHOLDS = { wrong_email: 3, wrong_password: 10, throttled: 5 };
const MAX_AUTO_BAN_KEYS = 20000;

const TOR_EXIT_URLS = [
    'https://check.torproject.org/torbulkexitlist',
    'https://www.dan.me.uk/torlist/?exit'
];
const TOR_REFRESH_MS = 60 * 60 * 1000;
const IP_BAN_REFRESH_MS = 60 * 1000;

function stripZone(ip) {
    return String(ip || '').trim().toLowerCase().replace(/%.*$/, '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
}

function createSecurityManager({ store, ensureStoreReady, dataDir }) {
    const torCacheFile = path.join(dataDir, 'tor-exit-list.txt');
    const runtimeStateFile = path.join(dataDir, 'runtime-state.json');

    const ipBanState = {
        matcher: ipBan.createBanMatcher([]),
        trustedIps: [],
        trustedSet: new Set()
    };
    const torExitState = {
        ips: new Set(),
        hits: 0,
        updatedAt: 0
    };
    let ipBanPendingHits = new Map();
    const autoBanCounters = new Map();
    const alertWindows = new Map();
    const rejectedLoginBursts = [];
    const timers = [];

    function getClientIp(req) {
        return adminAuth.resolveClientIp(req);
    }

    function alertSecurity(key, title, lines = [], { windowMs = 10 * 60 * 1000, max = 1 } = {}) {
        const now = Date.now();
        const entry = alertWindows.get(key) || { count: 0, resetAt: now + windowMs };
        if (entry.resetAt <= now) {
            entry.count = 0;
            entry.resetAt = now + windowMs;
        }
        if (entry.count >= max) {
            return;
        }
        entry.count += 1;
        alertWindows.set(key, entry);
        (async () => {
            try {
                await ensureStoreReady();
                await sendSecurityAlert(store, title, lines);
            } catch (error) {
                console.error(`[SecurityAlert] 发送失败 (${key}): ${error.message}`);
            }
        })();
    }

    function alertUnexpectedError(source, error) {
        const name = error?.name || 'Error';
        const message = String(error?.message || error || '').slice(0, 300);
        const firstFrame = String(error?.stack || '').split('\n')[1]?.trim().slice(0, 200) || '';
        alertSecurity(`err:${source}:${name}:${message.slice(0, 60)}`, `⚠️ 服务捕获未处理异常 (${source})`, [
            `类型: ${name}`,
            `信息: ${message || '无'}`,
            firstFrame ? `位置: ${firstFrame}` : '',
            '进程已继续运行，请排查具体原因'
        ].filter(Boolean));
    }

    function noteRejectedAdminLogin(ip) {
        const now = Date.now();
        rejectedLoginBursts.push({ ip, at: now });
        const cutoff = now - 5 * 60 * 1000;
        while (rejectedLoginBursts.length && rejectedLoginBursts[0].at < cutoff) {
            rejectedLoginBursts.shift();
        }
        if (rejectedLoginBursts.length >= 20) {
            const uniqueIps = new Set(rejectedLoginBursts.map((item) => item.ip)).size;
            alertSecurity('login-burst', '🚨 检测到后台登录失败激增', [
                `近 5 分钟已拒绝 ${rejectedLoginBursts.length} 次后台登录请求`,
                `涉及来源数: ${uniqueIps}`,
                `最新来源: ${ip || 'unknown'}`
            ], { windowMs: 30 * 60 * 1000, max: 1 });
        }
    }

    function writeRuntimeState(state) {
        try {
            fs.mkdirSync(path.dirname(runtimeStateFile), { recursive: true });
            fs.writeFileSync(runtimeStateFile, JSON.stringify({ ...state, pid: process.pid, at: new Date().toISOString() }));
        } catch (_) { /* ignore */ }
    }

    function markCleanShutdown() {
        writeRuntimeState({ clean: true });
    }

    function checkUnexpectedRestart() {
        let prev = null;
        try {
            prev = JSON.parse(fs.readFileSync(runtimeStateFile, 'utf8'));
        } catch (_) { /* 首次启动 */ }
        writeRuntimeState({ clean: false });
        if (prev && prev.clean === false) {
            console.warn(`⚠️ [Runtime] 检测到上次进程非正常退出 (启动于 ${prev.at || '未知'})`);
            alertSecurity('unexpected_restart', '🚨 服务异常重启', [
                `上次启动时间: ${prev.at || '未知'}`,
                '退出前未收到 SIGTERM/SIGINT，可能是进程崩溃或被 OOM 杀死',
                '请检查 docker logs 与安全日志'
            ]);
        }
    }

    async function refreshIpBans() {
        await ensureStoreReady();
        const [rows, safeIps] = await Promise.all([
            store.listActiveIpBanRules(),
            store.listRecentAdminLoginIps(30)
        ]);
        ipBanState.matcher = ipBan.createBanMatcher(rows);
        ipBanState.trustedIps = safeIps;
        ipBanState.trustedSet = new Set(safeIps.map((ip) => stripZone(ip)));
    }

    async function flushIpBanHits() {
        if (ipBanPendingHits.size === 0) return;
        const snapshot = ipBanPendingHits;
        ipBanPendingHits = new Map();
        try {
            await store.addIpBanHits(snapshot);
        } catch (error) {
            for (const [id, count] of snapshot) {
                ipBanPendingHits.set(id, (ipBanPendingHits.get(id) || 0) + count);
            }
            console.error('[IPBan] 回写拦截次数失败:', error.message);
        }
    }

    function loadCachedTorExitList() {
        try {
            const set = ipBan.parseTorExitList(fs.readFileSync(torCacheFile, 'utf8'));
            if (set.size > 0) {
                torExitState.ips = set;
                console.log(`🚫 [IPBan] 从本地缓存加载 ${set.size} 个 Tor 出口节点`);
            }
        } catch (_) { /* 首次运行无缓存 */ }
    }

    async function refreshTorExitList() {
        let lastError = null;
        for (const url of TOR_EXIT_URLS) {
            try {
                const res = await axios.get(url, { timeout: 15000, responseType: 'text' });
                const set = ipBan.parseTorExitList(res.data);
                if (set.size < 100) continue;
                torExitState.ips = set;
                torExitState.updatedAt = Date.now();
                try {
                    fs.mkdirSync(path.dirname(torCacheFile), { recursive: true });
                    fs.writeFileSync(torCacheFile, `${[...set].join('\n')}\n`);
                } catch (_) { /* ignore */ }
                return;
            } catch (error) {
                lastError = error;
            }
        }
        if (lastError) throw lastError;
    }

    async function restoreAutoBanCounters(adminEmail) {
        const rows = await store.listLoginFailureCounts(AUTO_BAN_WINDOW_MS / 60000);
        const now = Date.now();
        const cutoff = now - AUTO_BAN_WINDOW_MS;
        const prepared = [];
        for (const row of rows) {
            const at = new Date(row.first_at).getTime() || now;
            if (at < cutoff) continue;
            const signal = row.admin_email && adminAuth.normalizeEmail(row.admin_email) !== adminEmail
                ? 'wrong_email'
                : 'wrong_password';
            prepared.push({
                ip: row.ip,
                signal,
                attempts: Number(row.attempts || 0),
                at
            });
        }
        const merged = ipBan.mergeAutoBanCounts(prepared);
        for (const item of merged) {
            autoBanCounters.set(`${item.signal}|${item.cidr}`, {
                count: item.count,
                firstAt: item.firstAt
            });
        }
        return merged.length;
    }

    async function noteAutoBanSignal(ip, signal, detail = '') {
        const threshold = AUTO_BAN_THRESHOLDS[signal];
        const cidr = ipBan.isLoopback(ip) ? '' : ipBan.autoBanCidrForIp(ip);
        if (!threshold || !cidr) return false;
        if (ipBanState.trustedSet.has(stripZone(ip))) return false;
        if (ipBanState.matcher.match(ip)) return false;

        const key = `${signal}|${cidr}`;
        const now = Date.now();
        let entry = autoBanCounters.get(key);
        if (!entry || now - entry.firstAt > AUTO_BAN_WINDOW_MS) {
            if (autoBanCounters.size >= MAX_AUTO_BAN_KEYS) {
                for (const [k, v] of autoBanCounters) {
                    if (now - v.firstAt > AUTO_BAN_WINDOW_MS) autoBanCounters.delete(k);
                }
                if (autoBanCounters.size >= MAX_AUTO_BAN_KEYS) {
                    autoBanCounters.delete(autoBanCounters.keys().next().value);
                }
            }
            entry = { count: 0, firstAt: now };
        }
        entry.count += 1;
        autoBanCounters.set(key, entry);
        if (entry.count < threshold) return false;

        autoBanCounters.delete(key);
        const expiresAt = new Date(now + AUTO_BAN_DURATION_MS);
        const reasonLabels = {
            wrong_email: `自动封禁：24h 内 ${threshold} 次使用不存在的管理员邮箱尝试登录`,
            wrong_password: `自动封禁：24h 内 ${threshold} 次管理员登录失败`,
            throttled: `自动封禁：触发登录限流后仍持续尝试 ${threshold} 次`
        };
        const reason = detail ? `${reasonLabels[signal]}（${detail}）` : reasonLabels[signal];
        await store.saveIpBan({ cidr, reason, source: 'auto', expiresAt });
        await refreshIpBans();
        console.warn(`🛡️ [IPBan] ${cidr} ${reason}`);
        alertSecurity(`autoban:${cidr}`, '🛡️ 已自动封禁异常来源 IP', [
            `封禁网段: ${cidr}`,
            `触发 IP: ${ip}`,
            `原因: ${reason}`,
            `有效期: 7 天（到期 ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC）`
        ]);
        return true;
    }

    async function recordThrottledLoginAttempt(ip, reason) {
        return noteAutoBanSignal(ip, 'throttled', reason || 'rate_limited');
    }

    function ipBanMiddleware(req, res, next) {
        const ip = getClientIp(req);
        const normalizedIp = stripZone(ip);
        if (normalizedIp && net.isIP(normalizedIp) && torExitState.ips.has(normalizedIp)) {
            torExitState.hits += 1;
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, message: '拒绝访问' });
            }
            return res.status(403).type('text/plain').send('Forbidden');
        }
        const matched = ipBanState.matcher.match(ip);
        if (!matched) {
            return next();
        }
        ipBanPendingHits.set(matched.id, (ipBanPendingHits.get(matched.id) || 0) + 1);
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ success: false, message: '拒绝访问' });
        }
        return res.status(403).type('text/plain').send('Forbidden');
    }

    function enforcePublicCdkQuota(req, res, bucket, cost = 1) {
        const policy = PUBLIC_CDK_QUOTAS[bucket];
        if (!policy) return true;
        const result = adminAuth.consumeRequestQuota(bucket, getClientIp(req), {
            ...policy,
            cost: Math.max(1, Number(cost) || 1)
        });
        if (result.allowed) return true;
        res.setHeader('Retry-After', String(result.retryAfterSec));
        res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
        return false;
    }

    async function logAdminSecurityEvent(event, meta = {}) {
        try {
            await store.insertAdminLoginLog({
                event,
                adminEmail: meta.email || '',
                ip: meta.ip || '',
                userAgent: meta.userAgent || '',
                fingerprint: meta.fingerprint || '',
                detail: meta.detail || ''
            });
        } catch (error) {
            console.error(`[AdminAuth] 写入安全日志失败: ${error.message}`);
        }
    }

    function fireAdminSecurityNotification(event, payload = {}) {
        notifyAdminSecurityEvent(store, event, payload).catch((error) => {
            console.error(`[AdminAuth] 发送 Telegram 安全通知失败: ${error.message}`);
        });
    }

    function fireTelegramNotification(event, payload = {}) {
        notifyTelegramEvent(store, event, payload).catch((error) => {
            console.error(`[Telegram] ${event} 通知失败: ${error.message}`);
        });
    }

    async function startBackgroundTasks() {
        checkUnexpectedRestart();

        try {
            await refreshIpBans();
            console.log(`🚫 [IPBan] 已加载 ${ipBanState.matcher.size} 条生效中的封禁规则`);
        } catch (error) {
            console.error(`❌ [IPBan] 加载封禁规则失败: ${error.message}`);
        }

        const banTimer = setInterval(() => {
            refreshIpBans().catch((error) => console.warn(`[IPBan] 刷新失败: ${error.message}`));
            flushIpBanHits().catch((error) => console.warn(`[IPBan] 写入命中次数失败: ${error.message}`));
        }, IP_BAN_REFRESH_MS);
        banTimer.unref();
        timers.push(banTimer);

        loadCachedTorExitList();
        const updateTorExitList = () => refreshTorExitList()
            .then(() => console.log(`🚫 [IPBan] Tor 出口列表已更新，共 ${torExitState.ips.size} 个`))
            .catch((error) => console.warn(`[IPBan] Tor 出口列表更新失败，继续使用旧列表（${torExitState.ips.size} 个）: ${error.message}`));
        updateTorExitList();
        const torTimer = setInterval(updateTorExitList, TOR_REFRESH_MS);
        torTimer.unref();
        timers.push(torTimer);

        try {
            const { email } = await store.getAdminAuthConfig();
            const adminEmail = adminAuth.normalizeEmail(email);
            const failures = await store.listRecentLoginFailures(30);
            adminAuth.restoreLoginFailures(failures.map((row) => ({
                ip: row.ip,
                scope: row.event === '2fa_failed' ? '2fa' : 'login',
                at: new Date(row.created_at).getTime(),
                countGlobal: row.event === '2fa_failed' || adminAuth.normalizeEmail(row.admin_email) === adminEmail
            })));
            const restoredSources = await restoreAutoBanCounters(adminEmail);
            console.log(`🔒 [AdminAuth] 已从登录日志恢复 ${failures.length} 条失败记录，${restoredSources} 个来源的自动封禁计数`);
        } catch (error) {
            console.error(`❌ [AdminAuth] 恢复登录失败记录失败: ${error.message}`);
        }
    }

    function stopBackgroundTasks() {
        for (const timer of timers) {
            clearInterval(timer);
        }
        timers.length = 0;
    }

    return {
        IP_BAN_DURATION_DAYS,
        ipBanState,
        torExitState,
        getClientIp,
        alertSecurity,
        alertUnexpectedError,
        noteRejectedAdminLogin,
        markCleanShutdown,
        refreshIpBans,
        flushIpBanHits,
        noteAutoBanSignal,
        recordThrottledLoginAttempt,
        ipBanMiddleware,
        enforcePublicCdkQuota,
        logAdminSecurityEvent,
        fireAdminSecurityNotification,
        fireTelegramNotification,
        startBackgroundTasks,
        stopBackgroundTasks
    };
}

module.exports = {
    IP_BAN_DURATION_DAYS,
    PUBLIC_CDK_QUOTAS,
    AUTO_BAN_THRESHOLDS,
    createSecurityManager
};
