/* global lucide, authFetch, readApiJson, showMessage, loadData, CANONICAL_PLAN_TYPES, PLAN_LABELS */
/* exported applySystemConfigFromData, reloadSystemConfigFromServer, updateMaintenanceModeUI,
   saveMaintenanceMode, saveAllConfigs, loadTelegramConfig, saveTelegramConfig, testTelegramNotification,
   loadGptApiConfig, updateOrbitcardConfigVisibility, saveGptApiConfig, refreshGptApiStatus, testGptApiConnection */
'use strict';

let maintenanceModeSaving = false;
let lastMaintenanceModeValue = false;

function buildConfigPayload(overrides = {}) {
    return {
        max_concurrent_activations: Math.max(1, parseInt(document.getElementById('max_concurrent_activations')?.value, 10) || 1),
        maintenance_mode: Object.prototype.hasOwnProperty.call(overrides, 'maintenance_mode')
            ? Boolean(overrides.maintenance_mode)
            : Boolean(document.getElementById('maintenance_mode')?.checked)
    };
}

function updateMaintenanceModeUI(config = {}, runtime = {}) {
    const checkbox = document.getElementById('maintenance_mode');
    const hint = document.getElementById('maintenance_mode_hint');
    if (!checkbox || !hint) return;

    const enabled = Boolean(config.maintenance_mode);
    const drain = Boolean(config.maintenance_mode_drain);
    const activeJobs = Math.max(0, Number(runtime.active_activation_jobs || 0));
    const isPendingEnable = enabled && drain && activeJobs > 0;

    checkbox.checked = isPendingEnable ? false : enabled;
    checkbox.disabled = maintenanceModeSaving || isPendingEnable;

    if (isPendingEnable) {
        hint.textContent = `维护模式待开启，当前还有 ${activeJobs} 个任务在运行；新请求已拒绝，待现有任务全部完成后将自动开启`;
    } else if (enabled) {
        hint.textContent = '维护模式已开启，当前拒绝所有新任务';
    } else {
        hint.textContent = '开启后立即拒绝所有新任务';
    }
}

async function saveMaintenanceMode() {
    const checkbox = document.getElementById('maintenance_mode');
    const nextValue = Boolean(checkbox?.checked);
    maintenanceModeSaving = true;
    updateMaintenanceModeUI(
        {
            maintenance_mode: nextValue,
            maintenance_mode_drain: nextValue && Number(window.__adminRuntime?.active_activation_jobs || 0) > 0
        },
        window.__adminRuntime
    );

    try {
        const res = await authFetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildConfigPayload({ maintenance_mode: nextValue }))
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '维护模式保存失败');
        lastMaintenanceModeValue = nextValue;
        showMessage(data.message, 'success');
        await loadData(true);
    } catch (error) {
        if (checkbox) checkbox.checked = lastMaintenanceModeValue;
        showMessage(error.message || '维护模式保存失败', 'error');
        await loadData(true);
    } finally {
        maintenanceModeSaving = false;
        updateMaintenanceModeUI(
            {
                maintenance_mode: document.getElementById('maintenance_mode')?.checked,
                maintenance_mode_drain: Boolean(document.getElementById('maintenance_mode')?.checked)
                    && Number(window.__adminRuntime?.active_activation_jobs || 0) > 0
            },
            window.__adminRuntime
        );
    }
}

async function saveAllConfigs(evt) {
    const btn = evt?.currentTarget || null;
    const originalContent = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 处理中...';
        lucide.createIcons();
    }
    try {
        const res = await authFetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildConfigPayload())
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '保存失败');
        showMessage(data.message, 'success');
        await loadData(true);
    } catch (error) {
        showMessage(error.message || '保存失败', 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalContent;
            lucide.createIcons();
        }
    }
}

function loadTelegramConfig(telegram) {
    const cfg = telegram || {};
    const setValue = (id, value, placeholder) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = value ?? '';
        if (placeholder !== undefined) el.placeholder = placeholder;
    };
    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = Boolean(value);
    };
    const tokenPlaceholder = cfg.bot_token
        ? `已保存（${cfg.bot_token.slice(0, 10)}…）留空不修改`
        : '123456789:ABCdefGHI...';
    setValue('telegram_bot_token', '', tokenPlaceholder);
    setValue('telegram_admin_chat_id', cfg.admin_chat_id || '');
    setValue('telegram_group_chat_id', cfg.group_chat_id || '');
    setChecked('telegram_notify_admin', cfg.notify_admin);
    setChecked('telegram_notify_group', cfg.notify_group);
    setChecked('telegram_on_success', cfg.on_success);
    setChecked('telegram_on_failure', cfg.on_failure);
    setChecked('telegram_on_card_pool_empty', cfg.on_card_pool_empty);
}

