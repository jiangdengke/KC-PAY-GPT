/* global lucide, authFetch, showMessage, showAdminConfirm, escapeHtml, formatTimeShort, redirectToLogin, setAdminLoginPath, ADMIN_LOGIN_EVENT_LABELS */
/* exported updateAdminPathPreview, loadAdminSecurityStatus, saveAdminPaths, saveAdmin2faLoginMode,
   setupAdmin2fa, confirmAdmin2fa, disableAdmin2fa, changeAdminPassword,
   loadAdminLoginLogs, loadIpBans, submitIpBan, removeIpBan, prefillIpBan */
'use strict';

function updateAdminPathPreview() {
    const origin = location.origin;
    const loginSeg = String(document.getElementById('admin_login_path')?.value || '').trim().toLowerCase();
    const panelSeg = String(document.getElementById('admin_panel_path')?.value || '').trim().toLowerCase();
    const loginPreview = document.getElementById('admin_login_path_url');
    const panelPreview = document.getElementById('admin_panel_path_url');
    if (loginPreview) {
        loginPreview.textContent = loginSeg
            ? `完整登录地址：${origin}/${loginSeg.replace(/^\/+/, '')}`
            : '完整登录地址：—';
    }
    if (panelPreview) {
        panelPreview.textContent = panelSeg
            ? `完整后台地址：${origin}/${panelSeg.replace(/^\/+/, '')}`
            : '完整后台地址：—';
    }
}

async function loadAdminSecurityStatus() {
    try {
        const res = await authFetch('/api/admin/security/status');
        const data = await res.json();
        if (!data.success) return;
        const modeEl = document.getElementById('admin_2fa_login_mode');
        if (modeEl && data.login2faMode) {
            modeEl.value = data.login2faMode;
        }
        if (data.loginUrl) {
            setAdminLoginPath(data.loginUrl);
        }
        const loginPathEl = document.getElementById('admin_login_path');
        const panelPathEl = document.getElementById('admin_panel_path');
        if (loginPathEl && data.loginPath) loginPathEl.value = data.loginPath;
        if (panelPathEl && data.panelPath) panelPathEl.value = data.panelPath;
        updateAdminPathPreview();
        const statusEl = document.getElementById('totp_status_text');
        if (statusEl) {
            const available = (data.availableMethods || data.methods || [])
                .map((m) => (m === 'totp' ? 'Google Authenticator' : 'Telegram'))
                .join(' / ') || '未配置';
            const modeLabel = {
                either: '登录时可切换',
                totp: '仅 Google Authenticator',
                telegram: '仅 Telegram'
            }[data.login2faMode] || '登录时可切换';
            statusEl.textContent = `当前账号 ${data.email || '-'} · 2FA: ${data.totpEnabled ? '已启用' : '未启用'} · 已配置: ${available} · 策略: ${modeLabel}`;
        }
    } catch (_) { /* ignore */ }
}

async function saveAdminPaths() {
    const loginPath = document.getElementById('admin_login_path')?.value.trim() || '';
    const panelPath = document.getElementById('admin_panel_path')?.value.trim() || '';
    try {
        const res = await authFetch('/api/admin/security/paths', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loginPath, panelPath })
        });
        const raw = await res.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_) {
            showMessage(res.status === 404 ? '保存接口未就绪，请重启应用后再试' : '服务器响应异常，请重启应用后重试', 'error');
            return;
        }
        if (!res.ok || !data.success) {
            showMessage(data.message || '保存失败', 'error');
            return;
        }
        if (data.loginUrl) setAdminLoginPath(data.loginUrl);
        if (data.loginPath) document.getElementById('admin_login_path').value = data.loginPath;
        if (data.panelPath) document.getElementById('admin_panel_path').value = data.panelPath;
        updateAdminPathPreview();
        showMessage(`${data.message || '入口路径已更新'}。登录：${data.loginUrl || ''} · 后台：${data.panelUrl || ''}`, 'success');
    } catch (error) {
        showMessage(error.message || '保存失败', 'error');
    }
}

