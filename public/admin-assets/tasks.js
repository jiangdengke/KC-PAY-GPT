/* global lucide, authFetch, readJsonResponse, showMessage, showAdminConfirm, escapeHtml,
   renderStatus, formatPlanLabel, formatTimeShort, shortenJobKey, getPageItems, renderPagination,
   startUptimeTicker, applySystemConfigFromData, updateMaintenanceModeUI, loadCardPoolList, loadCdkList */
/* exported adminDataRefreshPaused, loadData, loadTaskLogs, renderLogTable, deleteAdminTaskLog,
   openTaskLogModal, closeTaskLogModal, loadActivationManualHolds, resolveActivationManualHold,
   updateAdminDataRefreshButton, toggleAdminDataRefresh, startRuntimeLogStream, stopRuntimeLogStream,
   refreshRuntimeLogsManual, clearRuntimeLogs */
'use strict';

const RUNTIME_LOG_TEXT_CAP = 1_200_000;
let runtimeLogPollTimer = null;
let runtimeLogAfter = 0;
let runtimeLogText = '';
let adminDataRefreshPaused = false;
let activationManualHolds = [];

// ─── 运行日志 ───────────────────────────────────────────────────────────────

function formatRuntimeLogTs(ts) {
    try {
        const d = new Date(Number(ts) || 0);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    } catch (_) {
        return '--:--:--';
    }
}

function formatRuntimeLogLine(entry) {
    const sourceLabels = { task: '任务', server: '服务', system: '系统' };
    const src = sourceLabels[entry.source] || String(entry.source || entry.level || '').slice(0, 8);
    const job = entry.jobKey ? String(entry.jobKey).slice(-8) : '—';
    return `${formatRuntimeLogTs(entry.ts)}  ${job}  ${src}  ${entry.text}`;
}

function appendRuntimeLogEntries(entries) {
    if (!entries || entries.length === 0) return;
    runtimeLogText += `${entries.map(formatRuntimeLogLine).join('\n')}\n`;
    if (runtimeLogText.length > RUNTIME_LOG_TEXT_CAP) {
        runtimeLogText = runtimeLogText.slice(-Math.floor(RUNTIME_LOG_TEXT_CAP * 0.85));
    }
    const pre = document.getElementById('runtime_log_pre');
    if (!pre) return;
    pre.textContent = runtimeLogText;
    const autoscroll = document.getElementById('runtime_log_autoscroll');
    const wrap = pre.parentElement;
    if (autoscroll?.checked && wrap) wrap.scrollTop = wrap.scrollHeight;
}

function stopRuntimeLogStream() {
    if (runtimeLogPollTimer) {
        clearInterval(runtimeLogPollTimer);
        runtimeLogPollTimer = null;
    }
}

async function fetchRuntimeLogsTail() {
    const res = await authFetch('/api/admin/runtime-logs?tail=1&limit=1500');
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '加载失败');
    runtimeLogText = (data.entries || []).map(formatRuntimeLogLine).join('\n');
    if (runtimeLogText) runtimeLogText += '\n';
    runtimeLogAfter = Number(data.nextAfter || 0);
    const pre = document.getElementById('runtime_log_pre');
    if (pre) {
        pre.textContent = runtimeLogText;
        const autoscroll = document.getElementById('runtime_log_autoscroll');
        const wrap = pre.parentElement;
        if (autoscroll?.checked && wrap) wrap.scrollTop = wrap.scrollHeight;
    }
}

async function fetchRuntimeLogsIncremental() {
    if (document.getElementById('runtime_log_pause')?.checked) return;
    try {
        const res = await authFetch(`/api/admin/runtime-logs?after=${runtimeLogAfter}&limit=1000`);
        const data = await res.json();
        if (!data.success || !data.entries || data.entries.length === 0) {
            if (data.success && data.nextAfter != null) runtimeLogAfter = Number(data.nextAfter);
            return;
        }
        appendRuntimeLogEntries(data.entries);
        runtimeLogAfter = Number(data.nextAfter || runtimeLogAfter);
    } catch (_) { /* ignore */ }
}

function startRuntimeLogStream() {
    stopRuntimeLogStream();
    fetchRuntimeLogsTail().catch(() => { });
    runtimeLogPollTimer = setInterval(() => { fetchRuntimeLogsIncremental(); }, 2000);
}

