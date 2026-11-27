/* global lucide, authFetch, readJsonResponse, showMessage, showAdminConfirm, escapeHtml, renderStatus,
   copyTextToClipboard, downloadTextFile, renderPagination, paginationState */
/* exported loadSessions, searchSessions, openSessionModal, closeSessionModal,
   copySessionByJobKey, exportSessionByJobKey, copySessionModalContent, exportSessionModalContent,
   clearCancelRenewalPage, submitCancelRenewalPage, submitEnableRenewalPage, cancelAutoRenewByJobKey */
'use strict';

let sessionList = [];
let sessionTotal = 0;
let sessionSearch = '';
let sessionRenewalStatus = {};
let sessionRenewalFetchInFlight = false;
let sessionRenewalJobKeySnapshot = '';
let sessionModalPayload = '';
let sessionModalJobKey = '';

function formatSessionPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.startsWith('{')) {
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch (_) {
            return text;
        }
    }
    return text;
}

async function fetchSessionPayload(jobKey) {
    const res = await authFetch(`/api/admin/sessions/${encodeURIComponent(jobKey)}`);
    const parsed = await readJsonResponse(res);
    if (!parsed.ok) throw new Error(parsed.message);
    const data = parsed.data;
    if (!res.ok || !data.success) throw new Error(data.message || '加载 Session 失败');
    return {
        payload: data.session?.session_payload || '',
        meta: data.session || {}
    };
}

function closeSessionModal() {
    const overlay = document.getElementById('session_modal_overlay');
    const body = document.getElementById('session_modal_body');
    const meta = document.getElementById('session_modal_meta');
    if (overlay) overlay.classList.remove('open');
    if (body) body.textContent = '';
    if (meta) meta.textContent = '';
    sessionModalPayload = '';
    sessionModalJobKey = '';
}

async function openSessionModal(jobKey) {
    if (!jobKey) return;
    const overlay = document.getElementById('session_modal_overlay');
    const body = document.getElementById('session_modal_body');
    const meta = document.getElementById('session_modal_meta');
    if (!overlay || !body) return;
    closeSessionModal();
    overlay.classList.add('open');
    body.textContent = '加载中...';
    if (meta) meta.textContent = `任务: ${jobKey}`;
    try {
        const { payload, meta: sessionMeta } = await fetchSessionPayload(jobKey);
        if (!payload) {
            body.textContent = '该记录未保存完整 Session（仅旧任务有摘要）。请重新提交一次开通以保存完整内容。';
            return;
        }
        sessionModalJobKey = jobKey;
        sessionModalPayload = formatSessionPayload(payload);
        body.textContent = sessionModalPayload;
        if (meta) meta.textContent = `任务: ${jobKey} · CDK: ${sessionMeta.cdk_code || '-'} · ${sessionMeta.time || ''}`;
    } catch (error) {
        body.textContent = `加载失败: ${error.message}`;
    }
}

async function copySessionByJobKey(jobKey) {
    try {
        const { payload } = await fetchSessionPayload(jobKey);
        const formatted = formatSessionPayload(payload);
        if (!formatted) {
            showMessage('该记录没有完整 Session 可复制', 'warning');
            return;
        }
        await copyTextToClipboard(formatted);
        showMessage('Session 已复制到剪贴板', 'success');
    } catch (error) {
        showMessage(error.message || '复制失败', 'error');
    }
}

async function exportSessionByJobKey(jobKey) {
    try {
        const { payload } = await fetchSessionPayload(jobKey);
        const formatted = formatSessionPayload(payload);
        if (!formatted) {
            showMessage('该记录没有完整 Session 可导出', 'warning');
            return;
        }
        downloadTextFile(`session_${jobKey}.json`, formatted);
        showMessage('Session 已导出', 'success');
    } catch (error) {
        showMessage(error.message || '导出失败', 'error');
    }
}

function copySessionModalContent() {
    if (!sessionModalPayload) {
        showMessage('没有可复制的 Session 内容', 'warning');
        return;
    }
    copyTextToClipboard(sessionModalPayload)
        .then(() => showMessage('Session 已复制到剪贴板', 'success'))
        .catch((error) => showMessage(error.message || '复制失败', 'error'));
}

function exportSessionModalContent() {
    if (!sessionModalPayload || !sessionModalJobKey) {
        showMessage('没有可导出的 Session 内容', 'warning');
        return;
    }
    downloadTextFile(`session_${sessionModalJobKey}.json`, sessionModalPayload);
    showMessage('Session 已导出', 'success');
}

