/* global lucide, setFilter */
/* exported TOKEN_KEY, BUSINESS_PAGES, ADMIN_LOGIN_EVENT_LABELS, CANONICAL_PLAN_TYPES, PLAN_LABELS,
   adminLoginPath, setAdminLoginPath, paginationState, selectedItems, tableFilters, tableSearch,
   formatPlanLabel, getPlanColors, getAdminToken, setAdminToken, clearAdminToken,
   redirectToLogin, logoutAdmin, authFetch, readJsonResponse, readApiJson, escapeHtml,
   formatDurationText, formatTimeShort, startUptimeTicker, renderStatus, showMessage,
   showAdminConfirm, closeAdminConfirm, copyText, copyTextToClipboard, downloadTextFile,
   getPageItems, getPaginationItems, renderPagination, closeFilterMenus, toggleFilterMenu,
   selectFilter, toggleSelection, pruneSelection, shortenJobKey, ensureAdminSession */
'use strict';

const TOKEN_KEY = 'plus_admin_token';
let adminLoginPath = document.querySelector('meta[name="admin-login-path"]')?.getAttribute('content') || '/admin-login';
const BUSINESS_PAGES = new Set(['cards', 'cdks', 'sessions']);
const ADMIN_LOGIN_EVENT_LABELS = {
    login_success: '登录成功',
    login_failed: '登录失败',
    '2fa_failed': '二次验证失败',
    password_changed: '修改密码',
    logout: '退出登录'
};
const statusMap = {
    success: { class: 'status-success', label: 'SUCCESS' },
    failed: { class: 'status-failed', label: 'FAILED' },
    running: { class: 'status-running', label: 'RUNNING' },
    manual: { class: 'status-warning', label: '需人工' },
    card_invalid: { class: 'status-warning', label: 'CARD_INVALID' }
};
const CANONICAL_PLAN_TYPES = Object.freeze(['plus', 'pro100', 'pro200', 'pro500']);
const PLAN_LABELS = Object.freeze({
    plus: 'Plus',
    pro100: 'Pro 100',
    pro200: 'Pro 200',
    pro500: 'Pro 500',
    pro_5x: 'Pro 5x（历史）',
    pro_20x: 'Pro 20x（历史）'
});
const PLAN_COLORS = Object.freeze({
    plus: ['#2563eb', 'rgba(37, 99, 235, 0.12)'],
    pro100: ['#7c3aed', 'rgba(124, 58, 237, 0.12)'],
    pro200: ['#c026d3', 'rgba(192, 38, 211, 0.12)'],
    pro500: ['#db2777', 'rgba(219, 39, 119, 0.12)'],
    pro_5x: ['#8b5cf6', 'rgba(139, 92, 246, 0.12)'],
    pro_20x: ['#ec4899', 'rgba(236, 72, 153, 0.12)']
});

const selectedItems = {
    cdk: new Set()
};
const tableFilters = {
    cdk: 'all'
};
const tableSearch = {
    cdk: ''
};
const paginationState = {
    cdk: { page: 1, pageSize: 12 },
    log: { page: 1, pageSize: 12 },
    session: { page: 1, pageSize: 12 }
};

let adminRefreshTimer = null;
let uptimeTickTimer = null;
let uptimeBaseSeconds = 0;
let uptimeBaseAt = 0;
let adminConfirmResolver = null;

window.__adminLogs = [];
window.__adminRuntime = { active_activation_jobs: 0 };

function formatPlanLabel(planType) {
    const key = String(planType || '').trim().toLowerCase();
    return PLAN_LABELS[key] || (key ? `未知套餐 (${key})` : '未识别');
}

function getPlanColors(planType) {
    return PLAN_COLORS[String(planType || '').trim().toLowerCase()] || ['#64748b', 'rgba(100, 116, 139, 0.12)'];
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getAdminToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function setAdminToken(token) {
    if (token) {
        localStorage.setItem(TOKEN_KEY, token);
    }
}

function clearAdminToken() {
    localStorage.removeItem(TOKEN_KEY);
}

function setAdminLoginPath(url) {
    if (url) {
        adminLoginPath = url;
    }
}

function redirectToLogin() {
    clearAdminToken();
    location.href = adminLoginPath;
}

function logoutAdmin() {
    redirectToLogin();
}

async function authFetch(url, options = {}) {
    const token = getAdminToken();
    if (!token) {
        redirectToLogin();
        throw new Error('未登录');
    }

    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
    let response;
    try {
        response = await fetch(url, { ...options, headers });
    } catch (_) {
        throw new Error('网络错误或 Cloudflare 验证已过期，请刷新页面');
    }
    if (response.status === 401) {
        redirectToLogin();
        throw new Error('登录已失效');
    }
    return response;
}

async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) {
        return { ok: false, message: `服务器返回空响应 (${response.status})` };
    }
    try {
        return { ok: true, data: JSON.parse(text) };
    } catch (_) {
        const snippet = text.replace(/\s+/g, ' ').slice(0, 120);
        if (response.status === 404) {
            return { ok: false, message: '接口不存在 (404)，请确认服务已重启并更新到最新版本' };
        }
        return {
            ok: false,
            message: `服务器响应异常 (${response.status})${snippet ? `：${snippet}` : ''}`
        };
    }
}