function buildTelegramPayload() {
    return {
        bot_token: document.getElementById('telegram_bot_token')?.value.trim() || '',
        admin_chat_id: document.getElementById('telegram_admin_chat_id')?.value.trim() || '',
        group_chat_id: document.getElementById('telegram_group_chat_id')?.value.trim() || '',
        notify_admin: Boolean(document.getElementById('telegram_notify_admin')?.checked),
        notify_group: Boolean(document.getElementById('telegram_notify_group')?.checked),
        on_success: Boolean(document.getElementById('telegram_on_success')?.checked),
        on_failure: Boolean(document.getElementById('telegram_on_failure')?.checked),
        on_card_pool_empty: Boolean(document.getElementById('telegram_on_card_pool_empty')?.checked)
    };
}

async function saveTelegramConfig() {
    try {
        const res = await authFetch('/api/admin/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildTelegramPayload())
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '保存失败');
        showMessage(data.message, 'success');
        await reloadSystemConfigFromServer();
    } catch (error) {
        showMessage(error.message || 'Telegram 配置保存失败', 'error');
    }
}

async function testTelegramNotification() {
    try {
        const res = await authFetch('/api/admin/telegram/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '测试失败');
        showMessage(data.message, 'success');
    } catch (error) {
        showMessage(error.message || 'Telegram 测试失败', 'error');
    }
}

function applySystemConfigFromData(data) {
    const cfg = data?.config || {};
    const maxConcurrentEl = document.getElementById('max_concurrent_activations');
    if (maxConcurrentEl) {
        maxConcurrentEl.value = cfg.max_concurrent_activations || 1;
    }
    loadTelegramConfig(data.telegram || {});
    lastMaintenanceModeValue = Boolean(cfg.maintenance_mode);
    updateMaintenanceModeUI(cfg, window.__adminRuntime || { active_activation_jobs: 0 });
}

async function reloadSystemConfigFromServer() {
    const res = await authFetch('/api/admin/data');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '加载系统配置失败');
    applySystemConfigFromData(data);
    return data;
}

// ─── 第三方代充 API 配置 ─────────────────────────────────────────────────────

function updateOrbitcardConfigVisibility() {
    const source = document.getElementById('gpt_api_card_source')?.value || 'local';
    const fields = document.getElementById('orbitcard_config_fields');
    if (fields) fields.style.display = source === 'orbitcard' ? 'block' : 'none';
}

function buildGptApiPayload() {
    return {
        enabled: Boolean(document.getElementById('gpt_api_enabled')?.checked),
        base_url: document.getElementById('gpt_api_base_url')?.value.trim() || '',
        api_key: document.getElementById('gpt_api_key')?.value.trim() || '',
        plan_key: document.getElementById('gpt_api_plan_key')?.value.trim() || '',
        plan_mappings: Object.fromEntries(CANONICAL_PLAN_TYPES.map((planType) => [
            planType,
            document.getElementById(planType === 'plus' ? 'gpt_api_plan_key' : `gpt_api_plan_key_${planType}`)?.value.trim() || ''
        ])),
        card_source: document.getElementById('gpt_api_card_source')?.value || 'local',
        payment_region: document.getElementById('gpt_api_payment_region')?.value.trim().toUpperCase() || '',
        orbitcard_base_url: document.getElementById('orbitcard_base_url')?.value.trim() || '',
        orbitcard_api_key: document.getElementById('orbitcard_api_key')?.value.trim() || '',
        orbitcard_api_secret: document.getElementById('orbitcard_api_secret')?.value.trim() || ''
    };
}

function renderGptApiStatus(data) {
    const balance = data.balance || {};
    document.getElementById('gpt_api_credits').textContent = balance.availablePoints ?? balance.credits ?? '—';
    document.getElementById('gpt_api_balance_usd').textContent = balance.balance_usd
        ? `$${balance.balance_usd}`
        : (balance.balance != null ? `${balance.balance} cents` : '—');
    const gptPlans = (data.gpt_plans || []).filter((p) => p.enabled !== 0 && p.enabled !== false);
    const mappings = data.plan_mappings || {};
    document.getElementById('gpt_api_plans').textContent = Object.keys(mappings).length
        ? CANONICAL_PLAN_TYPES.map((planType) => `${PLAN_LABELS[planType]}=${mappings[planType] || '未配置'}`).join('、')
        : (gptPlans.length
            ? gptPlans.map((p) => `${p.name || p.key} (${p.key || '—'})`).join('、')
            : (data.configured_plan ? `已配置代码：${data.configured_plan}` : '供应商未提供套餐列表'));
    const creditPlans = data.credit_plans || [];
    document.getElementById('gpt_api_credit_plans').textContent = creditPlans.length
        ? creditPlans.map((p) => `${p.name || p.id}: ${p.credits ?? '—'} 积分`).join('、')
        : '无';
    document.getElementById('gpt_api_status_hint').textContent = data.balance_error
        ? `积分查询失败：${data.balance_error}`
        : `${data.card_source_message || (data.card_source?.source === 'orbitcard' ? `Orbitcard 可用卡 ${data.card_source.cardCount ?? '—'} 张` : '卡源：本地卡池')}；${data.account
            ? `账户：${data.account.email || data.account.accountName || '—'}；数据来自供应商账户接口，完整卡密不会由接口回传。`
            : '数据来自供应商账户接口；完整卡密不会由接口回传。'}`;
}

