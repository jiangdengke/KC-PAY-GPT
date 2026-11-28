/* global lucide, authFetch, showMessage, showAdminConfirm, escapeHtml, copyText, formatPlanLabel,
   getPlanColors, formatTimeShort, getPageItems, renderPagination, closeFilterMenus, selectedItems, tableFilters,
   tableSearch, paginationState, pruneSelection, loadData */
/* exported loadCdkList, renderCDKTable, setFilter, selectCdkQuickFilter, updateCdkSelectedBadge, handleCdkSearch, selectCdkPlanTypeFilter,
   toggleImportBox, togglePageSelection, selectUnusedOnPage, generateCDKs, importCDKs,
   copyCDK, batchCopyCDKs, batchDeleteCDKs, deleteCDK, clearCdkCooldown, clearIpCooldown */
'use strict';

let cdkPool = [];
let activeIpCooldowns = [];
let cdkPlanTypeFilter = 'all';

function getCdkCode(item) {
    return typeof item === 'string' ? item : (item.code || '');
}

function getFilteredCdks() {
    const filter = tableFilters.cdk || 'all';
    let result = cdkPool;

    if (filter === 'used') {
        result = result.filter((item) => (typeof item === 'string' ? 'unused' : (item.status || 'unused')) === 'used');
    } else if (filter === 'unused') {
        result = result.filter((item) => (typeof item === 'string' ? 'unused' : (item.status || 'unused')) === 'unused');
    } else if (filter === 'shipped') {
        result = result.filter((item) => typeof item !== 'string' && Boolean(item.shipped));
    } else if (filter === 'unshipped') {
        result = result.filter((item) => typeof item === 'string' || !item.shipped);
    }

    if (cdkPlanTypeFilter && cdkPlanTypeFilter !== 'all') {
        result = result.filter((item) => {
            const planType = typeof item === 'string' ? 'plus' : String(item.plan_type || 'unknown').trim().toLowerCase();
            return planType === cdkPlanTypeFilter;
        });
    }

    const keyword = String(tableSearch.cdk || '').trim().toUpperCase();
    if (keyword) {
        result = result.filter((item) => {
            const code = String(getCdkCode(item)).toUpperCase();
            const preview = typeof item === 'string' ? '' : String(item.session_preview || '').toUpperCase();
            return code.includes(keyword) || preview.includes(keyword);
        });
    }

    return result;
}

function selectCdkQuickFilter(value) {
    setFilter('cdk', value || 'all');
}

function renderCdkQuickTabs() {
    const container = document.getElementById('cdk_quick_tabs');
    if (!container) return;
    const total = cdkPool.length;
    let unused = 0;
    let used = 0;
    let unshipped = 0;
    let shipped = 0;
    for (const item of cdkPool) {
        const st = typeof item === 'string' ? 'unused' : (item.status || 'unused');
        if (st === 'used') used += 1;
        else if (st === 'unused') unused += 1;
        if (typeof item !== 'string' && item.shipped) shipped += 1;
        else unshipped += 1;
    }
    const current = tableFilters.cdk || 'all';
    const tabs = [
        { value: 'all', label: '全部', count: total },
        { value: 'unused', label: '未使用', count: unused },
        { value: 'used', label: '已使用', count: used },
        { value: 'unshipped', label: '未出库', count: unshipped },
        { value: 'shipped', label: '已出库', count: shipped }
    ];
    container.innerHTML = tabs.map((tab) => {
        const isActive = current === tab.value;
        return `<button type="button" role="tab" aria-selected="${isActive}" class="orbitcard-quick-tab ${isActive ? 'is-active' : ''}" onclick="selectCdkQuickFilter('${tab.value}')">
            <span>${tab.label}</span>
            <span class="orbitcard-quick-count">${tab.count}</span>
        </button>`;
    }).join('');
}