async function refreshRuntimeLogsManual() {
    try {
        await fetchRuntimeLogsTail();
        showMessage('运行日志已刷新', 'success');
    } catch (error) {
        showMessage(error.message || '刷新失败', 'error');
    }
    lucide.createIcons();
}

async function clearRuntimeLogs() {
    const ok = await showAdminConfirm('确定清空当前内存中的运行日志？（不影响任务管理数据库表）', '清空运行日志');
    if (!ok) return;
    try {
        const res = await authFetch('/api/admin/runtime-logs/clear', { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '清空失败');
        runtimeLogText = '';
        runtimeLogAfter = 0;
        const pre = document.getElementById('runtime_log_pre');
        if (pre) pre.textContent = '';
        await fetchRuntimeLogsTail();
        showMessage(data.message || '已清空', 'success');
    } catch (error) {
        showMessage(error.message || '清空失败', 'error');
    }
    lucide.createIcons();
}

// ─── 任务详情 Modal ──────────────────────────────────────────────────────────

function closeTaskLogModal() {
    const overlay = document.getElementById('task_log_modal_overlay');
    const body = document.getElementById('task_log_modal_body');
    const meta = document.getElementById('task_log_modal_meta');
    if (overlay) overlay.classList.remove('open');
    if (body) body.textContent = '';
    if (meta) meta.textContent = '';
}

function formatTaskDetailJson(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
        return text;
    }
}