async function saveAdmin2faLoginMode() {
    const mode = document.getElementById('admin_2fa_login_mode')?.value || 'either';
    try {
        const res = await authFetch('/api/admin/security/2fa-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const data = await res.json();
        showMessage(data.message || (data.success ? '已保存' : '保存失败'), data.success ? 'success' : 'error');
        await loadAdminSecurityStatus();
    } catch (error) {
        showMessage(error.message || '保存失败', 'error');
    }
}

async function setupAdmin2fa() {
    try {
        const res = await authFetch('/api/admin/2fa/setup', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) {
            showMessage(data.message || '绑定失败', 'error');
            return;
        }
        document.getElementById('totp_setup_box').style.display = 'block';
        const qrImg = document.getElementById('totp_qr_img');
        if (qrImg) {
            if (data.qrCodeUrl) {
                qrImg.src = data.qrCodeUrl;
                qrImg.style.display = 'block';
            } else {
                qrImg.removeAttribute('src');
                qrImg.style.display = 'none';
            }
        }
        document.getElementById('totp_secret_text').innerHTML = `
            <div style="margin-bottom:6px;">请用 Google Authenticator 扫描上方二维码</div>
            <div>手动密钥：<code style="word-break:break-all;">${escapeHtml(data.secret || '')}</code></div>
        `;
        showMessage('扫码后输入 6 位验证码确认启用', 'success');
    } catch (error) {
        showMessage(error.message || '绑定失败', 'error');
    }
}

async function confirmAdmin2fa() {
    const code = document.getElementById('totp_confirm_code').value.trim();
    try {
        const res = await authFetch('/api/admin/2fa/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        showMessage(data.message || (data.success ? '已启用' : '失败'), data.success ? 'success' : 'error');
        if (data.success) {
            document.getElementById('totp_setup_box').style.display = 'none';
            await loadAdminSecurityStatus();
        }
    } catch (error) {
        showMessage(error.message || '确认失败', 'error');
    }
}

async function disableAdmin2fa() {
    const currentPassword = document.getElementById('current_password').value;
    const code = prompt('若已启用 Authenticator，请输入当前 6 位验证码（未启用可留空）') || '';
    if (!currentPassword) {
        showMessage('请先在上方填写原登录密码', 'warning');
        return;
    }
    try {
        const res = await authFetch('/api/admin/2fa/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, code })
        });
        const data = await res.json();
        showMessage(data.message || (data.success ? '已关闭' : '失败'), data.success ? 'success' : 'error');
        await loadAdminSecurityStatus();
    } catch (error) {
        showMessage(error.message || '关闭失败', 'error');
    }
}

async function changeAdminPassword(evt) {
    const btn = evt?.currentTarget || null;
    const originalContent = btn ? btn.innerHTML : '';
    const currentPassword = document.getElementById('current_password').value;
    const newPassword = document.getElementById('new_password').value.trim();

    if (!currentPassword) {
        showMessage('请输入原密码', 'warning');
        return;
    }
    if (newPassword.length < 6) {
        showMessage('新密码至少 6 位', 'warning');
        return;
    }

    if (btn) {
        btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 提交中...';
        lucide.createIcons();
    }

    try {
        const res = await authFetch('/api/admin/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.message || '修改失败');
        }
        document.getElementById('current_password').value = '';
        document.getElementById('new_password').value = '';
        showMessage(data.message, 'success');
        redirectToLogin();
    } catch (error) {
        showMessage(error.message || '修改失败', 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalContent;
            lucide.createIcons();
        }
    }
}

async function loadAdminLoginLogs() {
    try {
        const res = await authFetch('/api/admin/login-logs?limit=100');
        const data = await res.json();
        const body = document.getElementById('admin_login_logs_body');
        if (!body) return;
        const logs = data.logs || [];
        if (!logs.length) {
            body.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-dim);">暂无记录</td></tr>';
            return;
        }
        body.innerHTML = logs.map((row) => {
            const eventKey = String(row.event || '');
            const eventLabel = ADMIN_LOGIN_EVENT_LABELS[eventKey] || eventKey || '-';
            const eventBadgeClass = eventKey === 'login_success'
                ? 'status-success'
                : (['login_failed', '2fa_failed', 'secondary_failed'].includes(eventKey)
                    ? 'status-failed'
                    : (eventKey === 'password_changed' ? 'status-warning' : 'status-running'));
            return `
            <tr>
                <td style="white-space:nowrap; font-size:12.5px; color:var(--text-dim);">${escapeHtml(formatTimeShort(row.created_at))}</td>
                <td style="text-align:center;"><span class="status-badge ${eventBadgeClass}">${escapeHtml(eventLabel)}</span></td>
                <td style="font-size:13px;">${escapeHtml(String(row.admin_email || '-'))}</td>
                <td><div class="security-ip-cell"><code>${escapeHtml(String(row.ip || '-'))}</code>${row.ip ? `<button type="button" class="btn btn-secondary" style="padding:2px 8px; font-size:11.5px;" data-ban-ip="${escapeHtml(String(row.ip))}" title="填入上方封禁表单">封禁</button>` : ''}</div></td>
                <td title="${escapeHtml(String(row.fingerprint || ''))}"><code>${escapeHtml(String(row.fingerprint || '-').slice(0, 14))}</code></td>
                <td><span class="security-ua-cell" title="${escapeHtml(String(row.user_agent || ''))}">${escapeHtml(String(row.user_agent || '-'))}</span></td>
                <td style="font-size:12.5px; color:var(--text-secondary);">${escapeHtml(String(row.detail || '-'))}</td>
            </tr>`;
        }).join('');
    } catch (error) {
        showMessage(error.message || '加载登录日志失败', 'error');
    }
}