function updateCdkSelectedBadge() {
    const badge = document.getElementById('cdk_selected_badge');
    if (!badge) return;
    const count = selectedItems.cdk.size;
    badge.textContent = `已选 ${count}`;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function setFilter(type, value) {
    tableFilters[type] = value;
    if (paginationState[type]) paginationState[type].page = 1;
    if (type === 'cdk') renderCDKTable();
}

function handleCdkSearch(value) {
    tableSearch.cdk = String(value || '');
    paginationState.cdk.page = 1;
    renderCDKTable();
}

function selectCdkPlanTypeFilter(value, label) {
    cdkPlanTypeFilter = value;
    const dropdown = document.querySelector('.filter-dropdown[data-filter="cdk_plan_type_filter"]');
    if (dropdown) {
        dropdown.querySelector('.filter-trigger span').innerText = label;
        dropdown.querySelectorAll('.filter-option').forEach((item) => {
            item.classList.toggle('active', item.textContent.trim() === label);
        });
    }
    closeFilterMenus();
    paginationState.cdk.page = 1;
    renderCDKTable();
}

function toggleImportBox(type) {
    if (type === 'cdk') {
        document.getElementById('cdk_import_box')?.classList.toggle('active');
    }
}

function togglePageSelection(type) {
    if (type !== 'cdk') return;
    const pageData = getPageItems(getFilteredCdks(), 'cdk');
    const keys = pageData.items.map(getCdkCode).filter(Boolean);
    const shouldSelect = keys.some((key) => !selectedItems.cdk.has(key));
    keys.forEach((key) => {
        if (shouldSelect) selectedItems.cdk.add(key);
        else selectedItems.cdk.delete(key);
    });
    renderCDKTable();
}

function selectUnusedOnPage(type) {
    if (type !== 'cdk') return;
    const pageData = getPageItems(getFilteredCdks(), 'cdk');
    let count = 0;
    pageData.items.forEach((item) => {
        const code = getCdkCode(item);
        const status = typeof item === 'string' ? 'unused' : (item.status || 'unused');
        if (code && status === 'unused') {
            selectedItems.cdk.add(code);
            count += 1;
        }
    });
    renderCDKTable();
    showMessage(count > 0 ? `已选中本页 ${count} 个未使用 CDK` : '本页没有未使用的 CDK', count > 0 ? 'success' : 'warning');
}

function renderIpCooldownBanner() {
    const banner = document.getElementById('cdk_ip_cooldown_banner');
    if (!banner) return;
    if (!activeIpCooldowns.length) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    banner.style.display = 'flex';
    banner.innerHTML = `
        <div class="cdk-cooldown-banner-title">
            <i data-lucide="clock"></i>
            <span>当前有 <strong>${activeIpCooldowns.length}</strong> 个 IP 因连续失败处于 30 分钟冷静期：</span>
        </div>
        <div class="cdk-cooldown-chips">
            ${activeIpCooldowns.map((item) => {
                const ip = escapeHtml(item.scopeKey || '');
                const mins = Math.max(1, Number(item.remainingMinutes || 1));
                return `<span class="cdk-cooldown-chip">
                    <code>${ip}</code>
                    <span class="cdk-cooldown-mins">剩 ${mins} 分钟</span>
                    <button type="button" class="btn-unlock-cooldown" onclick="clearIpCooldown('${ip}')">解除冷却</button>
                </span>`;
            }).join('')}
        </div>`;
}

function renderCDKTable() {
    const tbody = document.getElementById('cdk_body');
    if (!tbody) return;
    renderIpCooldownBanner();
    renderCdkQuickTabs();
    updateCdkSelectedBadge();
    const pageData = getPageItems(getFilteredCdks(), 'cdk');
    if (!pageData.items.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-dim); padding:38px 0;">${cdkPool.length ? '暂无符合筛选条件的激活码' : '暂无激活码，点击右上角「生成」或「批量导入」添加'}</td></tr>`;
        renderPagination('cdk_pagination', 'cdk', 0);
        lucide.createIcons();
        return;
    }
    tbody.innerHTML = pageData.items.map((cdk) => {
        const code = getCdkCode(cdk);
        const status = typeof cdk === 'string' ? 'unused' : (cdk.status || 'unused');
        const shipped = typeof cdk === 'string' ? false : Boolean(cdk.shipped);
        const planType = typeof cdk === 'string' ? 'plus' : String(cdk.plan_type || 'unknown').trim().toLowerCase();
        const usedAt = typeof cdk === 'string' ? null : cdk.used_at;
        const sessionPreview = typeof cdk === 'string' ? null : (cdk.session_preview || null);
        const failCount = typeof cdk === 'string' ? 0 : Number(cdk.fail_count || 0);
        const cooldownMinutes = typeof cdk === 'string' ? 0 : Number(cdk.cooldown_remaining_minutes || 0);
        const [planTypeColor, planTypeBg] = getPlanColors(planType);
        const planTypeLabel = formatPlanLabel(planType);
        const failTitle = failCount > 0 ? ` title="近期客户侧失败 ${failCount}/3 次"` : '';
        const statusBadge = status === 'processing'
            ? '<span class="status-badge status-warning">开通中</span>'
            : (status === 'used'
                ? '<span class="status-badge status-success">已使用</span>'
                : (cooldownMinutes > 0
                    ? `<span class="status-badge status-warning" title="连续失败 3 次冷却中，剩余约 ${cooldownMinutes} 分钟">冷静中 ${cooldownMinutes}m</span>`
                    : `<span class="status-badge status-running"${failTitle}>未使用</span>`));
        const unlockBtn = cooldownMinutes > 0 || failCount > 0
            ? `<button type="button" class="btn-unlock-cooldown" onclick="clearCdkCooldown('${escapeHtml(code)}')" title="清零失败计数并解除冷却">解除冷却</button>`
            : '';
        return `
            <tr>
                <td class="select-cell"><input type="checkbox" ${selectedItems.cdk.has(code) ? 'checked' : ''} onchange="toggleSelection('cdk', '${escapeHtml(code)}', this.checked); updateCdkSelectedBadge();"></td>
                <td><span class="cdk-copy" onclick="copyCDK('${escapeHtml(code)}')"><code>${escapeHtml(code)}</code><i data-lucide="copy"></i></span></td>
                <td style="text-align:center"><span class="status-badge" style="background: ${planTypeBg}; color: ${planTypeColor}">${escapeHtml(planTypeLabel)}</span></td>
                <td style="max-width:210px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(sessionPreview || '')}"><code>${sessionPreview ? escapeHtml(sessionPreview) : '-'}</code></td>
                <td style="text-align:center"><span class="readonly-switch ${shipped ? 'active' : ''}" title="${shipped ? '已出库' : '未出库'}"></span></td>
                <td style="text-align:center">${statusBadge}</td>
                <td style="white-space:nowrap; font-size:12.5px; color:var(--text-dim);">${usedAt ? escapeHtml(formatTimeShort(usedAt)) : '-'}</td>
                <td style="text-align:center">
                    <div class="cdk-row-actions">
                        ${unlockBtn}
                        <button class="btn-delete" onclick="deleteCDK('${escapeHtml(code)}')" title="删除">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
    }).join('');
    renderPagination('cdk_pagination', 'cdk', pageData.total);
    lucide.createIcons();
}

async function loadCdkList() {
    const [cdkRes, cooldownRes] = await Promise.all([
        authFetch('/api/admin/cdks'),
        authFetch('/api/admin/activation-cooldowns').catch(() => null)
    ]);
    let cdkData = [];
    try {
        cdkData = await cdkRes.json();
    } catch (_) {
        throw new Error('CDK 列表响应解析失败');
    }
    if (!cdkRes.ok) {
        throw new Error(cdkData?.message || `加载 CDK 失败（${cdkRes.status}）`);
    }
    cdkPool = Array.isArray(cdkData) ? cdkData : (Array.isArray(cdkData?.cdks) ? cdkData.cdks : []);
    activeIpCooldowns = [];
    if (cooldownRes && cooldownRes.ok) {
        const cooldownData = await cooldownRes.json().catch(() => null);
        if (cooldownData?.success && Array.isArray(cooldownData.cooldowns)) {
            activeIpCooldowns = cooldownData.cooldowns;
        }
    }
    pruneSelection('cdk', cdkPool, getCdkCode);
    renderCDKTable();
}

async function clearCdkCooldown(cdk) {
    try {
        const res = await authFetch(`/api/admin/cdks/${encodeURIComponent(cdk)}/clear-cooldown`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '解除冷却失败');
        showMessage(data.message || `已解除 ${cdk} 的冷却`, 'success');
        await loadCdkList();
    } catch (error) {
        showMessage(error.message || '解除 CDK 冷却失败', 'error');
    }
}

async function clearIpCooldown(ip) {
    try {
        const res = await authFetch('/api/admin/activation-cooldowns/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope_type: 'ip', scope_key: ip })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '解除 IP 冷却失败');
        showMessage(data.message || `已解除 ${ip} 的冷却`, 'success');
        await loadCdkList();
    } catch (error) {
        showMessage(error.message || '解除 IP 冷却失败', 'error');
    }
}

async function markCDKShipped(cdk) {
    const res = await authFetch(`/api/admin/cdks/${encodeURIComponent(cdk)}/ship`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || '标记出库失败');
    const item = cdkPool.find((entry) => getCdkCode(entry) === cdk);
    if (item && typeof item !== 'string') item.shipped = true;
    renderCDKTable();
}

async function copyCDK(cdk) {
    try {
        await copyText(cdk);
        await markCDKShipped(cdk);
        showMessage(`已复制激活码: ${cdk}`, 'success');
    } catch (_) {
        showMessage('复制失败，请手动复制', 'error');
    }
}

async function batchCopyCDKs() {
    const codes = Array.from(selectedItems.cdk);
    if (codes.length === 0) {
        showMessage('请选择要复制的 CDK', 'warning');
        return;
    }
    try {
        await copyText(codes.join('\n'));
        await Promise.all(codes.map((code) => markCDKShipped(code)));
        showMessage(`已复制 ${codes.length} 个 CDK，并标记出库`, 'success');
    } catch (error) {
        showMessage(error.message || '批量复制失败', 'error');
    }
}

async function batchDeleteCDKs() {
    const codes = Array.from(selectedItems.cdk);
    if (codes.length === 0) {
        showMessage('请选择要删除的 CDK', 'warning');
        return;
    }
    const ok = await showAdminConfirm(`确定删除选中的 ${codes.length} 个 CDK ?`, '删除 CDK');
    if (!ok) return;
    await Promise.all(codes.map((code) => authFetch(`/api/admin/cdks/${encodeURIComponent(code)}`, { method: 'DELETE' })));
    selectedItems.cdk.clear();
    await loadData();
}

async function generateCDKs(btn) {
    const count = parseInt(document.getElementById('cdk_count').value, 10) || 1;
    const planType = 'plus';
    const original = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 生成中...';
    lucide.createIcons();
    try {
        const res = await authFetch('/api/admin/cdks/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count, plan_type: planType })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '生成失败');
        showMessage(data.message || '生成成功', 'success');
        tableFilters.cdk = 'all';
        paginationState.cdk.page = 1;
        const dropdown = document.querySelector('.filter-dropdown[data-filter="cdk"] .filter-trigger span');
        if (dropdown) dropdown.textContent = '全部状态';
        await loadCdkList();
    } catch (error) {
        showMessage(error.message || '生成失败', 'error');
    } finally {
        btn.innerHTML = original;
        lucide.createIcons();
    }
}

async function importCDKs() {
    const textarea = document.getElementById('cdk_import_text');
    const codes = [...new Set(String(textarea?.value || '').split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean))];
    if (codes.length === 0) {
        showMessage('请输入要导入的卡密', 'warning');
        return;
    }
    try {
        const res = await authFetch('/api/admin/cdks/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cdks: codes, plan_type: 'plus' })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '导入失败');
        textarea.value = '';
        document.getElementById('cdk_import_box')?.classList.remove('active');
        await loadData();
        showMessage(`导入完成，新增 ${Number(data.insertedCount || 0)} 个，重复 ${Number(data.duplicateCount || 0)} 个`, 'success');
    } catch (error) {
        showMessage(error.message || '导入失败', 'error');
    }
}

async function deleteCDK(cdk) {
    const ok = await showAdminConfirm(`确定删除 CDK: ${cdk} ?`, '删除 CDK');
    if (!ok) return;
    await authFetch(`/api/admin/cdks/${encodeURIComponent(cdk)}`, { method: 'DELETE' });
    await loadData();
}
