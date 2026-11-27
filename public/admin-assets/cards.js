/* global lucide, authFetch, showMessage, showAdminConfirm, escapeHtml, formatPlanLabel, formatTimeShort,
   getPaginationItems, CANONICAL_PLAN_TYPES, PLAN_LABELS */
/* exported toggleCardPoolImportBox, loadCardPoolList, deleteCardPoolItem, importCardPool,
   loadOrbitcardProductStrategy, saveOrbitcardProductStrategy, renderOrbitcardStrategyDetails,
   syncOrbitcardCards, applyOrbitcardUsageFilters, resetOrbitcardUsageFilters, loadOrbitcardUsage,
   setOrbitcardCardPlan, restoreOrbitcardCard */
'use strict';

let cardPoolList = [];
let orbitcardUsageList = [];
const orbitcardUsageState = {
    page: 1,
    pageSize: 20,
    total: 0,
    filters: {
        keyword: '',
        planType: '',
        cardStatus: '',
        rechargeStatus: ''
    }
};
let orbitcardUsageRequestId = 0;
let orbitcardStrategyProducts = [];
let orbitcardStrategyAutomatic = {};
let orbitcardStrategyAutoCreate = false;
let orbitcardStrategyPlusUnitPrice = 20;
let orbitcardStrategyReuseLimits = { plus: 4, pro100: 1, pro200: 1, pro500: 1 };
let orbitcardStrategySafetyMargins = { plus: 1, pro100: 1, pro200: 1, pro500: 1 };

function toggleCardPoolImportBox() {
    document.getElementById('card_pool_import_box')?.classList.toggle('active');
}

function getCardStatusBadge(card) {
    const status = (card.status || '').toLowerCase();
    if (!card.is_active || card.is_active === 0 || status === '已报废') {
        return '<span class="status-badge status-failed">已报废</span>';
    }
    if (status === '冷却中' || (card.cooldown_until && new Date(card.cooldown_until) > new Date())) {
        return '<span class="status-badge status-warning">冷却中</span>';
    }
    return '<span class="status-badge status-success">正常</span>';
}

