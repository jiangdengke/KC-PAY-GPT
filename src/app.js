'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { config } = require('./config/env');
const defaultStore = require('./db');
const { buildAdminLoginUrl } = require('./security/admin-paths');
const { createSecurityManager } = require('./security/security-manager');
const { forwardAsyncErrors } = require('./middleware/async-handler');
const {
    createSafeJsonMiddleware,
    createQueryParser,
    securityHeadersMiddleware
} = require('./middleware/security-headers');
const { createAdminGuards } = require('./middleware/admin-guard');
const { createTaskHub } = require('./services/task-hub');
const { createGptApiWorker } = require('./services/gpt-api-worker');
const { createOrbitcardAutoSync } = require('./services/orbitcard-sync');
const { createPublicRouter } = require('./routes/public');
const { createExternalRouter } = require('./routes/external');
const { createAdminAuthRouters } = require('./routes/admin-auth');
const { createAdminGptApiRouter } = require('./routes/admin-gpt-api');
const { createAdminAssetsRouter } = require('./routes/admin-assets');
const { createAdminTasksRouter } = require('./routes/admin-tasks');
const { createAdminSubscriptionRouter } = require('./routes/admin-subscription');

const BLOCKED_DIRECT_ADMIN_FILES = new Set([
    '/admin.html',
    '/admin-login.html',
    '/admin.js',
    '/admin.css'
]);

function escapeHtmlAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function createApp({
    store = defaultStore,
    publicDir = config.publicDir,
    adminAssetsDir = config.adminAssetsDir,
    dataDir = config.dataDir,
    cfAccessConfig = config.cfAccess
} = {}) {
    const app = forwardAsyncErrors(express());
    app.disable('x-powered-by');
    app.set('query parser', createQueryParser());

    let storeReadyPromise = null;
    function ensureStoreReady() {
        if (!storeReadyPromise) {
            storeReadyPromise = store.ensureReady().catch((error) => {
                storeReadyPromise = null;
                throw error;
            });
        }
        return storeReadyPromise;
    }

    let cachedAdminPaths = null;
    async function getCachedAdminPaths() {
        if (!cachedAdminPaths) {
            await ensureStoreReady();
            cachedAdminPaths = await store.getAdminPaths();
        }
        return cachedAdminPaths;
    }
    function setCachedAdminPaths(paths) {
        cachedAdminPaths = paths;
    }

    const security = createSecurityManager({ store, ensureStoreReady, dataDir });
    const taskHub = createTaskHub({ store });
    const orbitcardAutoSync = createOrbitcardAutoSync({
        store,
        ensureStoreReady,
        intervalMs: config.defaults.orbitcardAutoSyncIntervalMs
    });
    const guards = createAdminGuards({ store, ensureStoreReady, security, cfAccessConfig });

    const runGptApiWorker = createGptApiWorker({
        store,
        activeTaskCaptchas: taskHub.activeTaskCaptchas,
        broadcastToTask: taskHub.broadcastToTask,
        notifyTaskOutcome: ({ event, email, planType, cdk, jobKey, message, diagnostic }) => {
            security.fireTelegramNotification(event, { email, planType, cdk, jobKey, message, diagnostic });
        },
        logTask: taskHub.logTask,
        releaseForegroundSlot: taskHub.releaseForegroundSlot,
        getTotalActiveJobs: taskHub.getTotalActiveJobs
    });

    app.use(securityHeadersMiddleware);
    app.use(createSafeJsonMiddleware(config.jsonBodyLimit));
    app.use(security.ipBanMiddleware);

    // Block direct access to admin HTML/JS/CSS or raw admin-assets folder via static middleware
    app.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
            const p = req.path;
            if (BLOCKED_DIRECT_ADMIN_FILES.has(p) || p === '/admin-assets' || p.startsWith('/admin-assets/')) {
                return res.status(404).type('text/plain').send('Not Found');
            }
        }
        return next();
    });

    // Protected admin static assets (CSS + modular JS) behind Cloudflare Access
    app.use(
        '/admin/assets',
        guards.requireCfAccess,
        (req, res, next) => {
            res.setHeader('Cache-Control', 'private, no-store');
            next();
        },
        express.static(adminAssetsDir, { index: false, dotfiles: 'ignore' })
    );

    // Dynamic admin login / panel pages
    app.use(async (req, res, next) => {
        if (req.method !== 'GET') {
            return next();
        }
        const normalizedPath = req.path.replace(/^\/+|\/+$/g, '').toLowerCase();
        if (!normalizedPath) {
            return next();
        }
        try {
            const paths = await getCachedAdminPaths();
            if (normalizedPath === paths.loginPath) {
                return guards.requireCfAccess(req, res, () => {
                    res.setHeader('Cache-Control', 'private, no-store');
                    return res.sendFile(path.join(publicDir, 'admin-login.html'));
                });
            }
            if (normalizedPath === paths.panelPath) {
                return guards.requireCfAccess(req, res, () => {
                    try {
                        const rawHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
                        const loginMeta = `<meta name="admin-login-path" content="${escapeHtmlAttr(buildAdminLoginUrl(paths))}">`;
                        const html = rawHtml.includes('<!--__ADMIN_META__-->')
                            ? rawHtml.replace('<!--__ADMIN_META__-->', loginMeta)
                            : rawHtml.replace('</head>', `    ${loginMeta}\n</head>`);
                        res.setHeader('Cache-Control', 'private, no-store');
                        return res.type('text/html; charset=utf-8').send(html);
                    } catch (err) {
                        return next(err);
                    }
                });
            }
            return next();
        } catch (error) {
            return next(error);
        }
    });

    app.use(express.static(publicDir, { dotfiles: 'ignore' }));

    // External webhook (X-API-Key)
    app.use('/api/external', createExternalRouter({ store, ensureStoreReady, security }));

    // Public customer routes
    const { router: publicRouter, handleActivationRequest } = createPublicRouter({
        store,
        ensureStoreReady,
        security,
        taskHub,
        runGptApiWorker,
        publicDir
    });
    app.use(publicRouter);

    // Admin API: all /api/admin/* require Cloudflare Access (if configured)
    app.use('/api/admin', guards.requireCfAccess);

    const { publicAuthRouter, protectedAuthRouter } = createAdminAuthRouters({
        store,
        ensureStoreReady,
        security,
        getCachedAdminPaths,
        setCachedAdminPaths
    });
    app.use('/api/admin', publicAuthRouter);

    // Everything below requires valid admin JWT
    app.use('/api/admin', guards.authenticateAdmin);
    app.use('/api/admin', protectedAuthRouter);
    app.use('/api/admin', createAdminGptApiRouter({
        store,
        ensureStoreReady,
        taskHub,
        requireSecondaryAuth: guards.requireSecondaryAuth,
        orbitcardAutoSync
    }));
    app.use('/api/admin', createAdminAssetsRouter({
        store,
        ensureStoreReady,
        requireSecondaryAuth: guards.requireSecondaryAuth
    }));
    app.use('/api/admin', createAdminTasksRouter({
        store,
        ensureStoreReady,
        taskHub,
        requireSecondaryAuth: guards.requireSecondaryAuth,
        handleActivationRequest
    }));
    app.use('/api/admin', createAdminSubscriptionRouter({ store, ensureStoreReady }));

    // Unified error handler (never leaks internal stack traces)
    app.use((error, req, res, next) => {
        if (res.headersSent) {
            return next(error);
        }
        const status = Number(error?.status || error?.statusCode) || 500;
        if (status >= 500) {
            console.error(`[HTTP ${req.method} ${req.path}]`, error?.stack || error);
            security.alertUnexpectedError(`${req.method} ${req.path}`, error);
        }
        return res.status(status >= 400 && status < 600 ? status : 500).json({
            success: false,
            message: status >= 500 ? '服务器内部错误，请稍后再试' : '请求格式错误'
        });
    });

    return {
        app,
        store,
        ensureStoreReady,
        security,
        taskHub,
        orbitcardAutoSync
    };
}

module.exports = { createApp };