function parseTaskDetailJson(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function getTaskDetailPayload(task) {
    const raw = parseTaskDetailJson(task.gptApiRaw) || {};
    if (raw.data && typeof raw.data === 'object' && !raw.status && !raw.orderId) {
        return { ...raw.data, ...raw };
    }
    return raw;
}

function formatTaskDetailTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
    return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function getTaskDetailProviderMessage(payload, entries) {
    const direct = [
        payload._providerMessage,
        payload.providerMessage,
        payload.message,
        payload.failureMessage,
        payload.failureCode
    ];
    for (const value of direct) {
        const text = String(value || '').trim();
        if (text && !['成功', 'ok', 'success', '请求成功', '操作成功'].includes(text.toLowerCase())) return text;
    }
    const providerEntries = (Array.isArray(entries) ? entries : [])
        .filter((entry) => String(entry.text || '').includes('订单查询第'));
    const latest = providerEntries.length ? String(providerEntries[providerEntries.length - 1].text || '') : '';
    const match = latest.match(/，message=(.+)$/);
    return match ? match[1].trim() : '';
}

function buildTaskTimeline(task, runtimeEntries) {
    const entries = (Array.isArray(runtimeEntries) ? runtimeEntries : [])
        .slice()
        .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const payload = getTaskDetailPayload(task);
    const taskStatus = String(task.status || '').toLowerCase();
    const progress = Number(task.progress || 0);
    const orderId = task.gptApiOrderId || payload.orderId || payload.order_id || '-';
    const providerMessage = getTaskDetailProviderMessage(payload, entries);
    const captcha = parseTaskDetailJson(task.gptApiCaptcha) || payload.captcha;
    const sessionEntry = entries.find((entry) => /Session.*(通过|检查)/i.test(String(entry.text || '')));
    const cardEntry = entries.find((entry) => /(Orbitcard|卡池卡|支付方式)/i.test(String(entry.text || '')));
    const orderEntry = entries.find((entry) => /订单已创建|代充提交|order=/i.test(String(entry.text || '')));
    const queryEntries = entries.filter((entry) => /订单查询第/.test(String(entry.text || '')));
    const queryCount = queryEntries.length;
    const queryStatus = String(payload.status || payload.state || payload.order?.status || '-');
    const lastEntry = entries[entries.length - 1];
    const terminal = ['success', 'failed', 'manual', 'maintenance'].includes(taskStatus);
    const finalState = taskStatus === 'success' ? 'done' : taskStatus === 'failed' || taskStatus === 'maintenance' ? 'failed' : taskStatus === 'manual' ? 'warning' : 'current';
    const finalLabel = taskStatus === 'success' ? '已完成' : taskStatus === 'manual' ? '待人工确认' : taskStatus === 'failed' ? '失败' : taskStatus === 'maintenance' ? '维护中' : '进行中';
    const sessionReady = Boolean(sessionEntry || progress >= 10 || orderId !== '-');
    const paymentReady = Boolean(cardEntry || task.cardLast4 || progress >= 20);
    const orderReady = Boolean(orderId !== '-' || orderEntry);
    const steps = [
        {
            title: '已接收开通请求',
            detail: `CDK ${task.cdk || '-'} · ${task.tokenPreview || '未记录账号摘要'}`,
            state: 'done',
            label: '已完成',
            time: task.createdAt || task.displayTime
        },
        {
            title: 'Session 校验',
            detail: sessionEntry ? String(sessionEntry.text || '').replace(/^.*?通过[：:]?\s*/, '已通过：') : (sessionReady ? '已完成格式与有效期检查' : '等待 Session 检查'),
            state: sessionReady ? 'done' : 'current',
            label: sessionReady ? '已完成' : '处理中',
            time: sessionEntry?.ts
        },
        {
            title: '准备支付方式',
            detail: cardEntry ? String(cardEntry.text || '') : (paymentReady ? `已准备卡片 ····${task.cardLast4 || '-'}` : '等待支付方式准备完成'),
            state: paymentReady ? 'done' : 'current',
            label: paymentReady ? '已完成' : '处理中',
            time: cardEntry?.ts
        },
        {
            title: '创建开通订单',
            detail: orderId !== '-' ? `订单号：${orderId}` : (orderEntry ? String(orderEntry.text || '') : '等待创建订单'),
            state: orderReady ? 'done' : 'current',
            label: orderReady ? '已完成' : '处理中',
            time: orderEntry?.ts
        }
    ];
    if (captcha) {
        const captchaStatus = String(captcha.status || '').toLowerCase();
        const captchaDone = ['submitted', 'passed', 'success'].includes(captchaStatus);
        steps.push({
            title: '人机验证',
            detail: captchaDone ? '验证已提交，上游正在确认' : '上游要求完成人机验证',
            state: captchaDone ? 'done' : 'warning',
            label: captchaDone ? '已提交' : '需要处理',
            time: lastEntry?.ts
        });
    }
    steps.push({
        title: '查询订单状态',
        detail: providerMessage ? `上游 message：${providerMessage}` : `已查询 ${queryCount} 次，最后状态：${queryStatus}`,
        state: terminal ? (taskStatus === 'success' ? 'done' : finalState) : 'current',
        label: queryCount > 0 ? `已查询 ${queryCount} 次` : (terminal ? '已返回' : '等待查询'),
        time: lastEntry?.ts
    });
    steps.push({
        title: taskStatus === 'success' ? '开通成功' : taskStatus === 'failed' || taskStatus === 'manual' ? '本次开通未完成' : '等待最终结果',
        detail: task.message || '任务仍在等待上游返回最终状态',
        state: terminal ? finalState : 'current',
        label: terminal ? finalLabel : `${progress}%`,
        time: task.updatedAt || task.createdAt
    });
    return steps;
}

function formatTaskDetailLog(task, runtimeEntries) {
    const payload = getTaskDetailPayload(task);
    const account = payload.targetEmail || payload.email || payload.accountEmail || '-';
    const plan = payload.planCode || payload.plan_code || '-';
    const status = String(task.status || '').toLowerCase();
    const statusLabel = status === 'success' ? '成功' : status === 'failed' ? '失败' : status === 'manual' ? '待人工确认' : '处理中';
    const steps = buildTaskTimeline(task, runtimeEntries);
    const timeline = steps.map((step) => `
        <div class="task-log-step ${escapeHtml(step.state)}">
            <span class="task-log-step-dot" aria-hidden="true"></span>
            <div>
                <div class="task-log-step-title">${escapeHtml(step.title)}</div>
                <div class="task-log-step-detail">${escapeHtml(step.detail)}${step.time ? ` · ${escapeHtml(formatTaskDetailTime(step.time))}` : ''}</div>
            </div>
            <span class="task-log-step-status">${escapeHtml(step.label)}</span>
        </div>`).join('');
    const entries = Array.isArray(runtimeEntries) ? runtimeEntries : [];
    const upstream = formatTaskDetailJson(task.gptApiRaw);
    const captcha = formatTaskDetailJson(task.gptApiCaptcha);
    const diagnostics = entries.map((entry) => {
        const time = entry.ts ? new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }) : '-';
        return `[${time}] [${entry.level || 'log'}] ${entry.text || ''}`;
    }).join('\n');
    const detailBlocks = [
        upstream ? `<details class="task-log-details"><summary>查看上游原始响应</summary><pre>${escapeHtml(upstream)}</pre></details>` : '',
        captcha ? `<details class="task-log-details"><summary>查看人机验证信息</summary><pre>${escapeHtml(captcha)}</pre></details>` : '',
        diagnostics ? `<details class="task-log-details"><summary>查看技术诊断日志（${entries.length} 条）</summary><pre>${escapeHtml(diagnostics)}</pre></details>` : ''
    ].filter(Boolean).join('');
    return `
        <div class="task-log-summary">
            <div class="task-log-summary-card"><span class="task-log-summary-label">账号</span><span class="task-log-summary-value" title="${escapeHtml(account)}">${escapeHtml(account)}</span></div>
            <div class="task-log-summary-card"><span class="task-log-summary-label">套餐</span><span class="task-log-summary-value">${escapeHtml(plan)}</span></div>
            <div class="task-log-summary-card"><span class="task-log-summary-label">状态</span><span class="task-log-summary-value">${escapeHtml(statusLabel)} · ${escapeHtml(String(task.progress || 0))}%</span></div>
            <div class="task-log-summary-card"><span class="task-log-summary-label">订单号</span><span class="task-log-summary-value" title="${escapeHtml(task.gptApiOrderId || payload.orderId || '-')}" >${escapeHtml(task.gptApiOrderId || payload.orderId || '-')}</span></div>
        </div>
        <div class="task-log-timeline">${timeline}</div>
        ${detailBlocks || '<p style="margin:0; color:var(--text-dim);">暂无额外诊断信息</p>'}`;
}