function formatBoundAddress(card) {
    const parts = [
        card.payment_address_line1 || '',
        card.payment_address_city || '',
        card.payment_address_state || '',
        card.payment_address_postal || ''
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : '-';
}

function renderCardPoolTable() {
    const tbody = document.getElementById('card_pool_list_body');
    if (!tbody) return;
    if (cardPoolList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>';
        lucide.createIcons();
        return;
    }
    tbody.innerHTML = cardPoolList.map((card) => `
        <tr>
            <td><code>${escapeHtml(card.card_number || card.last4 || '****')}</code></td>
            <td><code>${escapeHtml(card.card_expiry || '-')}</code></td>
            <td><code>${escapeHtml(card.card_cvc || '-')}</code></td>
            <td>${escapeHtml(card.card_holder || '-')}</td>
            <td>${escapeHtml(card.payment_holder_name || '-')}</td>
            <td style="font-size:12px; color:var(--text-secondary); max-width:280px; word-break:break-word;">${escapeHtml(formatBoundAddress(card))}</td>
            <td style="text-align:center">${getCardStatusBadge(card)}</td>
            <td style="text-align:center">${Number(card.usage_count || 0)}</td>
            <td style="text-align:center">${card.last_used_at ? formatTimeShort(card.last_used_at) : '-'}</td>
            <td style="text-align:center">
                <button class="btn-delete" onclick="deleteCardPoolItem(${card.id})" title="删除">
                    <i data-lucide="trash-2"></i>
                </button>
            </td>
        </tr>`).join('');
    lucide.createIcons();
}

async function loadCardPoolList() {
    try {
        const res = await authFetch('/api/admin/cards');
        const data = await res.json();
        cardPoolList = Array.isArray(data.cards) ? data.cards : (Array.isArray(data) ? data : []);
        renderCardPoolTable();
    } catch (e) {
        console.error('loadCardPoolList failed', e);
        showMessage('加载卡池列表失败', 'error');
    }
}

async function deleteCardPoolItem(cardId) {
    const ok = await showAdminConfirm('确定删除该卡片？删除后不可恢复。', '删除卡片');
    if (!ok) return;
    try {
        const res = await authFetch(`/api/admin/cards/${cardId}`, { method: 'DELETE' });
        if (res.ok) {
            showMessage('卡片已删除', 'success');
            cardPoolList = cardPoolList.filter((c) => c.id !== cardId);
            renderCardPoolTable();
        } else {
            const err = await res.json().catch(() => ({}));
            showMessage(err.error || '删除失败', 'error');
        }
    } catch (_) {
        showMessage('删除请求失败', 'error');
    }
}

async function importCardPool() {
    const textarea = document.getElementById('card_pool_import_text');
    const resultEl = document.getElementById('card_pool_import_result');
    const btn = document.getElementById('card_pool_import_btn');
    const text = (textarea?.value || '').trim();
    if (!text) {
        showMessage('请输入要导入的卡片数据', 'warning');
        return;
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const cards = [];
    const parseErrors = [];
    for (let i = 0; i < lines.length; i += 1) {
        const parts = lines[i].split('|');
        if (parts.length < 3) {
            parseErrors.push(`第 ${i + 1} 行格式错误（需至少 3 个字段，用 | 分隔）`);
            continue;
        }
        cards.push({
            card_number: (parts[0] || '').trim(),
            card_expiry: (parts[1] || '').trim(),
            card_cvc: (parts[2] || '').trim(),
            card_holder: (parts[3] || '').trim()
        });
    }

    if (cards.length === 0) {
        showMessage('未解析到有效卡片数据，请检查格式', 'error');
        if (parseErrors.length > 0 && resultEl) {
            resultEl.textContent = parseErrors.slice(0, 5).join('；');
        }
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 导入中...';
    lucide.createIcons();

    try {
        const res = await authFetch('/api/admin/cards/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cards })
        });
        const data = await res.json();
        if (res.ok) {
            const imported = data.imported || 0;
            const skipped = data.skipped || 0;
            const failed = data.failed || 0;
            const failureHint = Array.isArray(data.failures) && data.failures.length
                ? `；示例错误：${data.failures.slice(0, 3).map((item) => `第 ${(item.index || 0) + 1} 行 ${Array.isArray(item.errors) ? item.errors.join('、') : ''}`).join('；')}`
                : '';
            if (resultEl) {
                resultEl.textContent = `导入完成：成功 ${imported}，跳过 ${skipped}，失败 ${failed}${failureHint}`;
                resultEl.style.color = imported > 0 ? 'var(--success)' : 'var(--text-dim)';
            }
            showMessage(`成功导入 ${imported} 张卡片`, 'success');
            textarea.value = '';
            await loadCardPoolList();
        } else {
            showMessage(data.error || '导入失败', 'error');
            if (resultEl) {
                resultEl.textContent = data.error || '导入失败';
                resultEl.style.color = 'var(--error)';
            }
        }
    } catch (_) {
        showMessage('导入请求失败', 'error');
        if (resultEl) {
            resultEl.textContent = '网络错误';
            resultEl.style.color = 'var(--error)';
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="check-check"></i> 解析并导入';
        lucide.createIcons();
    }
}

// ─── Orbitcard 策略 & 用卡记录 ──────────────────────────────────────────────

function orbitcardProductGroupLabel(product) {
    const channel = Number(product?.channel);
    return Number.isFinite(channel) && channel > 0 ? `渠道 ${channel}` : '其他产品';
}

function orbitcardInventoryLabel(product) {
    if (String(product?.inventory_mode || '').toLowerCase() === 'provider_validated') {
        return '库存开卡时实时校验';
    }
    const count = Number(product?.remaining_open_card_num);
    return Number.isFinite(count) ? `实时库存 ${count} 张` : '库存数量未返回';
}

function formatOrbitcardMoney(value, currency = 'USD') {
    if (value == null || value === '') return '未返回';
    const amount = Number(value);
    return Number.isFinite(amount) ? `${amount.toFixed(2)} ${currency || 'USD'}` : '未返回';
}

function getOrbitcardStrategyPlan(planType) {
    const selectedCode = document.getElementById('orbitcard_strategy_product_code')?.value || '';
    if (!selectedCode) return orbitcardStrategyAutomatic?.[planType] || null;
    const product = orbitcardStrategyProducts.find((item) => item.product_code === selectedCode);
    const plan = product?.plans?.[planType];
    return plan ? {
        ...plan,
        product_code: product.product_code,
        bin: product.bin,
        network: product.network,
        channel: product.channel,
        min_initial_amount: product.min_initial_amount,
        min_retained_balance: product.min_retained_balance
    } : null;
}

function renderOrbitcardStrategyDetails() {
    const select = document.getElementById('orbitcard_strategy_product_code');
    const summary = document.getElementById('orbitcard_strategy_summary');
    const tbody = document.getElementById('orbitcard_strategy_plan_body');
    const autoCreateToggle = document.getElementById('orbitcard_auto_create_card');
    if (!select || !summary || !tbody) return;
    const autoCreateEnabled = autoCreateToggle ? Boolean(autoCreateToggle.checked) : orbitcardStrategyAutoCreate;
    const plusLimit = Number(document.getElementById('orbitcard_reuse_limit_plus')?.value || orbitcardStrategyReuseLimits.plus || 4);
    const plusMargin = Number(document.getElementById('orbitcard_safety_margin_plus')?.value ?? orbitcardStrategySafetyMargins.plus ?? 1);
    const plusFallbackPrice = Number(document.getElementById('orbitcard_plus_unit_price')?.value || orbitcardStrategyPlusUnitPrice || 20);
    const selectedCode = select.value || '';
    const selected = orbitcardStrategyProducts.find((item) => item.product_code === selectedCode);
    if (!autoCreateEnabled) {
        summary.innerHTML = `<div style="padding:14px 16px; border-left:3px solid var(--warning, #d97706); background:var(--bg-secondary);">
            <strong>手动开卡 + 自动同步模式（已关闭自动开卡）</strong>
            <div style="font-size:13px; color:var(--text-dim); margin-top:5px;">系统不会主动向 Orbitcard 发起开卡；同步或下单发现未绑定新卡时，将按余额自动推算可充 Plus 次数（安全余量 ${plusMargin} USD、兜底单价 ${plusFallbackPrice} USD、单卡上限 ${plusLimit} 次）。</div>
        </div>`;
    } else if (selectedCode && selected) {
        summary.innerHTML = `<div style="display:flex; gap:18px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:14px 16px; border:1px solid var(--border); border-radius:8px; background:var(--bg-secondary);">
            <div><strong>持续指定产品</strong><div style="font-size:13px; color:var(--text-dim); margin-top:5px;">${escapeHtml(orbitcardProductGroupLabel(selected))} · ${escapeHtml(selected.network || '卡')} · BIN ${escapeHtml(selected.bin || '未知')} · ${escapeHtml(selected.product_code)}</div></div>
            <div style="font-size:13px; font-weight:600;">${escapeHtml(orbitcardInventoryLabel(selected))}</div>
        </div>`;
    } else {
        summary.innerHTML = `<div style="padding:14px 16px; border-left:3px solid var(--primary); background:var(--bg-secondary);">
            <strong>自动按优先级选择</strong>
            <div style="font-size:13px; color:var(--text-dim); margin-top:5px;">实际开卡时按当前渠道优先级和实时可用产品选择；下表展示本次目录对应的选择结果。</div>
        </div>`;
    }
    const planLabels = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
        planType,
        planType === 'plus' ? 'ChatGPT Plus' : `ChatGPT ${PLAN_LABELS[planType]}`
    ]));
    tbody.innerHTML = Object.entries(planLabels).map(([planType, label]) => {
        const detail = getOrbitcardStrategyPlan(planType);
        if (!detail) {
            return `<tr><td><strong>${label}</strong></td><td colspan="5" style="color:var(--error);">所选产品当前没有该套餐的开卡参数</td></tr>`;
        }
        const productText = `${detail.channel ? `渠道 ${detail.channel} · ` : ''}${detail.bin ? `BIN ${detail.bin}` : detail.product_code || ''}`;
        return `<tr>
            <td><strong>${label}</strong><br><small style="color:var(--text-dim);">${escapeHtml(productText)}</small></td>
            <td>${escapeHtml(formatOrbitcardMoney(detail.plan_price, detail.currency))}</td>
            <td>${Number(detail.max_usage_count || 1)} 次</td>
            <td>${escapeHtml(formatOrbitcardMoney(detail.min_initial_amount, 'USD'))}</td>
            <td>${escapeHtml(formatOrbitcardMoney(detail.min_retained_balance, 'USD'))}</td>
            <td><strong style="color:var(--primary);">${escapeHtml(formatOrbitcardMoney(detail.amount, 'USD'))}</strong></td>
        </tr>`;
    }).join('');
    lucide.createIcons();
}

