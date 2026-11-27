'use strict';

const express = require('express');
const adminAuth = require('../security/admin-auth');
const ipBan = require('../security/ip-ban');
const { buildAdminLoginUrl, buildAdminPanelUrl } = require('../security/admin-paths');
const { sendTelegramLoginCode } = require('../services/telegram-notify');
const { forwardAsyncErrors } = require('../middleware/async-handler');

function formatIpBanRow(row) {
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    return {
        id: Number(row.id),
        cidr: row.cidr,
        reason: row.reason || '',
        source: row.source === 'auto' ? 'auto' : 'manual',
        hits: Number(row.hits || 0),
        lastHitAt: row.last_hit_at ? new Date(row.last_hit_at).toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        active: !expiresAt || expiresAt.getTime() > Date.now()
    };
}

function createAdminAuthRouters({
    store,
    ensureStoreReady,
    security,
    getCachedAdminPaths,
    setCachedAdminPaths
}) {
    const publicAuthRouter = forwardAsyncErrors(express.Router());
    const protectedAuthRouter = forwardAsyncErrors(express.Router());

    async function attachAdminPaths(payload = {}) {
        const paths = await getCachedAdminPaths();
        return {
            ...payload,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        };
    }

    // ─── Unauthenticated (still behind CF Access) Login & 2FA ─────────────

    publicAuthRouter.post('/login', async (req, res) => {
        const email = adminAuth.normalizeEmail(req.body?.email);
        const password = String(req.body?.password || '');
        const clientMeta = adminAuth.getClientMeta(req);

        if (!email || !password) {
            return res.status(400).json({ success: false, message: '请输入管理员邮箱和密码' });
        }

        const rate = adminAuth.checkLoginRateLimit(clientMeta.ip);
        if (!rate.allowed) {
            security.noteRejectedAdminLogin(clientMeta.ip);
            security.recordThrottledLoginAttempt(clientMeta.ip, rate.reason).catch((error) => {
                console.warn(`[IPBan] 自动封禁失败: ${error.message}`);
            });
            return res.status(429).json({
                success: false,
                message: `登录尝试过多，请 ${rate.retryAfterSec} 秒后再试`
            });
        }

        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            const telegramSettings = await store.getTelegramConfig();
            const emailOk = email === adminAuth.normalizeEmail(authConfig.email);
            const passwordOk = await adminAuth.verifyPasswordAsync(password, authConfig.passwordHash);

            if (!emailOk || !passwordOk) {
                adminAuth.recordLoginFailure(rate.key, rate.entry, { countGlobal: emailOk });
                security.noteRejectedAdminLogin(clientMeta.ip);
                security.noteAutoBanSignal(clientMeta.ip, emailOk ? 'wrong_password' : 'wrong_email').catch((error) => {
                    console.warn(`[IPBan] 自动封禁失败: ${error.message}`);
                });
                await security.logAdminSecurityEvent('login_failed', {
                    ...clientMeta,
                    email,
                    detail: '邮箱或密码错误'
                });
                security.fireAdminSecurityNotification('admin_login_failed', {
                    email,
                    ip: clientMeta.ip,
                    fingerprint: clientMeta.fingerprint,
                    userAgent: clientMeta.userAgent,
                    message: '邮箱或密码错误'
                });
                return res.status(401).json({ success: false, message: '邮箱或密码错误' });
            }

            adminAuth.clearLoginAttempts(rate.key);

            const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
            if (!adminAuth.is2faRequired(authConfig, telegramSettings)) {
                const { token, payload } = adminAuth.issueAdminToken(authConfig.passwordVersion, authConfig.email);
                await security.logAdminSecurityEvent('login_success', {
                    ...clientMeta,
                    email: authConfig.email,
                    detail: '密码登录（未启用二次验证）'
                });
                security.fireAdminSecurityNotification('admin_login_success', {
                    email: authConfig.email,
                    ip: clientMeta.ip,
                    fingerprint: clientMeta.fingerprint,
                    userAgent: clientMeta.userAgent,
                    method: 'password_only',
                    message: '后台登录成功（尚未启用 2FA）'
                });
                return res.json(await attachAdminPaths({
                    success: true,
                    token,
                    expiresAt: payload.exp,
                    issuedAt: payload.iat,
                    permissions: payload.permissions,
                    email: authConfig.email,
                    requires2fa: false,
                    setupRequired: true
                }));
            }

            const challenge = adminAuth.issueLoginChallenge({
                email: authConfig.email,
                passwordVersion: authConfig.passwordVersion,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint
            });

            return res.json({
                success: true,
                requires2fa: true,
                challengeToken: challenge.token,
                methods,
                defaultMethod: adminAuth.pickDefaultLogin2faMethod(
                    methods,
                    authConfig.login2faMode === 'either' ? '' : authConfig.login2faMode
                ),
                login2faMode: authConfig.login2faMode,
                email: authConfig.email,
                expiresAt: challenge.payload.exp
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    publicAuthRouter.post('/login/send-tg-code', async (req, res) => {
        const challengeToken = String(req.body?.challengeToken || '').trim();
        const challenge = adminAuth.verifyLoginChallenge(challengeToken);
        if (!challenge) {
            return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
        }

        try {
            await ensureStoreReady();
            const code = adminAuth.generateTelegramLoginCode();
            adminAuth.storeTelegramLoginCode(challenge.cid, code);
            const clientMeta = adminAuth.getClientMeta(req);
            const sendResult = await sendTelegramLoginCode(store, code, {
                email: challenge.email,
                ip: clientMeta.ip || challenge.ip
            });
            if (!sendResult.ok) {
                return res.status(400).json({ success: false, message: sendResult.error || 'Telegram 验证码发送失败' });
            }
            return res.json({ success: true, message: '验证码已发送到管理员 Telegram' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    publicAuthRouter.post('/login/verify-2fa', async (req, res) => {
        const challengeToken = String(req.body?.challengeToken || '').trim();
        const method = String(req.body?.method || '').trim().toLowerCase();
        const code = String(req.body?.code || '').trim();
        const clientMeta = adminAuth.getClientMeta(req);
        const challenge = adminAuth.verifyLoginChallenge(challengeToken);

        if (!challenge) {
            return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
        }
        if (!code) {
            return res.status(400).json({ success: false, message: '请输入验证码' });
        }

        const rate = adminAuth.checkLoginRateLimit(clientMeta.ip, '2fa');
        if (!rate.allowed) {
            security.noteRejectedAdminLogin(clientMeta.ip);
            security.recordThrottledLoginAttempt(clientMeta.ip, rate.reason).catch((error) => {
                console.warn(`[IPBan] 自动封禁失败: ${error.message}`);
            });
            return res.status(429).json({
                success: false,
                message: `验证尝试过多，请 ${rate.retryAfterSec} 秒后再试`
            });
        }

        const attempt = adminAuth.consumeChallengeAttempt(challenge);
        if (!attempt.ok) {
            return res.status(401).json({
                success: false,
                message: attempt.reason === 'used' ? '登录会话已失效，请重新登录' : '验证尝试过多，请重新输入密码登录'
            });
        }

        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            const telegramSettings = await store.getTelegramConfig();
            const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
            if (!methods.includes(method)) {
                return res.status(400).json({ success: false, message: '不支持的验证方式' });
            }

            let verified = false;
            if (method === 'totp') {
                verified = adminAuth.verifyTotpCode(authConfig.totpSecret, code);
            } else if (method === 'telegram') {
                const tgResult = adminAuth.verifyTelegramLoginCode(challenge.cid, code);
                verified = tgResult.ok;
                if (!verified) {
                    adminAuth.recordLoginFailure(rate.key, rate.entry);
                    await security.logAdminSecurityEvent('2fa_failed', {
                        ...clientMeta,
                        email: challenge.email,
                        detail: `Telegram 验证码错误 (${tgResult.reason || 'invalid'})`
                    });
                    security.fireAdminSecurityNotification('admin_2fa_failed', {
                        email: challenge.email,
                        ip: clientMeta.ip,
                        fingerprint: clientMeta.fingerprint,
                        userAgent: clientMeta.userAgent,
                        method: 'telegram',
                        message: 'Telegram 验证码错误'
                    });
                    return res.status(401).json({
                        success: false,
                        message: tgResult.reason === 'expired' ? '验证码已过期，请重新获取' : 'Telegram 验证码错误'
                    });
                }
            }

            if (!verified) {
                adminAuth.recordLoginFailure(rate.key, rate.entry);
                await security.logAdminSecurityEvent('2fa_failed', {
                    ...clientMeta,
                    email: challenge.email,
                    detail: `${method} 验证码错误`
                });
                security.fireAdminSecurityNotification('admin_2fa_failed', {
                    email: challenge.email,
                    ip: clientMeta.ip,
                    fingerprint: clientMeta.fingerprint,
                    userAgent: clientMeta.userAgent,
                    method,
                    message: '二次验证失败'
                });
                return res.status(401).json({ success: false, message: '验证码错误' });
            }

            adminAuth.clearLoginAttempts(rate.key);
            adminAuth.markChallengeUsed(challenge);
            const { token, payload } = adminAuth.issueAdminToken(authConfig.passwordVersion, authConfig.email);
            await security.logAdminSecurityEvent('login_success', {
                ...clientMeta,
                email: authConfig.email,
                detail: `二次验证成功 (${method})`
            });
            security.fireAdminSecurityNotification('admin_login_success', {
                email: authConfig.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method,
                message: '后台登录成功'
            });

            return res.json(await attachAdminPaths({
                success: true,
                token,
                expiresAt: payload.exp,
                issuedAt: payload.iat,
                permissions: payload.permissions,
                email: authConfig.email
            }));
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ─── Authenticated Session & Security Endpoints ───────────────────────

    protectedAuthRouter.get('/session', async (req, res) => {
        const age = Date.now() - Number(req.admin.iat || 0);
        const shouldRefresh = age >= adminAuth.ADMIN_REFRESH_AFTER_MS;
        let refreshedToken = null;
        let payload = req.admin;

        if (shouldRefresh) {
            const refreshed = adminAuth.issueAdminToken(req.admin.pv, req.admin.email);
            refreshedToken = refreshed.token;
            payload = refreshed.payload;
        }

        return res.json(await attachAdminPaths({
            success: true,
            refreshed: shouldRefresh,
            token: refreshedToken,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            permissions: payload.permissions,
            email: payload.email || ''
        }));
    });

    protectedAuthRouter.get('/security/status', async (req, res) => {
        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            const telegramSettings = await store.getTelegramConfig();
            const paths = await store.getAdminPaths();
            return res.json({
                success: true,
                email: authConfig.email,
                totpEnabled: authConfig.totpEnabled,
                login2faMode: authConfig.login2faMode,
                availableMethods: adminAuth.getAvailable2faMethods(authConfig, telegramSettings),
                methods: adminAuth.resolveLogin2faMethods(authConfig, telegramSettings),
                notifyAdminLogin: authConfig.notifyAdminLogin,
                loginPath: paths.loginPath,
                panelPath: paths.panelPath,
                loginUrl: buildAdminLoginUrl(paths),
                panelUrl: buildAdminPanelUrl(paths)
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/security/2fa-mode', async (req, res) => {
        const mode = String(req.body?.mode || '').trim().toLowerCase();
        try {
            await ensureStoreReady();
            const saved = await store.saveAdmin2faLoginMode(mode);
            return res.json({ success: true, login2faMode: saved, message: '登录验证方式已保存' });
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/security/paths', async (req, res) => {
        try {
            await ensureStoreReady();
            const saved = await store.saveAdminPaths({
                loginPath: req.body?.loginPath,
                panelPath: req.body?.panelPath
            });
            setCachedAdminPaths(saved);
            return res.json({
                success: true,
                loginPath: saved.loginPath,
                panelPath: saved.panelPath,
                loginUrl: buildAdminLoginUrl(saved),
                panelUrl: buildAdminPanelUrl(saved),
                message: '入口路径已更新，请使用新地址访问并收藏'
            });
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/2fa/setup', async (req, res) => {
        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            let secret = String(authConfig.totpSecret || '').trim();
            if (!secret || authConfig.totpEnabled) {
                secret = adminAuth.generateTotpSecret();
                await store.saveAdminTotpConfig({ secret, enabled: false });
            }
            const otpauthUrl = adminAuth.getTotpUri(authConfig.email, secret);
            return res.json({
                success: true,
                secret,
                otpauthUrl,
                qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(otpauthUrl)}`,
                message: '请使用 Google Authenticator 扫码后输入验证码确认启用'
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/2fa/confirm', async (req, res) => {
        const code = String(req.body?.code || '').trim();
        if (!code) {
            return res.status(400).json({ success: false, message: '请输入 Authenticator 验证码' });
        }
        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            if (!authConfig.totpSecret) {
                return res.status(400).json({ success: false, message: '请先发起 2FA 绑定' });
            }
            if (!adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
                return res.status(400).json({ success: false, message: '验证码错误，请重试' });
            }
            await store.saveAdminTotpConfig({ secret: authConfig.totpSecret, enabled: true });
            return res.json({ success: true, message: 'Google Authenticator 已启用' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/2fa/disable', async (req, res) => {
        const currentPassword = String(req.body?.currentPassword || '');
        const code = String(req.body?.code || '').trim();
        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            if (!(await adminAuth.verifyPasswordAsync(currentPassword, authConfig.passwordHash))) {
                return res.status(400).json({ success: false, message: '登录密码错误' });
            }
            if (authConfig.totpEnabled && !adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
                return res.status(400).json({ success: false, message: 'Authenticator 验证码错误' });
            }
            await store.saveAdminTotpConfig({ secret: '', enabled: false });
            return res.json({ success: true, message: 'Google Authenticator 已关闭' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/change-password', async (req, res) => {
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '').trim();

        if (!currentPassword) {
            return res.status(400).json({ success: false, message: '请输入原密码' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: '新密码至少 6 位' });
        }

        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            if (!(await adminAuth.verifyPasswordAsync(currentPassword, authConfig.passwordHash))) {
                return res.status(400).json({ success: false, message: '原密码错误' });
            }
            if (await adminAuth.verifyPasswordAsync(newPassword, authConfig.passwordHash)) {
                return res.status(400).json({ success: false, message: '新密码不能与原密码相同' });
            }

            await store.updateAdminPassword(newPassword);
            await security.logAdminSecurityEvent('password_changed', {
                ...adminAuth.getClientMeta(req),
                email: req.admin?.email || authConfig.email,
                detail: '登录密码已修改'
            });
            return res.json({ success: true, message: '密码修改成功，请重新登录' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.get('/secondary/session', (req, res) => {
        const token = String(req.headers['x-admin-secondary-token'] || '').trim();
        const payload = adminAuth.verifySecondaryToken(token);
        if (!payload) {
            return res.json({ success: true, verified: false });
        }
        return res.json({ success: true, verified: true, expiresAt: payload.exp });
    });

    protectedAuthRouter.post('/verify-secondary', async (req, res) => {
        const password = String(req.body?.password || '');
        const clientMeta = adminAuth.getClientMeta(req);
        if (!password) {
            return res.status(400).json({ success: false, message: '请输入二级密码' });
        }
        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            if (!(await adminAuth.verifyPasswordAsync(password, authConfig.secondaryPasswordHash))) {
                await security.logAdminSecurityEvent('secondary_failed', {
                    ...clientMeta,
                    email: req.admin?.email || authConfig.email,
                    detail: '二级密码错误'
                });
                return res.status(401).json({ success: false, message: '二级密码错误' });
            }
            const { token, payload } = adminAuth.issueSecondaryToken(
                authConfig.secondaryPasswordVersion,
                clientMeta.ip
            );
            await security.logAdminSecurityEvent('secondary_success', {
                ...clientMeta,
                email: req.admin?.email || authConfig.email,
                detail: '敏感模块解锁'
            });
            security.fireAdminSecurityNotification('admin_secondary_success', {
                email: req.admin?.email || authConfig.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                message: '银行卡池/CDK/Session 模块已解锁'
            });
            return res.json({ success: true, secondaryToken: token, expiresAt: payload.exp });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.post('/change-secondary-password', async (req, res) => {
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '').trim();
        if (!currentPassword) {
            return res.status(400).json({ success: false, message: '请输入当前二级密码' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: '新二级密码至少 6 位' });
        }
        try {
            await ensureStoreReady();
            const authConfig = await store.getAdminAuthConfig();
            if (!(await adminAuth.verifyPasswordAsync(currentPassword, authConfig.secondaryPasswordHash))) {
                return res.status(400).json({ success: false, message: '当前二级密码错误' });
            }
            await store.updateAdminSecondaryPassword(newPassword);
            return res.json({ success: true, message: '二级密码已更新，敏感模块需重新验证' });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.get('/login-logs', async (req, res) => {
        try {
            await ensureStoreReady();
            const limit = Number(req.query.limit) || 100;
            const offset = Number(req.query.offset) || 0;
            return res.json({ success: true, ...(await store.listAdminLoginLogs(limit, offset)) });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    protectedAuthRouter.get('/ip-bans', async (req, res) => {
        await ensureStoreReady();
        await security.flushIpBanHits().catch(() => {});
        const rows = await store.listIpBans();
        return res.json({
            success: true,
            bans: rows.map(formatIpBanRow),
            yourIp: security.getClientIp(req),
            trustedIps: security.ipBanState.trustedIps,
            activeCount: security.ipBanState.matcher.size,
            tor: {
                count: security.torExitState.ips.size,
                hits: security.torExitState.hits,
                updatedAt: security.torExitState.updatedAt
                    ? new Date(security.torExitState.updatedAt).toISOString()
                    : null
            }
        });
    });

    protectedAuthRouter.post('/ip-bans', async (req, res) => {
        let rule;
        try {
            rule = ipBan.normalizeBanCidr(req.body?.cidr);
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
        const yourIp = security.getClientIp(req);
        if (ipBan.cidrContainsIp(rule.cidr, yourIp)) {
            return res.status(400).json({ success: false, message: `${rule.cidr} 包含你当前的 IP（${yourIp}），不能封禁` });
        }
        const durationKey = String(req.body?.duration || '7d');
        if (!Object.prototype.hasOwnProperty.call(security.IP_BAN_DURATION_DAYS, durationKey)) {
            return res.status(400).json({ success: false, message: '封禁时长无效' });
        }
        const days = security.IP_BAN_DURATION_DAYS[durationKey];
        await ensureStoreReady();
        await store.saveIpBan({
            cidr: rule.cidr,
            reason: String(req.body?.reason || '').trim() || '手动封禁',
            source: 'manual',
            expiresAt: days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        });
        await security.refreshIpBans();
        return res.json({ success: true, message: `已封禁 ${rule.cidr}`, cidr: rule.cidr });
    });

    protectedAuthRouter.delete('/ip-bans/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, message: '缺少封禁记录编号' });
        }
        await ensureStoreReady();
        const deleted = await store.deleteIpBan(id);
        await security.refreshIpBans();
        return deleted
            ? res.json({ success: true, message: '已解封' })
            : res.status(404).json({ success: false, message: '未找到该封禁记录' });
    });

    return {
        publicAuthRouter,
        protectedAuthRouter
    };
}

module.exports = { createAdminAuthRouters };