async function openTaskLogModal(jobKey) {
    const key = String(jobKey || '').trim();
    if (!key) return;
    const overlay = document.getElementById('task_log_modal_overlay');
    const body = document.getElementById('task_log_modal_body');
    const meta = document.getElementById('task_log_modal_meta');
    if (!overlay || !body) return;
    closeTaskLogModal();
    overlay.classList.add('open');
    body.innerHTML = '<p style="margin:0; color:var(--text-dim);">加载中...</p>';
    if (meta) meta.textContent = `任务: ${key}`;
    try {
        const res = await authFetch(`/api/admin/task-logs/${encodeURIComponent(key)}`);
        const parsed = await readJsonResponse(res);
        if (!parsed.ok) throw new Error(parsed.message);
        if (!res.ok || !parsed.data.success) throw new Error(parsed.data.message || '加载日志失败');
        const task = parsed.data.task || {};
        if (meta) meta.textContent = `${task.jobKey || key} · ${task.status || '-'} · ${task.progress || 0}%`;
        body.innerHTML = formatTaskDetailLog(task, parsed.data.runtimeEntries);
    } catch (error) {
        body.innerHTML = `<p style="margin:0; color:var(--error);">${escapeHtml(error.message || '加载日志失败')}</p>`;
    }
}

// ─── 任务表 & 人工确认 & 概览刷新 ────────────────────────────────────────────

function renderActivationManualHolds() {
    const tbody = document.getElementById('activation_manual_hold_body');
    if (!tbody) return;
    if (!activationManualHolds.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:28px 0;">暂无待人工确认记录</td></tr>';
        return;
    }
    tbody.innerHTML = activationManualHolds.map((hold) => `
        <tr>
            <td>${escapeHtml(hold.accountEmail || '账号未返回')}</td>
            <td>${escapeHtml(formatPlanLabel(hold.planType))}</td>
            <td><code title="${escapeHtml(hold.failedJobKey || '')}">${escapeHtml(shortenJobKey(hold.failedJobKey || '-'))}</code></td>
            <td><code>${escapeHtml(hold.cdkCode || '-')}</code></td>
            <td style="max-width:320px; white-space:normal;">${escapeHtml(hold.reason || '-')}</td>
            <td>${escapeHtml(formatTimeShort(hold.createdAt))}</td>
            <td style="text-align:center;"><button type="button" class="btn btn-success" style="padding:5px 9px; font-size:12px;" onclick="resolveActivationManualHold(${Number(hold.id)})">解除</button></td>
        </tr>`).join('');
    lucide.createIcons();
}