async function loadOrbitcardProductStrategy(showToast = false) {
    const select = document.getElementById('orbitcard_strategy_product_code');
    const hint = document.getElementById('orbitcard_strategy_inventory_hint');
    const autoCreateToggle = document.getElementById('orbitcard_auto_create_card');
    const plusUnitPriceInput = document.getElementById('orbitcard_plus_unit_price');
    if (!select || !hint) return;
    const previous = select.value || '';
    select.disabled = true;
    try {
        const res = await authFetch('/api/admin/orbitcard/products');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '产品目录查询失败');
        orbitcardStrategyProducts = Array.isArray(data.products) ? data.products : [];
        orbitcardStrategyAutomatic = data.automatic || {};
        orbitcardStrategyAutoCreate = Boolean(data.auto_create_card);
        orbitcardStrategyPlusUnitPrice = Number.isFinite(Number(data.plus_unit_price))
            ? Number(data.plus_unit_price)
            : 20;
        if (autoCreateToggle) autoCreateToggle.checked = orbitcardStrategyAutoCreate;
        if (plusUnitPriceInput) plusUnitPriceInput.value = orbitcardStrategyPlusUnitPrice;
        orbitcardStrategyReuseLimits = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
            planType,
            Number(data.reuse_limits?.[planType]) || (planType === 'plus' ? 4 : 1)
        ]));
        orbitcardStrategySafetyMargins = Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
            planType,
            Number.isFinite(Number(data.safety_margins?.[planType])) ? Number(data.safety_margins[planType]) : 1
        ]));
        for (const planType of CANONICAL_PLAN_TYPES) {
            const input = document.getElementById(`orbitcard_reuse_limit_${planType}`);
            if (input) input.value = orbitcardStrategyReuseLimits[planType];
            const marginInput = document.getElementById(`orbitcard_safety_margin_${planType}`);
            if (marginInput) marginInput.value = orbitcardStrategySafetyMargins[planType];
        }
        const configured = String(data.selected_product_code || previous || '');
        select.innerHTML = '<option value="">自动按优先级选择</option>';
        for (const product of orbitcardStrategyProducts) {
            const option = document.createElement('option');
            option.value = product.product_code || '';
            option.textContent = `${orbitcardProductGroupLabel(product)} ${product.network || '卡'} · BIN ${product.bin || '未知'} · ${product.product_code} · ${orbitcardInventoryLabel(product)}`;
            select.appendChild(option);
        }
        const available = Array.from(select.options).some((option) => option.value === configured);
        select.value = available ? configured : '';
        const fetchedAt = data.fetched_at ? new Date(data.fetched_at).toLocaleString('zh-CN', { hour12: false }) : '刚刚';
        hint.textContent = `库存直接来自本次 Orbitcard 产品目录，查询时间：${fetchedAt}。供应商实时校验型产品不显示“0 张”。`;
        renderOrbitcardStrategyDetails();
        if (showToast) showMessage('上游产品与库存已刷新', 'success');
    } catch (error) {
        try {
            const cfgRes = await authFetch('/api/admin/gpt-api');
            const cfgData = await cfgRes.json();
            if (cfgRes.ok && cfgData?.success && cfgData.config) {
                orbitcardStrategyAutoCreate = Boolean(cfgData.config.orbitcard_auto_create_card);
                orbitcardStrategyPlusUnitPrice = Number(cfgData.config.orbitcard_plus_unit_price) || 20;
                if (autoCreateToggle) autoCreateToggle.checked = orbitcardStrategyAutoCreate;
                if (plusUnitPriceInput) plusUnitPriceInput.value = orbitcardStrategyPlusUnitPrice;
                renderOrbitcardStrategyDetails();
            }
        } catch (_) { /* ignore fallback read failure */ }
        hint.textContent = `产品目录读取失败：${error.message || '未知错误'}`;
        if (showToast) showMessage(error.message || '产品目录读取失败', 'error');
    } finally {
        select.disabled = false;
        lucide.createIcons();
    }
}