function getSessionRenewalJobKeys() {
    return sessionList
        .filter((row) => row.status === 'success' && row.has_session !== false)
        .map((row) => row.job_key)
        .filter(Boolean);
}

function buildSessionRenewalSnapshot(jobKeys = []) {
    return [...jobKeys].sort().join('|');
}

function hasCachedRenewalStatuses(jobKeys = []) {
    return jobKeys.length > 0 && jobKeys.every((jobKey) => {
        const info = sessionRenewalStatus[jobKey];
        return info && typeof info === 'object';
    });
}

function renderAutoRenewCell(row) {
    if (row.status !== 'success' || row.has_session === false) {
        return '<span style="color:var(--text-dim);">—</span>';
    }
    const info = sessionRenewalStatus[row.job_key];
    if (!info) return '<span style="color:var(--text-dim); font-size:12px;">查询中…</span>';
    if (!info.ok) return `<span style="color:var(--error); font-size:12px;" title="${escapeHtml(info.error || '查询失败')}">失败</span>`;
    if (!info.hasActiveSubscription) return '<span style="color:var(--text-dim); font-size:12px;">无订阅</span>';
    if (info.autoRenewRaw === true) return '<span class="status-badge status-success">已开启</span>';
    if (info.autoRenewRaw === false) return '<span class="status-badge status-warning">已关闭</span>';
    return '<span style="color:var(--text-dim);">—</span>';
}

