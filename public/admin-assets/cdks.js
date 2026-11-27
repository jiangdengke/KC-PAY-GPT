/* global lucide, authFetch, showMessage, showAdminConfirm, escapeHtml, copyText, formatPlanLabel,
   getPlanColors, getPageItems, renderPagination, closeFilterMenus, selectedItems, tableFilters,
   tableSearch, paginationState, pruneSelection, loadData */
/* exported loadCdkList, renderCDKTable, setFilter, handleCdkSearch, selectCdkPlanTypeFilter,
   toggleImportBox, togglePageSelection, selectUnusedOnPage, generateCDKs, importCDKs,
   copyCDK, batchCopyCDKs, batchDeleteCDKs, deleteCDK */
'use strict';

let cdkPool = [];
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
        result = result.filter((item) => String(getCdkCode(item)).toUpperCase().includes(keyword));
    }

    return result;
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

function renderCDKTable() {
    const tbody = document.getElementById('cdk_body');
    if (!tbody) return;
    const pageData = getPageItems(getFilteredCdks(), 'cdk');
    tbody.innerHTML = pageData.items.map((cdk) => {
        const code = getCdkCode(cdk);
        const status = typeof cdk === 'string' ? 'unused' : (cdk.status || 'unused');
        const shipped = typeof cdk === 'string' ? false : Boolean(cdk.shipped);
        const planType = typeof cdk === 'string' ? 'plus' : String(cdk.plan_type || 'unknown').trim().toLowerCase();
        const usedAt = typeof cdk === 'string' ? null : cdk.used_at;
        const sessionPreview = typeof cdk === 'string' ? null : (cdk.session_preview || null);
        const [planTypeColor, planTypeBg] = getPlanColors(planType);
        const planTypeLabel = formatPlanLabel(planType);
        const statusBadge = status === 'processing'
            ? '<span class="status-badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b;">开通中</span>'
            : (status === 'used'
                ? '<span class="status-badge status-success">已使用</span>'
                : '<span class="status-badge status-running">未使用</span>');
        return `
            <tr>
                <td class="select-cell"><input type="checkbox" ${selectedItems.cdk.has(code) ? 'checked' : ''} onchange="toggleSelection('cdk', '${escapeHtml(code)}', this.checked)"></td>
                <td><span class="cdk-copy" onclick="copyCDK('${escapeHtml(code)}')"><code>${escapeHtml(code)}</code><i data-lucide="copy"></i></span></td>
                <td style="text-align:center"><span class="status-badge" style="background: ${planTypeBg}; color: ${planTypeColor}">${escapeHtml(planTypeLabel)}</span></td>
                <td><code>${sessionPreview ? escapeHtml(sessionPreview) : '-'}</code></td>
                <td style="text-align:center"><span class="readonly-switch ${shipped ? 'active' : ''}" title="${shipped ? '已出库' : '未出库'}"></span></td>
                <td>${statusBadge}</td>
                <td>${escapeHtml(usedAt || '-')}</td>
                <td style="text-align:center">
                    <button class="btn-delete" onclick="deleteCDK('${escapeHtml(code)}')">
                        <i data-lucide="trash-2"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
    renderPagination('cdk_pagination', 'cdk', pageData.total);
    lucide.createIcons();
}

async function loadCdkList() {
    const cdkRes = await authFetch('/api/admin/cdks');
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
    pruneSelection('cdk', cdkPool, getCdkCode);
    renderCDKTable();
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
    const planType = document.getElementById('cdk_plan_type').value || 'plus';
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
            body: JSON.stringify({ cdks: codes, plan_type: document.getElementById('cdk_plan_type')?.value || 'plus' })
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