async function saveOrbitcardProductStrategy() {
    const productCode = document.getElementById('orbitcard_strategy_product_code')?.value || '';
    const autoCreateCard = Boolean(document.getElementById('orbitcard_auto_create_card')?.checked);
    const plusUnitPrice = Number(document.getElementById('orbitcard_plus_unit_price')?.value);
    if (!Number.isFinite(plusUnitPrice) || plusUnitPrice < 1 || plusUnitPrice > 500) {
        showMessage('兜底 Plus 估算单价必须是 1-500 之间的数字', 'warning');
        return;
    }
    const reuseLimits = {};
    const safetyMargins = {};
    for (const planType of CANONICAL_PLAN_TYPES) {
        const value = Number(document.getElementById(`orbitcard_reuse_limit_${planType}`)?.value);
        if (!Number.isInteger(value) || value < 1 || value > 20) {
            showMessage(`${formatPlanLabel(planType)} 的一卡几冲必须是 1-20 的整数`, 'warning');
            return;
        }
        reuseLimits[planType] = value;
        const margin = Number(document.getElementById(`orbitcard_safety_margin_${planType}`)?.value);
        if (!Number.isFinite(margin) || margin < 0 || margin > 100) {
            showMessage(`${formatPlanLabel(planType)} 的安全余量必须是 0-100 的数字`, 'warning');
            return;
        }
        safetyMargins[planType] = margin;
    }
    try {
        const res = await authFetch('/api/admin/orbitcard/product-strategy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                auto_create_card: autoCreateCard,
                plus_unit_price: Number(plusUnitPrice.toFixed(2)),
                product_code: productCode,
                reuse_limits: reuseLimits,
                safety_margins: safetyMargins
            })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '保存开卡策略失败');
        orbitcardStrategyAutoCreate = Boolean(data.auto_create_card);
        orbitcardStrategyPlusUnitPrice = Number(data.plus_unit_price) || plusUnitPrice;
        showMessage(data.message || '开卡策略已保存', 'success');
        await loadOrbitcardProductStrategy(false);
    } catch (error) {
        showMessage(error.message || '保存开卡策略失败', 'error');
    }
}

