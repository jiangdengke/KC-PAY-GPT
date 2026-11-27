/* global lucide, authFetch, showMessage, escapeHtml */
/* exported loadProxyPool, saveProxyPool, testSavedProxy, testAllSavedProxies, toggleProxyActive, deleteSavedProxy */
'use strict';

let proxyPoolList = [];

function renderProxyCheckBadge(item) {
    if (item.last_check_ok === true) {
        return '<span class="status-badge status-success">活跃</span>';
    }
    if (item.last_check_ok === false) {
        return '<span class="status-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">不可用</span>';
    }
    return '<span class="status-badge" style="opacity:.65;">未检测</span>';
}

function renderProxyPoolTable() {
    const tbody = document.getElementById('proxy_pool_body');
    const summary = document.getElementById('proxy_pool_summary');
    if (!tbody) return;

    if (!proxyPoolList.length) {
        tbody.innerHTML = '<tr><td colspan="7">暂无代理，请在上方粘贴 URL 后点击「保存到代理池」</td></tr>';
        if (summary) summary.textContent = '共 0 条，启用 0 条';
        return;
    }

    const activeCount = proxyPoolList.filter((item) => item.is_active).length;
    tbody.innerHTML = proxyPoolList.map((item) => {
        const ipCell = item.last_check_ok
            ? `<code>${escapeHtml(item.last_check_ip || '-')}</code>`
            : `<span style="color:#f87171;font-size:12px;">${escapeHtml(item.last_check_error || '—')}</span>`;
        const latency = item.last_check_ok ? `${item.last_check_latency_ms || 0}ms` : '—';
        return `
            <tr id="proxy_row_${item.id}">
                <td style="text-align:center;">
                    <label class="toggle-control" style="justify-content:center;">
                        <input type="checkbox" class="toggle-input" ${item.is_active ? 'checked' : ''} onchange="toggleProxyActive(${item.id}, this.checked)">
                        <span class="toggle-switch"></span>
                    </label>
                </td>
                <td style="text-align:center;" id="proxy_check_${item.id}">${renderProxyCheckBadge(item)}</td>
                <td id="proxy_ip_${item.id}">${ipCell}</td>
                <td style="text-align:center;" id="proxy_lat_${item.id}">${latency}</td>
                <td style="text-align:center;"><code>${escapeHtml(item.protocol || '-')}</code></td>
                <td><code style="font-size:12px; word-break:break-all;">${escapeHtml(item.proxy_url_masked || item.proxy_url || '')}</code></td>
                <td style="text-align:center;">
                    <button type="button" class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="testSavedProxy(${item.id})">检测</button>
                    <button type="button" class="btn-delete" onclick="deleteSavedProxy(${item.id})" title="删除">
                        <i data-lucide="trash-2"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    if (summary) {
        summary.textContent = `共 ${proxyPoolList.length} 条，启用 ${activeCount} 条`;
    }
    lucide.createIcons();
}

async function loadProxyPool() {
    const res = await authFetch('/api/admin/proxies');
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(data.message || '加载代理池失败');
    }
    proxyPoolList = Array.isArray(data.proxies) ? data.proxies : [];
    renderProxyPoolTable();
}

async function saveProxyPool() {
    const input = document.getElementById('proxy_add_input');
    const hint = document.getElementById('proxy_add_hint');
    const lines = String(input?.value || '').trim();
    if (!lines) {
        showMessage('请先粘贴至少一条代理 URL', 'warning');
        return;
    }
    if (hint) hint.textContent = '保存中...';
    try {
        const res = await authFetch('/api/admin/proxies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxies: lines.split(/\r?\n/) })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || data.message || '保存失败');
        if (input) input.value = '';
        if (hint) hint.textContent = data.message || '已保存';
        showMessage(data.message || '代理已保存', 'success');
        await loadProxyPool();
    } catch (error) {
        if (hint) hint.textContent = '';
        showMessage(error.message || '保存代理失败', 'error');
    }
}

function applyProxyTestResultToRow(id, result) {
    const checkCell = document.getElementById(`proxy_check_${id}`);
    const ipCell = document.getElementById(`proxy_ip_${id}`);
    const latCell = document.getElementById(`proxy_lat_${id}`);
    const rowItem = proxyPoolList.find((item) => item.id === id);
    if (rowItem) {
        rowItem.last_check_ok = Boolean(result.ok);
        rowItem.last_check_ip = result.ok ? (result.ip || '') : '';
        rowItem.last_check_latency_ms = result.ok ? (result.latencyMs || 0) : null;
        rowItem.last_check_error = result.ok ? '' : (result.error || '检测失败');
    }
    if (checkCell) {
        checkCell.innerHTML = result.ok
            ? '<span class="status-badge status-success">活跃</span>'
            : '<span class="status-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">不可用</span>';
    }
    if (ipCell) {
        ipCell.innerHTML = result.ok
            ? `<code>${escapeHtml(result.ip || '-')}</code>`
            : `<span style="color:#f87171;font-size:12px;">${escapeHtml(result.error || '失败')}</span>`;
    }
    if (latCell) {
        latCell.textContent = result.ok ? `${result.latencyMs || 0}ms` : '—';
    }
}

async function testSavedProxy(id) {
    try {
        const res = await authFetch(`/api/admin/proxies/${id}/test`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || data.message || '检测失败');
        applyProxyTestResultToRow(id, data);
        showMessage(data.ok ? `代理活跃，出口 IP: ${data.ip}` : `代理不可用: ${data.error || ''}`, data.ok ? 'success' : 'warning');
    } catch (error) {
        showMessage(error.message || '检测失败', 'error');
    }
}

async function testAllSavedProxies() {
    if (!proxyPoolList.length) {
        showMessage('代理池为空', 'warning');
        return;
    }
    const ids = proxyPoolList.map((item) => item.id);
    try {
        showMessage(`正在检测 ${ids.length} 条代理...`, 'success');
        const res = await authFetch('/api/admin/proxy/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, persist: true })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '批量检测失败');
        const results = Array.isArray(data.results) ? data.results : [];
        let okCount = 0;
        results.forEach((result) => {
            if (result.id) applyProxyTestResultToRow(result.id, result);
            if (result.ok) okCount += 1;
        });
        showMessage(`检测完成：活跃 ${okCount} / 共 ${results.length}`, okCount ? 'success' : 'warning');
    } catch (error) {
        showMessage(error.message || '批量检测失败', 'error');
    }
}

async function toggleProxyActive(id, isActive) {
    try {
        const res = await authFetch(`/api/admin/proxies/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: Boolean(isActive) })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || data.message || '更新失败');
        const rowItem = proxyPoolList.find((item) => item.id === id);
        if (rowItem) rowItem.is_active = Boolean(isActive);
        renderProxyPoolTable();
    } catch (error) {
        showMessage(error.message || '更新代理状态失败', 'error');
        await loadProxyPool();
    }
}

async function deleteSavedProxy(id) {
    if (!confirm('确定删除这条代理？')) return;
    try {
        const res = await authFetch(`/api/admin/proxies/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || data.message || '删除失败');
        showMessage('代理已删除', 'success');
        await loadProxyPool();
    } catch (error) {
        showMessage(error.message || '删除失败', 'error');
    }
}