async function readApiJson(response, fallbackMessage) {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (!contentType.includes('application/json')) {
        const preview = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        throw new Error(`${fallbackMessage}：服务器返回 HTML，请重新启动应用服务后再试${preview ? `（${preview}）` : ''}`);
    }
    try {
        return JSON.parse(text);
    } catch (_) {
        throw new Error(`${fallbackMessage}：服务器返回了无法解析的 JSON`);
    }
}

function scheduleSessionRefresh(expiresAt) {
    if (adminRefreshTimer) {
        clearTimeout(adminRefreshTimer);
    }
    const fallbackDelay = 55 * 60 * 1000;
    const delay = Math.max(60 * 1000, Math.min(fallbackDelay, Number(expiresAt || 0) - Date.now() - (5 * 60 * 1000)));
    adminRefreshTimer = setTimeout(() => {
        ensureAdminSession().catch(() => { });
    }, delay);
}

async function ensureAdminSession() {
    const response = await authFetch('/api/admin/session');
    const data = await response.json();
    if (data.refreshed && data.token) {
        setAdminToken(data.token);
    }
    if (data.loginUrl) {
        adminLoginPath = data.loginUrl;
    }
    scheduleSessionRefresh(data.expiresAt);
    return data;
}

function formatDurationText(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainSeconds = seconds % 60;
    if (days > 0) return `${days}天 ${hours}时 ${minutes}分`;
    if (hours > 0) return `${hours}时 ${minutes}分 ${remainSeconds}秒`;
    if (minutes > 0) return `${minutes}分 ${remainSeconds}秒`;
    return `${remainSeconds}秒`;
}

function formatTimeShort(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '-';
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(d);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function getCurrentUptimeSeconds() {
    if (!uptimeBaseAt) return 0;
    return uptimeBaseSeconds + Math.max(0, Math.floor((Date.now() - uptimeBaseAt) / 1000));
}

function renderUptimeTick() {
    const el = document.getElementById('stat_uptime_text');
    if (el) {
        el.innerText = formatDurationText(getCurrentUptimeSeconds());
    }
}

function startUptimeTicker(baseSeconds) {
    const nextBaseSeconds = Math.max(0, Math.floor(Number(baseSeconds) || 0));
    if (uptimeBaseAt && nextBaseSeconds <= getCurrentUptimeSeconds()) {
        return;
    }
    uptimeBaseSeconds = nextBaseSeconds;
    uptimeBaseAt = Date.now();
    renderUptimeTick();
    if (uptimeTickTimer) {
        clearInterval(uptimeTickTimer);
    }
    uptimeTickTimer = setInterval(renderUptimeTick, 1000);
}

function renderStatus(status) {
    const cfg = statusMap[status] || { class: '', label: String(status || '').toUpperCase() };
    return `<span class="status-badge ${cfg.class}">${cfg.label || String(status || '').toUpperCase()}</span>`;
}

function showMessage(content, type = 'success') {
    const container = document.getElementById('message_container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = `message-item message-${type}`;
    const iconMap = { success: 'check-circle-2', error: 'x-circle', warning: 'alert-triangle' };
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', iconMap[type] || 'info');
    const text = document.createElement('span');
    text.textContent = String(content ?? '');
    item.append(icon, text);
    container.appendChild(item);
    lucide.createIcons();
    setTimeout(() => {
        item.style.opacity = '0';
        item.style.transform = 'translateY(-8px) scale(0.98)';
        item.style.transition = '0.2s';
        setTimeout(() => item.remove(), 220);
    }, 2400);
}

function showAdminConfirm(message, title) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('admin_confirm_overlay');
        const textEl = document.getElementById('admin_confirm_text');
        const titleEl = document.getElementById('admin_confirm_title');
        if (!overlay || !textEl) {
            resolve(false);
            return;
        }
        if (titleEl) {
            titleEl.textContent = title && String(title).trim() ? String(title).trim() : '请确认';
        }
        textEl.textContent = message;
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        adminConfirmResolver = resolve;
        lucide.createIcons();
        const okBtn = document.getElementById('admin_confirm_ok');
        if (okBtn) {
            setTimeout(() => okBtn.focus(), 0);
        }
    });
}