async function syncOrbitcardCards() {
    const button = document.getElementById('orbitcard_sync_btn');
    if (button) button.disabled = true;
    try {
        const res = await authFetch('/api/admin/orbitcard/sync', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '同步卡台卡片失败');
        await loadOrbitcardUsage(false, false);
        showMessage(data.message || '卡台卡片已同步', data.detailFailures?.length ? 'warning' : 'success');
    } catch (error) {
        showMessage(error.message || '同步卡台卡片失败', 'error');
    } finally {
        if (button) button.disabled = false;
        lucide.createIcons();
    }
}

function readOrbitcardUsageFilters() {
    return {
        keyword: (document.getElementById('orbitcard_usage_keyword')?.value || '').trim().slice(0, 80),
        planType: document.getElementById('orbitcard_usage_plan')?.value || '',
        cardStatus: document.getElementById('orbitcard_usage_card_status')?.value || '',
        rechargeStatus: document.getElementById('orbitcard_usage_recharge_status')?.value || ''
    };
}

function applyOrbitcardUsageFilters(event) {
    event?.preventDefault();
    orbitcardUsageState.filters = readOrbitcardUsageFilters();
    return loadOrbitcardUsage(false, false, 1);
}

function resetOrbitcardUsageFilters() {
    for (const id of ['orbitcard_usage_keyword', 'orbitcard_usage_plan', 'orbitcard_usage_card_status', 'orbitcard_usage_recharge_status']) {
        const element = document.getElementById(id);
        if (element) element.value = '';
    }
    orbitcardUsageState.filters = readOrbitcardUsageFilters();
    return loadOrbitcardUsage(false, false, 1);
}