function updateActivationManualHoldCount() {
    const countEl = document.getElementById('manual_hold_count');
    if (!countEl) return;
    const count = activationManualHolds.length;
    countEl.textContent = `待人工确认 ${count}`;
    countEl.style.display = count > 0 ? 'inline-flex' : 'none';
}

async function loadActivationManualHolds(showToast = false) {
    const tbody = document.getElementById('activation_manual_hold_body');
    if (!tbody) return;
    try {
        const res = await authFetch('/api/admin/activation-manual-holds?limit=200');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '加载人工审核记录失败');
        activationManualHolds = Array.isArray(data.holds) ? data.holds : [];
        renderActivationManualHolds();
        updateActivationManualHoldCount();
        if (showToast) showMessage('人工审核记录已刷新', 'success');
    } catch (error) {
        if (!activationManualHolds.length) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--error); padding:28px 0;">${escapeHtml(error.message || '加载失败')}</td></tr>`;
        }
        if (showToast) showMessage(error.message || '加载人工审核记录失败', 'error');
    }
    lucide.createIcons();
}

async function resolveActivationManualHold(id) {
    const hold = activationManualHolds.find((item) => Number(item.id) === Number(id));
    const account = hold?.accountEmail || '未知账号';
    const plan = formatPlanLabel(hold?.planType);
    const cdk = hold?.cdkCode || '该卡密';
    const ok = await showAdminConfirm(`确认已处理 ${cdk}（${account} / ${plan}）的失败任务，并允许该卡密重新提交吗？`, '解除人工审核');
    if (!ok) return;
    try {
        const res = await authFetch(`/api/admin/activation-manual-holds/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '解除失败');
        showMessage(data.message || '人工审核已解除', 'success');
        await loadActivationManualHolds(false);
    } catch (error) {
        showMessage(error.message || '解除人工审核失败', 'error');
    }
}

function renderLogTable(logs) {
    const tbody = document.getElementById('log_body');
    if (!tbody) return;
    const pageData = getPageItems(logs, 'log');
    if (!pageData.items.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-dim); padding: 36px 0;">暂无任务记录</td></tr>';
        renderPagination('log_pagination', 'log', 0);
        return;
    }
    tbody.innerHTML = pageData.items.map((l) => `
        <tr>
            <td>${escapeHtml(l.time || '-')}</td>
            <td><code>${escapeHtml(l.cdk || '-')}</code></td>
            <td><code>${escapeHtml(l.token || '-')}</code></td>
            <td>${l.message ? escapeHtml(l.message) : '-'}</td>
            <td>
                <div style="font-size: 12px; margin-bottom: 2px;">${l.progress}%</div>
                <div class="progress-mini-track">
                    <div class="progress-mini-bar ${escapeHtml(l.status)}" style="width: ${Number(l.progress || 0)}%"></div>
                </div>
            </td>
            <td>${renderStatus(l.status)}</td>
            <td style="text-align:center">
                <div class="table-action-group">
                    <button type="button" class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" title="查看充值详细日志" data-view-task-log="${escapeHtml(l.id)}"><i data-lucide="scroll-text"></i> 日志</button>
                    <button type="button" class="btn-delete" title="删除此任务记录" data-delete-task="${escapeHtml(l.id)}"><i data-lucide="trash-2"></i></button>
                </div>
            </td>
        </tr>`).join('');
    renderPagination('log_pagination', 'log', pageData.total);
    lucide.createIcons();
}

async function loadTaskLogs(showToast = false) {
    try {
        const res = await authFetch('/api/admin/task-logs');
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `加载任务失败（${res.status}）`);
        window.__adminLogs = Array.isArray(data.tasks) ? data.tasks : [];
        renderLogTable(window.__adminLogs);
        if (showToast) showMessage('任务列表已刷新', 'success');
    } catch (error) {
        console.error('loadTaskLogs failed', error);
        if (showToast) showMessage(error.message || '加载任务失败', 'error');
    }
    lucide.createIcons();
}

async function deleteAdminTaskLog(jobKey) {
    const key = String(jobKey || '').trim();
    if (!key) return;
    const ok = await showAdminConfirm(`确定删除任务记录「${key}」？`, '删除任务');
    if (!ok) return;
    try {
        const res = await authFetch(`/api/admin/task-logs/${encodeURIComponent(key)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `删除失败（${res.status}）`);
        showMessage(data.message || '任务记录已删除', 'success');
        await loadData();
    } catch (e) {
        showMessage(e.message || '删除失败', 'error');
    }
    lucide.createIcons();
}

function updateAdminDataRefreshButton() {
    const btn = document.getElementById('admin_refresh_pause_btn');
    const label = document.getElementById('admin_refresh_pause_label');
    if (!btn || !label) return;
    const paused = adminDataRefreshPaused;
    label.textContent = paused ? '恢复自动刷新' : '停止自动刷新';
    const icon = btn.querySelector('i[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', paused ? 'play' : 'pause');
    btn.classList.toggle('btn-success', !paused);
    btn.classList.toggle('btn-secondary', paused);
    lucide.createIcons();
}

function toggleAdminDataRefresh() {
    adminDataRefreshPaused = !adminDataRefreshPaused;
    updateAdminDataRefreshButton();
    showMessage(
        adminDataRefreshPaused ? '已停止自动刷新：概览与任务列表不再每 3 秒更新' : '已恢复每 3 秒自动刷新',
        'success'
    );
}

async function loadData(isInitial = false) {
    try {
        const res = await authFetch('/api/admin/data');
        const data = await res.json();
        document.getElementById('stat_cpu_percent').innerText = `${Number(data.runtime?.system?.cpu?.percent || 0)}%`;
        document.getElementById('stat_cpu_meta').innerText = data.runtime?.system?.cpu?.text || '实时 CPU 使用率';
        document.getElementById('stat_memory_percent').innerText = `${Number(data.runtime?.system?.memory?.percent || 0)}%`;
        document.getElementById('stat_memory_meta').innerText = data.runtime?.system?.memory?.text || '0.0G/0.0G';
        document.getElementById('stat_disk_percent').innerText = `${Number(data.runtime?.system?.disk?.percent || 0)}%`;
        document.getElementById('stat_disk_meta').innerText = `${data.runtime?.system?.disk?.usedText || '0.0G'}/${data.runtime?.system?.disk?.totalText || '0.0G'}${data.runtime?.system?.disk?.drive ? ` (${data.runtime.system.disk.drive})` : ''}`;
        document.getElementById('stat_uptime_meta').innerText = '服务持续运行时间';
        startUptimeTicker(data.runtime?.system?.uptime?.seconds || 0);
        document.getElementById('stat_total').innerText = data.stats.total;
        document.getElementById('stat_success').innerText = data.stats.success;
        document.getElementById('stat_failed').innerText = data.stats.failed;
        document.getElementById('stat_cdk_total').innerText = data.stats.cdk_total || 0;
        document.getElementById('stat_cdk_used').innerText = data.stats.cdk_used || 0;
        document.getElementById('stat_cdk_unused').innerText = data.stats.cdk_unused || 0;
        const orbitcardEl = document.getElementById('stat_orbitcard_reusable');
        if (orbitcardEl) orbitcardEl.innerText = data.stats.orbitcard_reusable || 0;
        document.getElementById('stat_card_total').innerText = (data.config.card_pool || []).length;
        document.getElementById('stat_foreground_slots').innerText = `${Number(data.runtime?.active_foreground_jobs || 0)}/${Number(data.config.max_concurrent_activations || 1)}`;
        document.getElementById('stat_foreground_slots_meta').innerText = '前台占用/最大前台并发';

        if (isInitial) {
            applySystemConfigFromData(data);
            loadCardPoolList();
        }

        window.__adminRuntime = data.runtime || { active_activation_jobs: 0 };
        if (!isInitial) {
            updateMaintenanceModeUI(data.config, window.__adminRuntime);
        }

        window.__adminLogs = data.logs || [];
        renderLogTable(window.__adminLogs);
        activationManualHolds = Array.isArray(data.manual_holds) ? data.manual_holds : [];
        renderActivationManualHolds();
        updateActivationManualHoldCount();

        try {
            await loadCdkList();
        } catch (cdkError) {
            console.error('Failed to load CDK list in loadData', cdkError);
        }

        lucide.createIcons();
    } catch (error) {
        console.error('Failed to load data', error);
    }
}