async function loadIpBans() {
    const body = document.getElementById('ip_ban_body');
    if (!body) return;
    try {
        const res = await authFetch('/api/admin/ip-bans');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '加载封禁列表失败');
        const yourIp = document.getElementById('ip_ban_your_ip');
        if (yourIp) {
            const tor = data.tor || {};
            yourIp.textContent = `你当前的 IP：${data.yourIp || '未知'}（包含它的网段不能封禁）｜生效规则 ${Number(data.activeCount || 0)} 条｜Tor 出口节点 ${Number(tor.count || 0)} 个已整站拦截，本次启动后拦截 ${Number(tor.hits || 0)} 次`;
        }
        const bans = data.bans || [];
        if (!bans.length) {
            body.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-dim);">暂无封禁</td></tr>';
            return;
        }
        body.innerHTML = bans.map((ban) => `
            <tr style="${ban.active ? '' : 'opacity:0.55;'}">
                <td><code>${escapeHtml(ban.cidr)}</code></td>
                <td><span class="status-badge ${ban.source === 'auto' ? 'status-warning' : 'status-running'}" style="white-space:nowrap;">${ban.source === 'auto' ? '自动' : '手动'}</span></td>
                <td title="${escapeHtml(ban.reason)}">${escapeHtml(ban.reason.slice(0, 40))}</td>
                <td>${Number(ban.hits || 0)}</td>
                <td>${escapeHtml(formatTimeShort(ban.createdAt))}</td>
                <td>${ban.expiresAt ? escapeHtml(formatTimeShort(ban.expiresAt)) + (ban.active ? '' : '（已过期）') : '永久'}</td>
                <td style="text-align:center"><button type="button" class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" data-unban-id="${Number(ban.id)}" data-unban-cidr="${escapeHtml(ban.cidr)}">解封</button></td>
            </tr>
        `).join('');
    } catch (error) {
        body.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--error);">${escapeHtml(error.message || '加载失败')}</td></tr>`;
    }
}

async function submitIpBan() {
    const cidr = document.getElementById('ip_ban_cidr')?.value.trim() || '';
    const reason = document.getElementById('ip_ban_reason')?.value.trim() || '';
    const duration = document.getElementById('ip_ban_duration')?.value || '7d';
    if (!cidr) {
        showMessage('请填写要封禁的 IP 或网段', 'warning');
        return;
    }
    try {
        const res = await authFetch('/api/admin/ip-bans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cidr, reason, duration })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '封禁失败');
        document.getElementById('ip_ban_cidr').value = '';
        document.getElementById('ip_ban_reason').value = '';
        showMessage(data.message || '已封禁', 'success');
        await loadIpBans();
    } catch (error) {
        showMessage(error.message || '封禁失败', 'error');
    }
}

async function removeIpBan(id, cidr) {
    if (!(await showAdminConfirm(`确定解封 ${cidr}？`, '解除 IP 封禁'))) return;
    try {
        const res = await authFetch(`/api/admin/ip-bans/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || '解封失败');
        showMessage(data.message || '已解封', 'success');
        await loadIpBans();
    } catch (error) {
        showMessage(error.message || '解封失败', 'error');
    }
}

function prefillIpBan(ip) {
    const input = document.getElementById('ip_ban_cidr');
    if (!input) return;
    input.value = ip.includes(':') ? `${ip}/48` : ip;
    const reason = document.getElementById('ip_ban_reason');
    if (reason && !reason.value) reason.value = '后台登录失败';
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus();
}

document.addEventListener('click', (event) => {
    const banBtn = event.target.closest('[data-ban-ip]');
    if (banBtn) {
        event.preventDefault();
        prefillIpBan(banBtn.getAttribute('data-ban-ip') || '');
        return;
    }
    const unbanBtn = event.target.closest('[data-unban-id]');
    if (unbanBtn) {
        event.preventDefault();
        removeIpBan(unbanBtn.getAttribute('data-unban-id'), unbanBtn.getAttribute('data-unban-cidr') || '');
    }
});