function renderOrbitcardUsagePagination() {
    const container = document.getElementById('orbitcard_usage_pagination');
    if (!container) return;
    const total = orbitcardUsageState.total;
    const page = orbitcardUsageState.page;
    const pageSize = orbitcardUsageState.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : ((page - 1) * pageSize) + 1;
    const end = Math.min(page * pageSize, total);
    container.innerHTML = `<div class="pagination-meta">显示 ${start}-${end}，共 ${total} 张卡</div><div class="pagination">
        <button class="pagination-nav" onclick="loadOrbitcardUsage(false, false, ${page - 1})" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        ${getPaginationItems(page, totalPages).map((item) => (item === 'ellipsis'
            ? '<span class="pagination-ellipsis">...</span>'
            : `<button class="${item === page ? 'active' : ''}" onclick="loadOrbitcardUsage(false, false, ${item})">${item}</button>`)).join('')}
        <button class="pagination-nav" onclick="loadOrbitcardUsage(false, false, ${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    </div>`;
}

function renderOrbitcardPlanActions(card) {
    const status = String(card.status || '').toUpperCase();
    if (card.inUse || ['PROVIDER_DELETED', 'CANCELLED'].includes(status)) return '';
    const cardId = Number(card.cardId);
    const options = CANONICAL_PLAN_TYPES
        .map((value) => `<option value="${value}" ${card.planType === value ? 'selected' : ''}>${PLAN_LABELS[value]}</option>`)
        .join('');
    const usageLimit = card.planType ? Number(card.maxUsageCount || 1) : '';
    return `<div class="orbitcard-plan-actions">
        <select id="orbitcard_plan_${cardId}" class="orbitcard-plan-select" aria-label="选择卡片套餐">
            <option value="">选择套餐</option>
            ${options}
        </select>
        <input id="orbitcard_limit_${cardId}" class="orbitcard-limit-input" type="number" min="1" max="20" step="1" value="${usageLimit}" placeholder="默认" aria-label="单卡使用上限">
        <button type="button" class="btn btn-secondary" onclick="setOrbitcardCardPlan(${cardId})">${card.planType ? '保存' : '绑定'}</button>
    </div>`;
}

