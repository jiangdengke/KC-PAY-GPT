'use strict';

const http = require('http');
const WebSocket = require('ws');
const { config } = require('./src/config/env');
const { createApp } = require('./src/app');

const { app, store, ensureStoreReady, security, taskHub, orbitcardAutoSync } = createApp();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });

taskHub.attachWebSocketServer(wss, { ensureStoreReady, security });

function handleShutdown(signal) {
    console.log(`[Server] 收到 ${signal}，正在清理并退出...`);
    orbitcardAutoSync.stop();
    security.stopBackgroundTasks();
    security.markCleanShutdown();
    server.close(() => {
        store.closePool().catch(() => {}).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    console.error('[uncaughtException]', error?.stack || error);
    if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') {
        process.exit(1);
    }
    security.alertUnexpectedError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
    security.alertUnexpectedError('unhandledRejection', reason);
});

async function start() {
    await ensureStoreReady();

    try {
        await store.resetAllAssetLocks();
    } catch (error) {
        console.warn(`[Assets] 启动重置锁失败: ${error.message}`);
    }

    setInterval(() => {
        store.releaseStaleAssetLocks().catch((error) => {
            console.warn(`[Assets] 定时释放过期锁失败: ${error.message}`);
        });
    }, 5 * 60 * 1000).unref();

    await security.startBackgroundTasks();
    orbitcardAutoSync.start();

    server.listen(config.port, () => {
        console.log(`🚀 KC-PAY-GPT 服务已启动: http://0.0.0.0:${config.port}`);
    });
}

start().catch((error) => {
    console.error('❌ 服务启动失败:', error);
    process.exit(1);
});