async function refreshGptApiStatus() {
    try {
        const res = await authFetch('/api/admin/gpt-api/status');
        const data = await readApiJson(res, '状态查询失败');
        if (!res.ok || !data.success) throw new Error(data.message || '状态查询失败');
        renderGptApiStatus(data);
    } catch (error) {
        const hint = document.getElementById('gpt_api_status_hint');
        if (hint) hint.textContent = error.message || '状态查询失败';
    }
    lucide.createIcons();
}

async function loadGptApiConfig() {
    try {
        const res = await authFetch('/api/admin/gpt-api');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '加载 API 配置失败');
        const cfg = data.config || {};
        const enabledEl = document.getElementById('gpt_api_enabled');
        if (enabledEl) enabledEl.checked = Boolean(cfg.enabled);
        const baseUrlEl = document.getElementById('gpt_api_base_url');
        if (baseUrlEl) baseUrlEl.value = cfg.base_url || '';
        const keyEl = document.getElementById('gpt_api_key');
        const keyHint = document.getElementById('gpt_api_key_hint');
        const cardSourceEl = document.getElementById('gpt_api_card_source');
        const paymentRegionEl = document.getElementById('gpt_api_payment_region');
        const orbitBaseEl = document.getElementById('orbitcard_base_url');
        const orbitKeyEl = document.getElementById('orbitcard_api_key');
        const orbitKeyHint = document.getElementById('orbitcard_api_key_hint');
        const orbitSecretEl = document.getElementById('orbitcard_api_secret');
        const orbitSecretHint = document.getElementById('orbitcard_api_secret_hint');
        if (keyEl) {
            keyEl.value = '';
            keyEl.placeholder = cfg.api_key_saved
                ? `已保存（${cfg.api_key_preview || 'ap_live_…'}）留空不修改`
                : 'ap_live_...';
        }
        const mappings = cfg.plan_mappings || {};
        for (const planType of CANONICAL_PLAN_TYPES) {
            const id = planType === 'plus' ? 'gpt_api_plan_key' : `gpt_api_plan_key_${planType}`;
            const input = document.getElementById(id);
            if (input) input.value = mappings[planType] || (planType === 'plus' ? cfg.plan_key || 'chatgptplusplan' : '');
        }
        if (cardSourceEl) cardSourceEl.value = cfg.card_source || 'local';
        if (paymentRegionEl) paymentRegionEl.value = cfg.payment_region || '';
        if (orbitBaseEl) orbitBaseEl.value = cfg.orbitcard_base_url || 'https://orbitcard.cc';
        if (orbitKeyEl) orbitKeyEl.value = '';
        if (orbitKeyHint) orbitKeyHint.textContent = cfg.orbitcard_api_key_saved ? `✓ API Key 已保存（${cfg.orbitcard_api_key_preview || '已隐藏'}）` : '尚未配置 Orbitcard API Key';
        if (orbitSecretEl) {
            orbitSecretEl.value = '';
            orbitSecretEl.placeholder = cfg.orbitcard_api_secret_configured ? `已保存（${cfg.orbitcard_api_secret_preview || '已隐藏'}）留空不修改` : '填写 Orbitcard Secret';
        }
        if (orbitSecretHint) {
            orbitSecretHint.textContent = cfg.orbitcard_api_secret_configured ? '✓ Orbitcard Secret 已保存，留空不修改' : '尚未配置 Orbitcard Secret';
        }
        updateOrbitcardConfigVisibility();
        if (keyHint) keyHint.textContent = cfg.api_key_saved ? '✓ API Key 已保存' : '尚未配置 API Key';
        if (cfg.api_key_saved) refreshGptApiStatus();
    } catch (e) {
        console.error('loadGptApiConfig failed', e);
    }
}

async function saveGptApiConfig() {
    try {
        const res = await authFetch('/api/admin/gpt-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildGptApiPayload())
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '保存失败');
        showMessage(data.message, 'success');
        await loadGptApiConfig();
    } catch (error) {
        showMessage(error.message || '第三方代充 API 配置保存失败', 'error');
    }
}

async function testGptApiConnection() {
    const payload = buildGptApiPayload();
    const hasSavedKey = Boolean(document.getElementById('gpt_api_key_hint')?.textContent.includes('已保存'));
    if (!payload.api_key && !hasSavedKey) {
        showMessage('请先填写并保存 API Key', 'warning');
        return;
    }
    try {
        const res = await authFetch('/api/admin/gpt-api/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await readApiJson(res, 'API 连接测试失败');
        if (!res.ok || !data.success) throw new Error(data.message || '连接失败');
        showMessage(data.message, 'success');
        await refreshGptApiStatus();
    } catch (error) {
        showMessage(error.message || 'API 连接测试失败', 'error');
    }
}