function formatOrbitcardRechargeStatus(status) {
    const labels = { success: '成功', succeeded: '成功', processing: '处理中', running: '进行中', failed: '失败' };
    const lower = String(status || '').toLowerCase();
    const label = labels[lower] || String(status || '-');
    const cls = ['success', 'succeeded'].includes(lower)
        ? 'status-success'
        : (['failed', 'error'].includes(lower) ? 'status-failed' : 'status-running');
    return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderOrbitcardUsageTable() {
    const tbody = document.getElementById('orbitcard_usage_body');
    if (!tbody) return;
    if (!orbitcardUsageList.length) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-dim); padding:36px 0;">${Object.values(orbitcardUsageState.filters).some(Boolean) ? '暂无符合条件的 Orbitcard 用卡记录' : '暂无 Orbitcard 用卡记录，请点击“同步卡台卡片”'}</td></tr>`;
        return;
    }
    tbody.innerHTML = orbitcardUsageList.map((card) => {
        const histories = Array.isArray(card.recharges) ? card.recharges : [];
        const historyHtml = histories.length
            ? histories.map((item) => `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:3px 0; border-bottom:1px solid var(--border);">
                <span>${escapeHtml(item.accountEmail || '账号未返回')}</span>
                <span style="color:var(--text-dim);">${escapeHtml(formatPlanLabel(item.planType))} #${Number(item.useNumber || 0)}</span>
                ${formatOrbitcardRechargeStatus(item.status)}
                <span style="color:var(--text-dim);">${escapeHtml(formatTimeShort(item.createdAt))}</span>
            </div>`).join('')
            : '<span style="color:var(--text-dim);">暂无账号记录</span>';
        const status = String(card.status || '').toUpperCase();
        const statusLabel = status === 'PROVIDER_DELETED'
            ? '上游已删除'
            : (status === 'RETIRED'
                ? '已退役'
                : (status === 'CANCELLED'
                    ? '已取消'
                    : (!card.planType ? '未绑定套餐' : (card.inUse ? '使用中' : '可复用'))));
        const statusClass = ['PROVIDER_DELETED', 'RETIRED', 'CANCELLED'].includes(status)
            ? 'status-failed'
            : (!card.planType ? 'status-warning' : (card.inUse ? 'status-warning' : 'status-success'));
        const balanceTitle = card.balanceUpdatedAt ? `最近查询：${formatTimeShort(card.balanceUpdatedAt)}` : '';
        const balanceText = card.balance == null
            ? (status === 'PROVIDER_DELETED' ? '<span style="color:var(--error);">上游已删除</span>' : (card.balanceError ? `<span title="${escapeHtml(card.balanceError)}" style="color:var(--error);">${escapeHtml(card.balanceError === '上游未提供单卡余额' ? '上游未返回' : '查询失败')}</span>` : '<span style="color:var(--text-dim);">未查询</span>'))
            : `<span title="${escapeHtml(balanceTitle)}">${Number(card.balance).toFixed(2)} ${escapeHtml(card.balanceCurrency || 'USD')}</span>${card.balanceError ? `<br><small title="${escapeHtml(card.balanceError)}" style="color:var(--error);">${escapeHtml(card.balanceError === '上游未提供单卡余额' ? '上游未提供新余额' : '刷新失败')}</small>` : ''}`;
        const cardDetails = card.cardNumber
            ? `<div class="orbitcard-sensitive-details"><code>${escapeHtml(card.cardNumber)}</code><span>有效期 ${escapeHtml(card.cardExpiry || '-')} · CVC ${escapeHtml(card.cardCvc || '-')}</span>${card.cardHolder ? `<span>持卡人 ${escapeHtml(card.cardHolder)}</span>` : ''}</div>`
            : '<span style="color:var(--text-dim);">未同步完整卡资料</span>';
        const canRestore = status === 'RETIRED' && !card.inUse && Number(card.usageCount || 0) < Number(card.maxUsageCount || 1);
        const planActions = renderOrbitcardPlanActions(card);
        return `<tr>
            <td><code>${escapeHtml(card.cardId)}</code></td>
            <td>${cardDetails}</td>
            <td><code>${escapeHtml(card.cardLast4 || '****')}</code></td>
            <td>${escapeHtml(formatPlanLabel(card.planType))}${card.productCode ? `<br><small class="orbitcard-product-code">${escapeHtml(card.productCode)}</small>` : ''}</td>
            <td style="text-align:center; font-weight:600;">${Number(card.usageCount || 0)}/${Number(card.maxUsageCount || 1)}</td>
            <td>${card.initialAmount == null ? '-' : `${Number(card.initialAmount).toFixed(2)} USD`}</td>
            <td>${balanceText}</td>
            <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
            <td style="min-width:300px; font-size:13px;">${historyHtml}</td>
            <td>${escapeHtml(formatTimeShort(card.lastUsedAt))}</td>
            <td style="text-align:center;"><div class="orbitcard-actions">${planActions}${canRestore ? `<button type="button" class="btn btn-success" style="padding:5px 9px; font-size:12px;" onclick="restoreOrbitcardCard(${Number(card.cardId)})">恢复</button>` : ''}${!planActions && !canRestore ? '<span style="color:var(--text-dim);">-</span>' : ''}</div></td>
        </tr>`;
    }).join('');
    lucide.createIcons();
}

