'use strict';

const WebSocket = require('ws');
const adminAuth = require('../security/admin-auth');
const runtimeLog = require('../utils/runtime-log');
const { sanitizeCustomerTaskMessage } = require('../utils/task-messages');

const TERMINAL_TASK_STATUSES = new Set(['success', 'failed', 'card_invalid', 'manual', 'maintenance']);

function createTaskHub({ store }) {
    const taskClients = new Map();
    const activeForegroundJobs = new Set();
    const activeTaskCaptchas = new Map();

    function getActiveForegroundJobsCount() {
        return activeForegroundJobs.size;
    }

    function getTotalActiveJobs() {
        return activeForegroundJobs.size;
    }

    function reserveForegroundSlot(jobKey) {
        activeForegroundJobs.add(jobKey);
    }

    function releaseForegroundSlot(jobKey) {
        activeForegroundJobs.delete(jobKey);
    }

    function subscribeTaskClient(jobKey, ws) {
        if (!taskClients.has(jobKey)) {
            taskClients.set(jobKey, new Set());
        }
        taskClients.get(jobKey).add(ws);
    }

    function unsubscribeTaskClient(jobKey, ws) {
        if (!jobKey || !taskClients.has(jobKey)) {
            return;
        }
        const clients = taskClients.get(jobKey);
        clients.delete(ws);
        if (clients.size === 0) {
            taskClients.delete(jobKey);
        }
    }

    function broadcastToTask(jobKey, data) {
        const clients = taskClients.get(jobKey);
        if (!clients) {
            return;
        }
        const message = JSON.stringify(data);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }

    async function sendTaskSnapshot(ws, jobKey) {
        const task = await store.getTaskStatus(jobKey);
        if (!task || ws.readyState !== WebSocket.OPEN) {
            return;
        }

        let captcha = activeTaskCaptchas.get(jobKey) || null;
        if (!captcha && task.gpt_api_captcha) {
            try {
                const parsed = JSON.parse(task.gpt_api_captcha);
                captcha = parsed && typeof parsed === 'object' ? parsed : null;
            } catch (_) { /* ignore malformed transient metadata */ }
        }

        ws.send(JSON.stringify({
            type: 'snapshot',
            jobKey,
            status: task.status,
            message: sanitizeCustomerTaskMessage(task.message),
            progress: Number(task.progress || 0),
            cdkCode: task.cdk_code || null,
            phone: task.phone || null,
            cardLast4: task.card_last4 || null,
            captcha,
            screenshots: [],
            videos: [],
            isTerminal: TERMINAL_TASK_STATUSES.has(task.status)
        }));
    }

    function logTask(jobKey, message, level = 'log') {
        runtimeLog.push({
            jobKey,
            level,
            source: 'task',
            text: String(message || '')
        });
        const logger = console[level] || console.log;
        logger(`[Task ${jobKey}] ${message}`);
    }

    function attachWebSocketServer(wss, { ensureStoreReady, security } = {}) {
        wss.on('connection', (ws, req) => {
            let subscribedJobKey = null;

            ws.on('error', (error) => {
                console.warn(`[WS] 连接异常: ${error?.message || error}`);
            });

            if (security?.isIpBlocked?.(req)) {
                ws.close(1008, 'Forbidden');
                return;
            }

            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message.toString(), adminAuth.safeJsonReviver);
                    if (data?.type === 'subscribe' && typeof data.jobKey === 'string') {
                        const nextJobKey = data.jobKey.trim();
                        if (!nextJobKey || nextJobKey.length > 128) return;
                        if (subscribedJobKey && subscribedJobKey !== nextJobKey) {
                            unsubscribeTaskClient(subscribedJobKey, ws);
                        }
                        subscribedJobKey = nextJobKey;
                        subscribeTaskClient(nextJobKey, ws);
                        await ensureStoreReady();
                        await sendTaskSnapshot(ws, nextJobKey);
                    }
                } catch (_) {
                    // ignore malformed client messages
                }
            });

            ws.on('close', () => {
                if (subscribedJobKey) {
                    unsubscribeTaskClient(subscribedJobKey, ws);
                }
            });
        });
    }

    return {
        TERMINAL_TASK_STATUSES,
        activeTaskCaptchas,
        getActiveForegroundJobsCount,
        getTotalActiveJobs,
        reserveForegroundSlot,
        releaseForegroundSlot,
        broadcastToTask,
        sendTaskSnapshot,
        logTask,
        attachWebSocketServer
    };
}

module.exports = {
    TERMINAL_TASK_STATUSES,
    createTaskHub
};