function renderSessionTable() {
    const tbody = document.getElementById('session_body');
    if (!tbody) return;
    if (!sessionList.length) {
        tbody.innerHTML = '<tr class="session-empty-row"><td colspan="8" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无 Session 记录</td></tr>';
        lucide.createIcons();
        return;
    }
    tbody.innerHTML = sessionList.map((row) => {
        const jobKey = escapeHtml(row.job_key || '');
        const preview = escapeHtml(row.token_preview || '-');
        const canView = row.has_session !== false;
        const renewInfo = sessionRenewalStatus[row.job_key];
        const canManageRenew = row.status === 'success' && canView && renewInfo?.ok && renewInfo?.hasActiveSubscription;
        const sessionCell = canView
            ? `<button type="button" class="session-preview-link session-text-preview" data-view-session="${jobKey}" title="点击查看完整 Session">${preview}</button>`
            : `<code class="session-text-preview">${preview}</code>`;
        const cancelRenewBtn = canManageRenew && renewInfo.autoRenewRaw === true
            ? `<button type="button" class="btn btn-danger session-renewal-action" data-cancel-renew="${jobKey}" title="取消自动续费">取消续费</button>`
            : '';
        return `
            <tr class="session-record">
                <td data-label="执行时间"><span class="session-text-preview" title="${escapeHtml(row.time || row.created_at || '-')}">${escapeHtml(row.time || row.created_at || '-')}</span></td>
                <td data-label="激活码"><code class="session-text-preview" title="${escapeHtml(row.cdk_code || '-')}">${escapeHtml(row.cdk_code || '-')}</code></td>
                <td data-label="Session">${sessionCell}</td>
                <td class="session-cell-center" data-label="卡尾号">${escapeHtml(row.card_last4 || '-')}</td>
                <td class="session-cell-message" data-label="任务信息" title="${escapeHtml(row.message || '-')}">${escapeHtml(row.message || '-')}</td>
                <td data-label="状态">${renderStatus(row.status)}</td>
                <td class="session-cell-center" data-label="自动续费">${renderAutoRenewCell(row)}</td>
                <td class="session-cell-actions session-cell-center" data-label="操作">
                    <div class="session-actions">
                        <button type="button" class="btn btn-secondary" data-copy-session="${jobKey}" title="复制 Session">复制</button>
                        <button type="button" class="btn btn-secondary" data-export-session="${jobKey}" title="导出 Session">导出</button>
                        ${cancelRenewBtn}
                        <button type="button" class="btn-delete" title="删除此任务记录" data-delete-task="${jobKey}">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
    }).join('');
    lucide.createIcons();
}

async function refreshSessionRenewalStatuses(force = false) {
    const jobKeys = getSessionRenewalJobKeys();
    if (!jobKeys.length) return;
    const snapshot = buildSessionRenewalSnapshot(jobKeys);
    if (!force && snapshot === sessionRenewalJobKeySnapshot && hasCachedRenewalStatuses(jobKeys)) return;
    if (sessionRenewalFetchInFlight) return;

    sessionRenewalFetchInFlight = true;
    sessionRenewalJobKeySnapshot = snapshot;
    jobKeys.forEach((jobKey) => {
        if (!sessionRenewalStatus[jobKey]) sessionRenewalStatus[jobKey] = null;
    });
    renderSessionTable();

    try {
        const res = await authFetch('/api/admin/subscription/batch-renewal-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_keys: jobKeys,
                timezone_offset_min: -new Date().getTimezoneOffset()
            })
        });
        const parsed = await readJsonResponse(res);
        if (!parsed.ok) throw new Error(parsed.message);
        const payload = parsed.data;
        if (!res.ok || !payload.success) throw new Error(payload.message || '查询自动续费状态失败');
        Object.assign(sessionRenewalStatus, payload.data || {});
        renderSessionTable();
    } catch (error) {
        jobKeys.forEach((jobKey) => {
            sessionRenewalStatus[jobKey] = { ok: false, error: error.message || '查询失败' };
        });
        renderSessionTable();
    } finally {
        sessionRenewalFetchInFlight = false;
    }
}

function searchSessions() {
    sessionSearch = String(document.getElementById('session_search')?.value || '').trim();
    paginationState.session.page = 1;
    loadSessions(false).catch(() => { });
}

async function loadSessions(showToast = false, options = {}) {
    const refreshRenewal = options.refreshRenewal !== false;
    const state = paginationState.session;
    const page = Math.max(1, Number(options.page) || state.page);
    const search = options.search == null ? sessionSearch : String(options.search || '').trim();
    state.page = page;
    const query = new URLSearchParams({
        limit: String(state.pageSize),
        offset: String((page - 1) * state.pageSize),
        ...(search ? { search } : {})
    });
    try {
        const res = await authFetch(`/api/admin/sessions?${query.toString()}`);
        const parsed = await readJsonResponse(res);
        if (!parsed.ok) throw new Error(parsed.message);
        const data = Array.isArray(parsed.data) ? { items: parsed.data, total: parsed.data.length } : (parsed.data || {});
        const nextList = Array.isArray(data.items) ? data.items : [];
        sessionTotal = Math.max(0, Number(data.total) || nextList.length);
        const totalPages = Math.max(1, Math.ceil(sessionTotal / state.pageSize));
        if (state.page > totalPages) {
            state.page = totalPages;
            return loadSessions(showToast, { ...options, page: totalPages, search });
        }
        const oldSnapshot = buildSessionRenewalSnapshot(sessionList.map((row) => row.job_key).filter(Boolean));
        const newSnapshot = buildSessionRenewalSnapshot(nextList.map((row) => row.job_key).filter(Boolean));
        const listChanged = oldSnapshot !== newSnapshot;
        sessionList = nextList;
        if (refreshRenewal && (showToast || listChanged || !hasCachedRenewalStatuses(getSessionRenewalJobKeys()))) {
            sessionRenewalStatus = {};
            sessionRenewalJobKeySnapshot = '';
            renderSessionTable();
            refreshSessionRenewalStatuses(true).catch(() => { });
        } else {
            renderSessionTable();
        }
        renderPagination('session_pagination', 'session', sessionTotal);
        if (showToast) showMessage('Session 列表已刷新', 'success');
    } catch (error) {
        if (showToast) showMessage(error.message || '加载 Session 失败', 'error');
    }
    return undefined;
}

// ─── 续费管理页 ──────────────────────────────────────────────────────────────

function renderCancelRenewalDetail(data = {}) {
    const rows = [
        ['账号', data.email || '—'],
        ['套餐', data.plan || '—'],
        ['订阅渠道', data.subscriptionChannel || '—'],
        ['到期时间', data.expiresAtDisplay || '—'],
        ['自动续费', data.autoRenew || '—']
    ];
    return rows.map(([label, value]) => (
        `<div style="display:flex; justify-content:space-between; gap:16px; padding:9px 0; border-bottom:1px solid var(--divider);">
            <span style="color: var(--text-dim);">${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value))}</strong>
        </div>`
    )).join('');
}

function showCancelRenewalResult(data = {}, message = '') {
    const box = document.getElementById('cancel_renewal_result');
    const statusEl = document.getElementById('cancel_renewal_status');
    const detailEl = document.getElementById('cancel_renewal_detail');
    if (!box || !statusEl || !detailEl) return;
    const already = Boolean(data.alreadyCancelled);
    const cancelled = Boolean(data.cancelled);
    statusEl.textContent = message || data.message || (already ? '自动续费已关闭' : (cancelled ? '已提交取消自动续费' : '操作完成'));
    statusEl.style.color = already || cancelled ? 'var(--success)' : 'var(--text-main)';
    detailEl.innerHTML = renderCancelRenewalDetail(data);
    box.style.display = 'block';
}

function clearCancelRenewalPage() {
    const input = document.getElementById('cancel_renewal_session');
    const hint = document.getElementById('cancel_renewal_hint');
    const box = document.getElementById('cancel_renewal_result');
    if (input) input.value = '';
    if (hint) hint.textContent = '';
    if (box) box.style.display = 'none';
}

async function requestRenewalToggle(endpoint, sessionRaw, fallbackMsg) {
    const res = await authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session: sessionRaw,
            timezone_offset_min: -new Date().getTimezoneOffset()
        })
    });
    const parsed = await readJsonResponse(res);
    if (!parsed.ok) throw new Error(parsed.message);
    const data = parsed.data;
    if (!res.ok || !data.success) throw new Error(data.message || fallbackMsg);
    return data.data || {};
}

async function submitCancelRenewalPage() {
    const input = document.getElementById('cancel_renewal_session');
    const btn = document.getElementById('cancel_renewal_btn');
    const hint = document.getElementById('cancel_renewal_hint');
    const sessionRaw = String(input?.value || '').trim();
    if (!sessionRaw) {
        showMessage('请先粘贴 Session JSON 或 AccessToken', 'warning');
        return;
    }
    if (!(await showAdminConfirm('确认要关闭该账号的自动续费吗？当前计费周期内仍可继续使用。', '取消自动续费'))) return;
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '正在处理，请稍候…';
    const box = document.getElementById('cancel_renewal_result');
    if (box) box.style.display = 'none';
    try {
        const result = await requestRenewalToggle('/api/admin/subscription/cancel-auto-renew', sessionRaw, '取消自动续费失败');
        showCancelRenewalResult(result, result.message || '');
        showMessage(result.message || '操作完成', result.alreadyCancelled || result.cancelled ? 'success' : 'info');
    } catch (error) {
        showMessage(error.message || '取消自动续费失败', 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (hint) hint.textContent = '';
        lucide.createIcons();
    }
}

async function submitEnableRenewalPage() {
    const input = document.getElementById('cancel_renewal_session');
    const btn = document.getElementById('enable_renewal_btn');
    const hint = document.getElementById('cancel_renewal_hint');
    const sessionRaw = String(input?.value || '').trim();
    if (!sessionRaw) {
        showMessage('请先粘贴 Session JSON 或 AccessToken', 'warning');
        return;
    }
    if (!(await showAdminConfirm('确认要开启该账号的自动续费吗？', '开启自动续费'))) return;
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '正在处理，请稍候…';
    const box = document.getElementById('cancel_renewal_result');
    if (box) box.style.display = 'none';
    try {
        const result = await requestRenewalToggle('/api/admin/subscription/enable-auto-renew', sessionRaw, '开启自动续费失败');
        showCancelRenewalResult(result, result.message || '');
        showMessage(result.message || '操作完成', 'success');
    } catch (error) {
        showMessage(error.message || '开启自动续费失败', 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (hint) hint.textContent = '';
        lucide.createIcons();
    }
}

async function cancelAutoRenewByJobKey(jobKey, triggerBtn) {
    if (!jobKey) return;
    if (!(await showAdminConfirm('确认要关闭该 Session 对应账号的自动续费吗？', '取消自动续费'))) return;
    const originalLabel = triggerBtn ? triggerBtn.textContent : '';
    if (triggerBtn) {
        triggerBtn.disabled = true;
        triggerBtn.textContent = '处理中…';
    }
    showMessage('正在取消自动续费，请稍候…', 'warning');
    try {
        const { payload } = await fetchSessionPayload(jobKey);
        const sessionRaw = formatSessionPayload(payload);
        if (!sessionRaw) {
            showMessage('该记录没有完整 Session，无法取消续费', 'warning');
            return;
        }
        const result = await requestRenewalToggle('/api/admin/subscription/cancel-auto-renew', sessionRaw, '取消自动续费失败');
        sessionRenewalStatus[jobKey] = {
            ok: true,
            email: result.email || '',
            autoRenew: result.autoRenew || '—',
            autoRenewRaw: result.autoRenewRaw,
            hasActiveSubscription: Boolean(result.hasActiveSubscription),
            subscriptionChannel: result.subscriptionChannel || ''
        };
        renderSessionTable();
        showMessage(`${result.message || '操作完成'}${result.email ? `（${result.email}）` : ''}`, 'success');
    } catch (error) {
        showMessage(error.message || '取消自动续费失败', 'error');
    } finally {
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = originalLabel || '取消续费';
        }
    }
}