async function loadOrbitcardUsage(showToast = false, refreshBalances = false, page = orbitcardUsageState.page) {
    const tbody = document.getElementById('orbitcard_usage_body');
    if (!tbody) return;
    const requestId = ++orbitcardUsageRequestId;
    orbitcardUsageState.page = Math.max(1, Number(page) || 1);
    try {
        const params = new URLSearchParams({
            page: String(orbitcardUsageState.page),
            page_size: String(orbitcardUsageState.pageSize),
            keyword: orbitcardUsageState.filters.keyword,
            plan_type: orbitcardUsageState.filters.planType,
            card_status: orbitcardUsageState.filters.cardStatus,
            recharge_status: orbitcardUsageState.filters.rechargeStatus
        });
        if (refreshBalances) params.set('refresh', '1');
        const res = await authFetch(`/api/admin/orbitcard/usage?${params.toString()}`);
        const data = await res.json();
        if (requestId !== orbitcardUsageRequestId) return;
        if (!res.ok || !data.success) throw new Error(data.message || '加载 Orbitcard 用卡记录失败');
        orbitcardUsageList = Array.isArray(data.cards) ? data.cards : [];
        orbitcardUsageState.total = Number(data.total || 0);
        orbitcardUsageState.page = Number(data.page || orbitcardUsageState.page);
        if (typeof data.auto_create_card === 'boolean') {
            orbitcardStrategyAutoCreate = data.auto_create_card;
        }
        if (Number.isFinite(Number(data.plus_unit_price))) {
            orbitcardStrategyPlusUnitPrice = Number(data.plus_unit_price);
        }
        const usageHint = document.getElementById('orbitcard_usage_hint');
        if (usageHint && typeof data.auto_create_card === 'boolean') {
            const plusLimit = Number(data.reuse_limits?.plus || orbitcardStrategyReuseLimits.plus || 4);
            const plusMargin = Number(data.safety_margins?.plus ?? orbitcardStrategySafetyMargins.plus ?? 1);
            const modeText = data.auto_create_card
                ? '当前已开启自动开卡（本地无复用卡时将自动调用卡台开卡）。'
                : '当前已关闭自动开卡（仅使用卡台已有卡片；下单缺卡时自动同步新卡，仍无卡则退回 CDK 并推送缺卡告警）。';
            usageHint.textContent = `${modeText} 同步卡台卡片时，未绑定套餐的 ACTIVE 非 4002 新卡将按余额自动推算可充 Plus 次数（兜底单价 ${orbitcardStrategyPlusUnitPrice} USD、安全余量 ${plusMargin} USD、单卡上限 ${plusLimit} 次），绝不覆盖已绑定或 Pro 卡片。`;
        }
        renderOrbitcardUsageTable();
        renderOrbitcardUsagePagination();
        if (showToast) showMessage('Orbitcard 用卡记录已刷新', 'success');
    } catch (error) {
        if (requestId !== orbitcardUsageRequestId) return;
        console.error('loadOrbitcardUsage failed', error);
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--error); padding:36px 0;">${escapeHtml(error.message || '加载失败')}</td></tr>`;
        const pagination = document.getElementById('orbitcard_usage_pagination');
        if (pagination) pagination.innerHTML = '';
        if (showToast) showMessage(error.message || '加载 Orbitcard 记录失败', 'error');
    }
    lucide.createIcons();
}

async function setOrbitcardCardPlan(cardId) {
    const select = document.getElementById(`orbitcard_plan_${Number(cardId)}`);
    const planType = select?.value || '';
    const limitInput = document.getElementById(`orbitcard_limit_${Number(cardId)}`);
    const rawUsageLimit = limitInput?.value.trim() || '';
    if (!planType) {
        showMessage('请先选择套餐', 'warning');
        return;
    }
    if (rawUsageLimit && (!/^\d+$/.test(rawUsageLimit) || Number(rawUsageLimit) < 1 || Number(rawUsageLimit) > 20)) {
        showMessage('单卡使用上限必须是 1-20 的整数', 'warning');
        return;
    }
    const requestBody = { plan_type: planType };
    if (rawUsageLimit) requestBody.max_usage_count = Number(rawUsageLimit);
    try {
        const res = await authFetch(`/api/admin/orbitcard/cards/${encodeURIComponent(cardId)}/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '绑定套餐失败');
        showMessage(data.message || '套餐已绑定', 'success');
        await loadOrbitcardUsage(false, false);
    } catch (error) {
        showMessage(error.message || '绑定套餐失败', 'error');
    }
}

async function restoreOrbitcardCard(cardId) {
    const card = orbitcardUsageList.find((item) => Number(item.cardId) === Number(cardId));
    const balance = card?.balance == null ? '未查询余额' : `${Number(card.balance).toFixed(2)} ${card.balanceCurrency || 'USD'}`;
    const ok = await showAdminConfirm(
        `确认将 Orbitcard 卡 #${cardId} 解冻并恢复可用吗？当前余额：${balance}。请先确认上一次失败未产生扣款。`,
        '恢复 Orbitcard 卡'
    );
    if (!ok) return;
    try {
        const res = await authFetch(`/api/admin/orbitcard/cards/${encodeURIComponent(cardId)}/restore`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '恢复失败');
        showMessage(data.message || '卡片已恢复可用', 'success');
        await loadOrbitcardUsage(false, true);
    } catch (error) {
        showMessage(error.message || '恢复 Orbitcard 卡失败', 'error');
    }
}