function closeAdminConfirm(result) {
    const overlay = document.getElementById('admin_confirm_overlay');
    if (overlay) {
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
    }
    const resolver = adminConfirmResolver;
    adminConfirmResolver = null;
    if (resolver) {
        resolver(Boolean(result));
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && adminConfirmResolver) {
        e.preventDefault();
        closeAdminConfirm(false);
    }
});

async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
}

async function copyTextToClipboard(text) {
    if (!text) {
        throw new Error('内容为空');
    }
    await copyText(text);
}

function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function getPageItems(list, stateKey) {
    const state = paginationState[stateKey];
    const items = Array.isArray(list) ? list : [];
    const total = items.length;
    const pageSize = state.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = (state.page - 1) * pageSize;
    return {
        items: items.slice(start, start + pageSize),
        page: state.page,
        pageSize,
        total,
        totalPages,
        start
    };
}

function getPaginationItems(currentPage, totalPages) {
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
    }
    const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
    if (currentPage <= 3) {
        pages.add(2);
        pages.add(3);
        pages.add(4);
    }
    if (currentPage >= totalPages - 2) {
        pages.add(totalPages - 1);
        pages.add(totalPages - 2);
        pages.add(totalPages - 3);
    }
    const sortedPages = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
    const items = [];
    sortedPages.forEach((page, index) => {
        if (index > 0 && page - sortedPages[index - 1] > 1) {
            items.push('ellipsis');
        }
        items.push(page);
    });
    return items;
}

function renderPagination(containerId, stateKey, total) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const state = paginationState[stateKey];
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    const start = total === 0 ? 0 : ((state.page - 1) * state.pageSize) + 1;
    const end = Math.min(state.page * state.pageSize, total);
    const pageItems = getPaginationItems(state.page, totalPages);
    container.innerHTML = `
        <div class="pagination-meta">共 ${total} 条，当前显示 ${start}-${end}</div>
        <div class="pagination">
            <button class="pagination-nav" onclick="changePage('${stateKey}', ${state.page - 1})" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
            ${pageItems.map((item) => (item === 'ellipsis'
                ? '<span class="pagination-ellipsis">...</span>'
                : `<button class="${item === state.page ? 'active' : ''}" onclick="changePage('${stateKey}', ${item})">${item}</button>`)).join('')}
            <button class="pagination-nav" onclick="changePage('${stateKey}', ${state.page + 1})" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>
        </div>
    `;
}

function closeFilterMenus() {
    document.querySelectorAll('.filter-dropdown.open').forEach((dropdown) => dropdown.classList.remove('open'));
}

function toggleFilterMenu(type) {
    const dropdown = document.querySelector(`.filter-dropdown[data-filter="${type}"]`);
    const shouldOpen = !dropdown?.classList.contains('open');
    closeFilterMenus();
    if (shouldOpen) {
        dropdown?.classList.add('open');
    }
}

function selectFilter(type, value, label) {
    const dropdown = document.querySelector(`.filter-dropdown[data-filter="${type}"]`);
    dropdown?.querySelector('.filter-trigger span')?.replaceChildren(document.createTextNode(label));
    dropdown?.querySelectorAll('.filter-option').forEach((option) => option.classList.remove('active'));
    const activeOption = Array.from(dropdown?.querySelectorAll('.filter-option') || []).find((option) => option.textContent.trim() === label);
    activeOption?.classList.add('active');
    closeFilterMenus();
    if (typeof setFilter === 'function') {
        setFilter(type, value);
    }
}

document.addEventListener('click', (event) => {
    if (!event.target.closest('.filter-dropdown')) {
        closeFilterMenus();
    }
});

function toggleSelection(type, key, checked) {
    if (!key || !selectedItems[type]) return;
    if (checked) {
        selectedItems[type].add(key);
    } else {
        selectedItems[type].delete(key);
    }
}

function pruneSelection(type, source, keyFn) {
    if (!selectedItems[type]) return;
    const validKeys = new Set((Array.isArray(source) ? source : []).map(keyFn).filter(Boolean));
    Array.from(selectedItems[type]).forEach((key) => {
        if (!validKeys.has(key)) {
            selectedItems[type].delete(key);
        }
    });
}

function shortenJobKey(jobKey) {
    const value = String(jobKey || '');
    if (!value) return '-';
    const parts = value.split('-');
    return parts.length > 1 ? parts[1] : value.slice(-8);
}
