        const TOKEN_KEY = 'plus_admin_token';
        let adminLoginPath = '/admin-login';
        const BUSINESS_PAGES = new Set(['checkout_debug', 'cards', 'cdks', 'sessions', 'billing']);
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

        let phonePool = [];
        let cardPool = [];
        let cdkPool = [];
        let productPool = [];
        let poolEmailsList = [];
        const selectedItems = {
            phone_pool: new Set(),
            card_pool: new Set(),
            cdk: new Set(),
            product: new Set()
        };
        const tableFilters = {
            phone_pool: 'all',
            card_pool: 'all',
            cdk: 'all',
            product: 'all'
        };
        const tableSearch = {
            cdk: '',
            product: ''
        };
        let adminRefreshTimer = null;
        let uptimeTickTimer = null;
        let uptimeBaseSeconds = 0;
        let uptimeBaseAt = 0;
        window.__adminLogs = [];
        window.__adminRuntime = { active_activation_jobs: 0 };
        let maintenanceModeSaving = false;
        let lastMaintenanceModeValue = false;

        const paginationState = {
            phone_pool: { page: 1, pageSize: 10 },
            card_pool: { page: 1, pageSize: 10 },
            cdk: { page: 1, pageSize: 12 },
            product: { page: 1, pageSize: 12 },
            log: { page: 1, pageSize: 12 },
            session: { page: 1, pageSize: 12 }
        };

        const RUNTIME_LOG_TEXT_CAP = 1_200_000;
        let runtimeLogPollTimer = null;
        let runtimeLogAfter = 0;
        let runtimeLogText = '';

        /** 后台定时 loadData（含任务管理列表）；为便于阅读可暂停 */
        let adminDataRefreshPaused = false;
        let adminDataRefreshTimer = null;

        /** 当前成品批量生产 WebSocket 对应的 jobKey，用于「停止生产」 */
        window.__adminProductGenJobKey = '';

        function formatRuntimeLogTs(ts) {
            try {
                const d = new Date(Number(ts) || 0);
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                const ss = String(d.getSeconds()).padStart(2, '0');
                return `${hh}:${mm}:${ss}`;
            } catch (_) {
                return '--:--:--';
            }
        }

        const RUNTIME_LOG_SOURCE_MAP = {
            'fork/register_openai.js': '注册',
            'fork/oauth_login.js': '协议',
            'fork/index.js': '结账',
            'product': '流程',
            'task': '任务',
            'server': '服务',
            'system': '系统'
        };

        function formatRuntimeLogSource(entry) {
            const raw = String(entry.source || entry.level || '').trim();
            if (RUNTIME_LOG_SOURCE_MAP[raw]) {
                return RUNTIME_LOG_SOURCE_MAP[raw];
            }
            // 兜底：fork/xxx.js → 提取文件名前 6 个字符
            const forkMatch = raw.match(/^fork\/([\w.-]+)$/);
            if (forkMatch) {
                return forkMatch[1].replace(/\.js$/, '').slice(0, 8);
            }
            return raw.slice(0, 8);
        }

        function formatRuntimeLogJob(jobKey) {
            const k = String(jobKey || '').trim();
            if (!k) {
                return '—';
            }
            // 取末 8 位作为短码
            return k.slice(-8);
        }

        function formatRuntimeLogLine(entry) {
            const t = formatRuntimeLogTs(entry.ts);
            const j = formatRuntimeLogJob(entry.jobKey);
            const src = formatRuntimeLogSource(entry);
            return `${t}  ${j}  ${src}  ${entry.text}`;
        }

        function appendRuntimeLogEntries(entries) {
            if (!entries || entries.length === 0) {
                return;
            }
            const chunk = entries.map(formatRuntimeLogLine).join('\n') + '\n';
            runtimeLogText += chunk;
            if (runtimeLogText.length > RUNTIME_LOG_TEXT_CAP) {
                runtimeLogText = runtimeLogText.slice(-Math.floor(RUNTIME_LOG_TEXT_CAP * 0.85));
            }
            const pre = document.getElementById('runtime_log_pre');
            if (!pre) {
                return;
            }
            pre.textContent = runtimeLogText;
            const autoscroll = document.getElementById('runtime_log_autoscroll');
            const wrap = pre.parentElement;
            if (autoscroll && autoscroll.checked && wrap) {
                wrap.scrollTop = wrap.scrollHeight;
            }
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
            if (!data.success) {
                throw new Error(data.message || '加载失败');
            }
            runtimeLogText = (data.entries || []).map(formatRuntimeLogLine).join('\n');
            if (runtimeLogText) {
                runtimeLogText += '\n';
            }
            runtimeLogAfter = Number(data.nextAfter || 0);
            const pre = document.getElementById('runtime_log_pre');
            if (pre) {
                pre.textContent = runtimeLogText;
                const wrap = pre.parentElement;
                const autoscroll = document.getElementById('runtime_log_autoscroll');
                if (autoscroll && autoscroll.checked && wrap) {
                    wrap.scrollTop = wrap.scrollHeight;
                }
            }
        }

        async function fetchRuntimeLogsIncremental() {
            const pause = document.getElementById('runtime_log_pause');
            if (pause && pause.checked) {
                return;
            }
            try {
                const res = await authFetch(`/api/admin/runtime-logs?after=${runtimeLogAfter}&limit=1000`);
                const data = await res.json();
                if (!data.success || !data.entries || data.entries.length === 0) {
                    if (data.success && data.nextAfter != null) {
                        runtimeLogAfter = Number(data.nextAfter);
                    }
                    return;
                }
                appendRuntimeLogEntries(data.entries);
                runtimeLogAfter = Number(data.nextAfter || runtimeLogAfter);
            } catch (_) {
                /* 静默失败，下一轮再试 */
            }
        }

        function startRuntimeLogStream() {
            stopRuntimeLogStream();
            fetchRuntimeLogsTail().catch(() => { });
            runtimeLogPollTimer = setInterval(() => {
                fetchRuntimeLogsIncremental();
            }, 2000);
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

        function updateAdminDataRefreshButton() {
            const btn = document.getElementById('admin_refresh_pause_btn');
            const label = document.getElementById('admin_refresh_pause_label');
            if (!btn || !label) {
                return;
            }
            const paused = adminDataRefreshPaused;
            label.textContent = paused ? '恢复自动刷新' : '停止自动刷新';
            const iconName = paused ? 'play' : 'pause';
            const icon = btn.querySelector('i[data-lucide]');
            if (icon) {
                icon.setAttribute('data-lucide', iconName);
            }
            btn.classList.toggle('btn-success', !paused);
            btn.classList.toggle('btn-secondary', paused);
            lucide.createIcons();
        }

        function toggleAdminDataRefresh() {
            adminDataRefreshPaused = !adminDataRefreshPaused;
            updateAdminDataRefreshButton();
            showMessage(
                adminDataRefreshPaused
                    ? '已停止自动刷新：概览与各列表（含任务管理）不再每 3 秒更新'
                    : '已恢复每 3 秒自动刷新',
                'success'
            );
        }

        async function manualRefreshAdminData() {
            try {
                await loadData(false);
                await loadTaskLogs(false);
                showMessage('数据已刷新', 'success');
            } catch (error) {
                showMessage(error.message || '刷新失败', 'error');
            }
            lucide.createIcons();
        }

        async function stopAdminProductBatch(opts = {}) {
            const useCurrent = Boolean(opts.useCurrentJob);
            const jobKey = useCurrent ? String(window.__adminProductGenJobKey || '').trim() : '';
            try {
                const res = await authFetch('/api/admin/products/generate-stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(jobKey ? { jobKey } : {})
                });
                const raw = await res.text();
                let data = {};
                if (raw) {
                    try {
                        data = JSON.parse(raw);
                    } catch (_) {
                        /* 非 JSON（如 404 返回 HTML） */
                    }
                }
                if (!res.ok) {
                    const hint =
                        res.status === 404
                            ? '接口不存在，请部署含「停止成品批量」的后端并重启 Node 服务'
                            : '';
                    throw new Error(data.message || hint || `请求失败（${res.status}）`);
                }
                if (data && data.success === false) {
                    throw new Error(data.message || '操作失败');
                }
                const n = Number(data.stopped || 0);
                showMessage(data.message || '操作完成', n > 0 ? 'success' : 'warning');
            } catch (e) {
                showMessage(e.message || '停止失败', 'error');
            }
            lucide.createIcons();
        }

        function setProductGenStopVisible(visible) {
            const stopBtn = document.getElementById('product_gen_stop_btn');
            if (stopBtn) {
                stopBtn.style.display = visible ? 'inline-flex' : 'none';
            }
        }

        async function clearRuntimeLogs() {
            const ok = await showAdminConfirm(
                '确定清空当前内存中的运行日志？（不影响任务管理数据库表）',
                '清空运行日志'
            );
            if (!ok) {
                return;
            }
            try {
                const res = await authFetch('/api/admin/runtime-logs/clear', { method: 'POST' });
                const data = await res.json();
                if (!data.success) {
                    throw new Error(data.message || '清空失败');
                }
                runtimeLogText = '';
                runtimeLogAfter = 0;
                const pre = document.getElementById('runtime_log_pre');
                if (pre) {
                    pre.textContent = '';
                }
                await fetchRuntimeLogsTail();
                showMessage(data.message || '已清空', 'success');
            } catch (error) {
                showMessage(error.message || '清空失败', 'error');
            }
            lucide.createIcons();
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

        function renderUptimeTick() {
            const currentSeconds = uptimeBaseSeconds + Math.max(0, Math.floor((Date.now() - uptimeBaseAt) / 1000));
            document.getElementById('stat_uptime_text').innerText = formatDurationText(currentSeconds);
        }

        function getCurrentUptimeSeconds() {
            if (!uptimeBaseAt) {
                return 0;
            }
            return uptimeBaseSeconds + Math.max(0, Math.floor((Date.now() - uptimeBaseAt) / 1000));
        }

        function startUptimeTicker(baseSeconds) {
            const nextBaseSeconds = Math.max(0, Math.floor(Number(baseSeconds) || 0));
            const currentSeconds = getCurrentUptimeSeconds();
            if (uptimeBaseAt && nextBaseSeconds <= currentSeconds) {
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

        function redirectToLogin() {
            clearAdminToken();
            location.href = adminLoginPath;
        }

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
            const response = await fetch(url, { ...options, headers });
            if (response.status === 401) {
                redirectToLogin();
                throw new Error('登录已失效');
            }
            return response;
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
                    adminLoginPath = data.loginUrl;
                }
                const loginPathEl = document.getElementById('admin_login_path');
                const panelPathEl = document.getElementById('admin_panel_path');
                if (loginPathEl && data.loginPath) {
                    loginPathEl.value = data.loginPath;
                }
                if (panelPathEl && data.panelPath) {
                    panelPathEl.value = data.panelPath;
                }
                updateAdminPathPreview();
                const statusEl = document.getElementById('totp_status_text');
                if (statusEl) {
                    const available = (data.availableMethods || data.methods || [])
                        .map((m) => m === 'totp' ? 'Google Authenticator' : 'Telegram')
                        .join(' / ') || '未配置';
                    const modeLabel = {
                        either: '登录时可切换',
                        totp: '仅 Google Authenticator',
                        telegram: '仅 Telegram'
                    }[data.login2faMode] || '登录时可切换';
                    statusEl.textContent = `当前账号 ${data.email || '-'} · 2FA: ${data.totpEnabled ? '已启用' : '未启用'} · 已配置: ${available} · 策略: ${modeLabel}`;
                }
            } catch (_) { }
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
                    showMessage(
                        res.status === 404
                            ? '保存接口未就绪，请重启应用后再试'
                            : '服务器响应异常，请重启应用后重试',
                        'error'
                    );
                    return;
                }
                if (!res.ok || !data.success) {
                    showMessage(data.message || '保存失败', 'error');
                    return;
                }
                if (data.loginUrl) {
                    adminLoginPath = data.loginUrl;
                }
                if (data.loginPath) {
                    document.getElementById('admin_login_path').value = data.loginPath;
                }
                if (data.panelPath) {
                    document.getElementById('admin_panel_path').value = data.panelPath;
                }
                updateAdminPathPreview();
                showMessage(
                    `${data.message || '入口路径已更新'}。登录：${data.loginUrl || ''} · 后台：${data.panelUrl || ''}`,
                    'success'
                );
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
                    qrImg.src = data.qrCodeUrl || `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data.otpauthUrl || '')}`;
                    qrImg.style.display = 'block';
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
                body.innerHTML = logs.map((row) => `
                    <tr>
                        <td>${escapeHtml(String(row.created_at || ''))}</td>
                        <td>${escapeHtml(ADMIN_LOGIN_EVENT_LABELS[row.event] || row.event || '')}</td>
                        <td>${escapeHtml(String(row.admin_email || ''))}</td>
                        <td>${escapeHtml(String(row.ip || ''))}</td>
                        <td title="${escapeHtml(String(row.fingerprint || ''))}">${escapeHtml(String(row.fingerprint || '').slice(0, 16))}</td>
                        <td title="${escapeHtml(String(row.user_agent || ''))}">${escapeHtml(String(row.user_agent || '').slice(0, 40))}</td>
                        <td>${escapeHtml(String(row.detail || ''))}</td>
                    </tr>
                `).join('');
            } catch (error) {
                showMessage(error.message || '加载登录日志失败', 'error');
            }
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

        function renderStatus(status) {
            const cfg = statusMap[status] || { class: '', label: String(status || '').toUpperCase() };
            return `<span class="status-badge ${cfg.class}">${cfg.label || String(status || '').toUpperCase()}</span>`;
        }

        document.addEventListener('click', (event) => {
            const deleteBtn = event.target.closest('[data-delete-task]');
            if (deleteBtn) {
                event.preventDefault();
                deleteAdminTaskLog(deleteBtn.getAttribute('data-delete-task') || '');
                return;
            }
            const viewSessionBtn = event.target.closest('[data-view-session]');
            if (viewSessionBtn) {
                event.preventDefault();
                openSessionModal(viewSessionBtn.getAttribute('data-view-session') || '');
                return;
            }
            const viewTaskLogBtn = event.target.closest('[data-view-task-log]');
            if (viewTaskLogBtn) {
                event.preventDefault();
                openTaskLogModal(viewTaskLogBtn.getAttribute('data-view-task-log') || '');
                return;
            }
            const copySessionBtn = event.target.closest('[data-copy-session]');
            if (copySessionBtn) {
                event.preventDefault();
                copySessionByJobKey(copySessionBtn.getAttribute('data-copy-session') || '');
                return;
            }
            const exportSessionBtn = event.target.closest('[data-export-session]');
            if (exportSessionBtn) {
                event.preventDefault();
                exportSessionByJobKey(exportSessionBtn.getAttribute('data-export-session') || '');
                return;
            }
            const cancelRenewBtn = event.target.closest('[data-cancel-renew]');
            if (cancelRenewBtn) {
                event.preventDefault();
                cancelAutoRenewByJobKey(
                    cancelRenewBtn.getAttribute('data-cancel-renew') || '',
                    cancelRenewBtn
                );
                return;
            }
            const enableRenewBtn = event.target.closest('[data-enable-renew]');
            if (enableRenewBtn) {
                event.preventDefault();
                enableAutoRenewByJobKey(
                    enableRenewBtn.getAttribute('data-enable-renew') || '',
                    enableRenewBtn
                );
                return;
            }
            const deleteBillingBtn = event.target.closest('[data-delete-billing]');
            if (deleteBillingBtn) {
                event.preventDefault();
                deleteBillingRecord(deleteBillingBtn.getAttribute('data-delete-billing') || '');
            }
        });

        let sessionModalPayload = '';
        let sessionModalJobKey = '';

        function formatSessionPayload(raw) {
            const text = String(raw || '').trim();
            if (!text) {
                return '';
            }
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
            if (!parsed.ok) {
                throw new Error(parsed.message);
            }
            const data = parsed.data;
            if (!res.ok || !data.success) {
                throw new Error(data.message || '加载 Session 失败');
            }
            return {
                payload: data.session?.session_payload || '',
                meta: data.session || {}
            };
        }

        function closeSessionModal() {
            const overlay = document.getElementById('session_modal_overlay');
            const body = document.getElementById('session_modal_body');
            const meta = document.getElementById('session_modal_meta');
            if (overlay) {
                overlay.classList.remove('open');
            }
            if (body) {
                body.textContent = '';
            }
            if (meta) {
                meta.textContent = '';
            }
            sessionModalPayload = '';
            sessionModalJobKey = '';
        }

        async function openSessionModal(jobKey) {
            if (!jobKey) {
                return;
            }
            const overlay = document.getElementById('session_modal_overlay');
            const body = document.getElementById('session_modal_body');
            const meta = document.getElementById('session_modal_meta');
            if (!overlay || !body) {
                return;
            }
            closeSessionModal();
            overlay.classList.add('open');
            body.textContent = '加载中...';
            if (meta) {
                meta.textContent = `任务: ${jobKey}`;
            }
            try {
                const { payload, meta: sessionMeta } = await fetchSessionPayload(jobKey);
                if (!payload) {
                    body.textContent = '该记录未保存完整 Session（仅旧任务有摘要）。请重新提交一次开通以保存完整内容。';
                    return;
                }
                sessionModalJobKey = jobKey;
                sessionModalPayload = formatSessionPayload(payload);
                body.textContent = sessionModalPayload;
                if (meta) {
                    meta.textContent = `任务: ${jobKey} · CDK: ${sessionMeta.cdk_code || '-'} · ${sessionMeta.time || ''}`;
                }
            } catch (error) {
                body.textContent = `加载失败: ${error.message}`;
            }
        }

        async function copyTextToClipboard(text) {
            if (!text) {
                throw new Error('内容为空');
            }
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
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

        function renderCancelRenewalDetail(data = {}) {
            const rows = [
                ['账号', data.email || '—'],
                ['套餐', data.plan || '—'],
                ['订阅渠道', data.subscriptionChannel || '—'],
                ['到期时间', data.expiresAtDisplay || '—'],
                ['自动续费', data.autoRenew || '—']
            ];
            return rows.map(([label, value]) => (
                `<div style="display:flex; justify-content:space-between; gap:16px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
                    <span style="color: var(--text-dim);">${escapeHtml(label)}</span>
                    <strong>${escapeHtml(String(value))}</strong>
                </div>`
            )).join('');
        }

        function showCancelRenewalResult(data = {}, message = '') {
            const box = document.getElementById('cancel_renewal_result');
            const statusEl = document.getElementById('cancel_renewal_status');
            const detailEl = document.getElementById('cancel_renewal_detail');
            if (!box || !statusEl || !detailEl) {
                return;
            }
            const already = Boolean(data.alreadyCancelled);
            const cancelled = Boolean(data.cancelled);
            const statusText = message || data.message || (already ? '自动续费已关闭' : (cancelled ? '已提交取消自动续费' : '操作完成'));
            const color = already || cancelled ? 'var(--success)' : 'var(--text-main)';
            statusEl.textContent = statusText;
            statusEl.style.color = color;
            detailEl.innerHTML = renderCancelRenewalDetail(data);
            box.style.display = 'block';
        }

        function clearCancelRenewalPage() {
            const input = document.getElementById('cancel_renewal_session');
            const hint = document.getElementById('cancel_renewal_hint');
            const box = document.getElementById('cancel_renewal_result');
            if (input) {
                input.value = '';
            }
            if (hint) {
                hint.textContent = '';
            }
            if (box) {
                box.style.display = 'none';
            }
        }

        async function requestCancelAutoRenew(sessionRaw) {
            const res = await authFetch('/api/admin/subscription/cancel-auto-renew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session: sessionRaw,
                    timezone_offset_min: -new Date().getTimezoneOffset()
                })
            });
            const parsed = await readJsonResponse(res);
            if (!parsed.ok) {
                throw new Error(parsed.message);
            }
            const data = parsed.data;
            if (!res.ok || !data.success) {
                throw new Error(data.message || '取消自动续费失败');
            }
            return data.data || {};
        }

        async function requestEnableAutoRenew(sessionRaw) {
            const res = await authFetch('/api/admin/subscription/enable-auto-renew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session: sessionRaw,
                    timezone_offset_min: -new Date().getTimezoneOffset()
                })
            });
            const parsed = await readJsonResponse(res);
            if (!parsed.ok) {
                throw new Error(parsed.message);
            }
            const data = parsed.data;
            if (!res.ok || !data.success) {
                throw new Error(data.message || '开启自动续费失败');
            }
            return data.data || {};
        }

        function applyRenewalStatusFromResult(jobKey, result = {}) {
            if (!jobKey) {
                return;
            }
            sessionRenewalStatus[jobKey] = {
                ok: true,
                email: result.email || '',
                autoRenew: result.autoRenew || '—',
                autoRenewRaw: result.autoRenewRaw,
                hasActiveSubscription: Boolean(result.hasActiveSubscription),
                subscriptionChannel: result.subscriptionChannel || ''
            };
            renderSessionTable();
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
            if (!confirm('确认要关闭该账号的自动续费吗？当前计费周期内仍可继续使用。')) {
                return;
            }
            if (btn) {
                btn.disabled = true;
            }
            if (hint) {
                hint.textContent = '正在处理，请稍候…';
            }
            const box = document.getElementById('cancel_renewal_result');
            if (box) {
                box.style.display = 'none';
            }
            try {
                const result = await requestCancelAutoRenew(sessionRaw);
                showCancelRenewalResult(result, result.message || '');
                showMessage(result.message || '操作完成', result.alreadyCancelled || result.cancelled ? 'success' : 'info');
            } catch (error) {
                showMessage(error.message || '取消自动续费失败', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                }
                if (hint) {
                    hint.textContent = '';
                }
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
            if (!confirm('确认要开启该账号的自动续费吗？')) {
                return;
            }
            if (btn) {
                btn.disabled = true;
            }
            if (hint) {
                hint.textContent = '正在处理，请稍候…';
            }
            const box = document.getElementById('cancel_renewal_result');
            if (box) {
                box.style.display = 'none';
            }
            try {
                const result = await requestEnableAutoRenew(sessionRaw);
                showCancelRenewalResult(result, result.message || '');
                showMessage(result.message || '操作完成', 'success');
            } catch (error) {
                showMessage(error.message || '开启自动续费失败', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                }
                if (hint) {
                    hint.textContent = '';
                }
                lucide.createIcons();
            }
        }

        async function cancelAutoRenewByJobKey(jobKey, triggerBtn) {
            if (!jobKey) {
                return;
            }
            if (!confirm('确认要关闭该 Session 对应账号的自动续费吗？')) {
                return;
            }
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
                const result = await requestCancelAutoRenew(sessionRaw);
                const msg = result.message || '操作完成';
                applyRenewalStatusFromResult(jobKey, result);
                showMessage(`${msg}${result.email ? `（${result.email}）` : ''}`, 'success');
            } catch (error) {
                showMessage(error.message || '取消自动续费失败', 'error');
            } finally {
                if (triggerBtn) {
                    triggerBtn.disabled = false;
                    triggerBtn.textContent = originalLabel || '取消续费';
                }
            }
        }

        async function enableAutoRenewByJobKey(jobKey, triggerBtn) {
            if (!jobKey) {
                return;
            }
            if (!confirm('确认要开启该 Session 对应账号的自动续费吗？')) {
                return;
            }
            const originalLabel = triggerBtn ? triggerBtn.textContent : '';
            if (triggerBtn) {
                triggerBtn.disabled = true;
                triggerBtn.textContent = '处理中…';
            }
            showMessage('正在开启自动续费，请稍候…', 'warning');
            try {
                const { payload } = await fetchSessionPayload(jobKey);
                const sessionRaw = formatSessionPayload(payload);
                if (!sessionRaw) {
                    showMessage('该记录没有完整 Session，无法开启续费', 'warning');
                    return;
                }
                const result = await requestEnableAutoRenew(sessionRaw);
                const msg = result.message || '操作完成';
                applyRenewalStatusFromResult(jobKey, result);
                showMessage(`${msg}${result.email ? `（${result.email}）` : ''}`, 'success');
            } catch (error) {
                showMessage(error.message || '开启自动续费失败', 'error');
            } finally {
                if (triggerBtn) {
                    triggerBtn.disabled = false;
                    triggerBtn.textContent = originalLabel || '开启续费';
                }
            }
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
                const captchaDone = captchaStatus === 'submitted' || captchaStatus === 'passed' || captchaStatus === 'success';
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
                detail: providerMessage
                    ? `上游 message：${providerMessage}`
                    : `已查询 ${queryCount} 次，最后状态：${queryStatus}`,
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
                diagnostics ? `<details class="task-log-details"><summary>查看技术诊断日志（${entries.length} 条）</summary><pre>${escapeHtml(diagnostics)}</pre></details>` : '',
                task.rawOutput ? `<details class="task-log-details"><summary>查看自动化输出</summary><pre>${escapeHtml(String(task.rawOutput))}</pre></details>` : ''
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

        function showMessage(content, type = 'success') {
            const container = document.getElementById('message_container');
            if (!container) return;
            const item = document.createElement('div');
            item.className = `message-item message-${type}`;
            const iconMap = { success: 'check-circle-2', error: 'x-circle', warning: 'alert-triangle' };
            item.innerHTML = `<i data-lucide="${iconMap[type] || 'info'}"></i><span>${content}</span>`;
            container.appendChild(item);
            lucide.createIcons();
            setTimeout(() => {
                item.style.opacity = '0';
                item.style.transform = 'translateY(-8px) scale(0.98)';
                item.style.transition = '0.2s';
                setTimeout(() => item.remove(), 220);
            }, 2400);
        }

        let adminConfirmResolver = null;

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
            const r = adminConfirmResolver;
            adminConfirmResolver = null;
            if (r) {
                r(Boolean(result));
            }
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && adminConfirmResolver) {
                e.preventDefault();
                closeAdminConfirm(false);
            }
        });

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

        function isAssetActive(item) {
            return item && item.is_active !== 0 && item.status !== 'invalid';
        }

        function getFilteredItems(type) {
            const filter = tableFilters[type] || 'all';
            const source = type === 'phone_pool' ? phonePool : type === 'card_pool' ? cardPool : type === 'cdk' ? cdkPool : productPool;
            let result = source;
            if (type === 'phone_pool' || type === 'card_pool') {
                result = filter === 'all'
                    ? source
                    : source.filter((item) => filter === 'normal' ? isAssetActive(item) : !isAssetActive(item));
                return result;
            }
            if (type === 'cdk') {
                if (filter === 'used') {
                    result = source.filter((item) => (typeof item === 'string' ? 'unused' : (item.status || 'unused')) === 'used');
                } else if (filter === 'unused') {
                    result = source.filter((item) => {
                        const status = typeof item === 'string' ? 'unused' : (item.status || 'unused');
                        return status === 'unused';
                    });
                } else if (filter === 'shipped') {
                    result = source.filter((item) => typeof item !== 'string' && Boolean(item.shipped));
                } else if (filter === 'unshipped') {
                    result = source.filter((item) => typeof item === 'string' || !item.shipped);
                }

                if (cdkPlanTypeFilter && cdkPlanTypeFilter !== 'all') {
                    result = result.filter((item) => {
                        const planType = typeof item === 'string' ? 'plus' : (item.plan_type || 'plus');
                        return planType === cdkPlanTypeFilter;
                    });
                }

                const keyword = String(tableSearch.cdk || '').trim().toUpperCase();
                if (keyword) {
                    result = result.filter((item) => {
                        const code = typeof item === 'string' ? item : (item.code || '');
                        return String(code).toUpperCase().includes(keyword);
                    });
                }
            }
            if (type === 'product') {
                if (filter === 'today') {
                    const todayStr = new Date().toLocaleString('zh-CN', { hour12: false }).split(' ')[0].replace(/\//g, '-');
                    result = source.filter((item) => String(item.time).startsWith(todayStr));
                } else if (filter === 'yesterday') {
                    const y = new Date();
                    y.setDate(y.getDate() - 1);
                    const yStr = y.toLocaleString('zh-CN', { hour12: false }).split(' ')[0].replace(/\//g, '-');
                    result = source.filter((item) => String(item.time).startsWith(yStr));
                } else if (filter === 'status_normal') {
                    result = source.filter((item) => item.status === '正常');
                } else if (filter === 'status_disabled') {
                    result = source.filter((item) => item.status === '封禁');
                } else if (filter === 'shipped') {
                    result = source.filter((item) => item.shipped);
                } else if (filter === 'unshipped') {
                    result = source.filter((item) => !item.shipped);
                }
                const keyword = String(tableSearch.product || '').trim().toUpperCase();
                if (keyword) {
                    result = result.filter((item) => {
                        const email = typeof item === 'string' ? item : (item.email || '');
                        return String(email).toUpperCase().includes(keyword);
                    });
                }
                return result;
            }
            return result;
        }

        function setFilter(type, value) {
            tableFilters[type] = value;
            paginationState[type].page = 1;
            if (type === 'phone_pool') renderPhoneTable();
            if (type === 'card_pool') renderCardTable();
            if (type === 'cdk') renderCDKTable();
            if (type === 'product') renderProductTable();
        }

        function handleProductSearch(value) {
            tableSearch.product = String(value || '');
            paginationState.product.page = 1;
            renderProductTable();
        }

        function handleCdkSearch(value) {
            tableSearch.cdk = String(value || '');
            paginationState.cdk.page = 1;
            renderCDKTable();
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
            setFilter(type, value);
        }

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.filter-dropdown')) {
                closeFilterMenus();
            }
        });

        function changePage(stateKey, nextPage) {
            paginationState[stateKey].page = nextPage;
            if (stateKey === 'phone_pool') renderPhoneTable();
            if (stateKey === 'card_pool') renderCardTable();
            if (stateKey === 'cdk') renderCDKTable();
            if (stateKey === 'log') renderLogTable(window.__adminLogs || []);
            if (stateKey === 'session') loadSessions(false);
        }

        function getItemKey(type, item) {
            if (type === 'phone_pool') return item.phone || '';
            if (type === 'card_pool') return item.number || '';
            if (type === 'cdk') return typeof item === 'string' ? item : (item.code || '');
            if (type === 'product') return String(item.id || '');
            return '';
        }

        function toggleSelection(type, key, checked) {
            if (!key) return;
            if (checked) {
                selectedItems[type].add(key);
            } else {
                selectedItems[type].delete(key);
            }
        }

        function togglePageSelection(type) {
            const pageData = getPageItems(getFilteredItems(type), type);
            const keys = pageData.items.map((item) => getItemKey(type, item)).filter(Boolean);
            const shouldSelect = keys.some((key) => !selectedItems[type].has(key));
            keys.forEach((key) => {
                if (shouldSelect) {
                    selectedItems[type].add(key);
                } else {
                    selectedItems[type].delete(key);
                }
            });
            if (type === 'phone_pool') renderPhoneTable();
            if (type === 'card_pool') renderCardTable();
            if (type === 'cdk') renderCDKTable();
            if (type === 'product') renderProductTable();
        }

        function selectUnusedOnPage(type) {
            if (type !== 'cdk') return;
            const pageData = getPageItems(getFilteredItems('cdk'), 'cdk');
            let count = 0;
            pageData.items.forEach((item) => {
                const code = getItemKey('cdk', item);
                const status = typeof item === 'string' ? 'unused' : (item.status || 'unused');
                if (code && status === 'unused') {
                    selectedItems.cdk.add(code);
                    count += 1;
                }
            });
            renderCDKTable();
            if (count > 0) {
                showMessage(`已选中本页 ${count} 个未使用 CDK`, 'success');
            } else {
                showMessage('本页没有未使用的 CDK', 'warning');
            }
        }

        function pruneSelection(type, source) {
            const validKeys = new Set((Array.isArray(source) ? source : []).map((item) => getItemKey(type, item)).filter(Boolean));
            Array.from(selectedItems[type]).forEach((key) => {
                if (!validKeys.has(key)) {
                    selectedItems[type].delete(key);
                }
            });
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

            const sortedPages = [...pages]
                .filter((page) => page >= 1 && page <= totalPages)
                .sort((left, right) => left - right);

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
            const state = paginationState[stateKey];
            const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
            const start = total === 0 ? 0 : ((state.page - 1) * state.pageSize) + 1;
            const end = Math.min(state.page * state.pageSize, total);
            const pageItems = getPaginationItems(state.page, totalPages);
            document.getElementById(containerId).innerHTML = `
                <div class="pagination-meta">共 ${total} 条，当前显示 ${start}-${end}</div>
                <div class="pagination">
                    <button class="pagination-nav" onclick="changePage('${stateKey}', ${state.page - 1})" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
                    ${pageItems.map((item) => item === 'ellipsis'
                ? '<span class="pagination-ellipsis">...</span>'
                : `<button class="${item === state.page ? 'active' : ''}" onclick="changePage('${stateKey}', ${item})">${item}</button>`
            ).join('')}
                    <button class="pagination-nav" onclick="changePage('${stateKey}', ${state.page + 1})" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>
                </div>
            `;
        }

        function switchAdminSection(group, target) {
            const root = document.querySelector(`[data-switcher="${group}"]`);
            if (!root) return;
            root.querySelectorAll('[data-switch-panel]').forEach((panel) => {
                panel.hidden = panel.dataset.switchPanel !== target;
            });
            root.querySelectorAll('[data-switcher-tab]').forEach((tab) => {
                const active = tab.dataset.switcherTab === target;
                tab.classList.toggle('is-active', active);
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            if (group === 'card-assets' && target === 'orbitcard') {
                loadOrbitcardUsage(false, false).catch(() => { });
            }
            if (group === 'card-assets' && target === 'orbitcard-strategy') {
                loadOrbitcardProductStrategy(false).catch(() => { });
            }
            if (group === 'task-records' && target === 'holds') {
                loadActivationManualHolds(false).catch(() => { });
            }
            lucide.createIcons();
        }

        function toggleNavGroup(groupId, event) {
            event?.stopPropagation?.();
            const group = document.getElementById(groupId);
            if (!group) return;
            group.classList.toggle('expanded');
            lucide.createIcons();
        }

        function expandNavGroupForPage(pId) {
            if (BUSINESS_PAGES.has(pId)) {
                document.getElementById('nav_group_business')?.classList.add('expanded');
            }
        }

        function resolveNavItem(pId, el) {
            if (el && el.classList.contains('nav-item')) {
                return el;
            }
            return document.querySelector(`.nav-item[data-page="${pId}"]`)
                || document.querySelector(`.nav-item[onclick*="'${pId}'"]`);
        }

        function switchPageInternal(pId, el) {
            document.querySelectorAll('.nav-item.active').forEach((i) => i.classList.remove('active'));
            const page = document.getElementById(pId);
            if (!page) {
                console.error('Page not found:', pId);
                return;
            }
            page.classList.add('active');
            document.querySelectorAll('.page-view').forEach((p) => {
                if (p.id !== pId) p.classList.remove('active');
            });

            expandNavGroupForPage(pId);
            resolveNavItem(pId, el)?.classList.add('active');

            if (pId === 'runtime_logs') {
                startRuntimeLogStream();
            } else {
                stopRuntimeLogStream();
            }

            if (pId === 'billing') {
                loadBillingRecords(1).catch(() => { });
            }

            if (pId === 'sessions') {
                loadSessions(false).catch(() => { });
            }

            if (pId === 'cards') {
                loadCardPoolList();
                loadOrbitcardUsage();
            }

            if (pId === 'checkout_debug') {
                loadCheckoutDebugPage().catch(() => { });
                startCheckoutDebugLogStream();
            } else {
                stopCheckoutDebugLogStream();
            }

            if (pId === 'tax_addresses') {
                loadAddressList('US').catch(() => { });
            }

            if (pId === 'proxies') {
                loadProxyPool().catch(() => { });
            }

            if (pId === 'browser_pool') {
                loadBrowserPoolPage(true).catch(() => { });
                startBrowserPoolAutoRefresh();
            } else {
                stopBrowserPoolAutoRefresh();
            }

            if (pId === 'config') {
                reloadSystemConfigFromServer().catch(() => { });
                loadAdminSecurityStatus().catch(() => { });
            }

            if (pId === 'admin_login_logs') {
                loadAdminLoginLogs().catch(() => { });
            }

            if (pId === 'cdks') {
                loadCdkList().catch((error) => {
                    console.error('Failed to load CDK list', error);
                });
            }

            if (pId === 'logs') {
                loadTaskLogs(false).catch((error) => {
                    console.error('Failed to load task logs', error);
                });
            }
        }

        async function switchPage(pId, el) {
            switchPageInternal(pId, el);
        }

        function escapeHtml(str) {
            return String(str ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function renderPoolEmailsTable() {
            const tbody = document.getElementById('pool_emails_body');
            const hint = document.getElementById('pool_emails_empty_hint');
            if (!tbody) {
                return;
            }
            if (!poolEmailsList.length) {
                tbody.innerHTML = '';
                if (hint) {
                    hint.style.display = 'block';
                }
                lucide.createIcons();
                return;
            }
            if (hint) {
                hint.style.display = 'none';
            }

            tbody.innerHTML = poolEmailsList.map((row) => {
                const id = Number(row.id);
                const regBadge = row.registered
                    ? '<span class="status-badge status-success">已注册</span>'
                    : '<span class="status-badge status-running">未注册</span>';
                const lockBadge = row.in_use
                    ? '<span class="status-badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">占用中</span>'
                    : '<span class="status-badge" style="opacity:.78;">空闲</span>';
                let pwdCell;
                if (row.has_oauth) {
                    pwdCell = '<span class="status-badge status-success">OAuth2</span>';
                } else if (row.has_password) {
                    pwdCell = '<span style="color:var(--text-secondary)">密码</span>';
                } else {
                    pwdCell = '<span class="status-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">缺失</span>';
                }
                const regAt = row.registered_at
                    ? String(row.registered_at).replace('T', ' ').slice(0, 19)
                    : '-';
                const safeEmail = escapeHtml(row.email || '');
                return `
                <tr>
                    <td><code>${safeEmail}</code></td>
                    <td style="text-align:center">${pwdCell}</td>
                    <td style="text-align:center">${regBadge}</td>
                    <td style="text-align:center">${lockBadge}</td>
                    <td>${escapeHtml(regAt)}</td>
                    <td style="text-align:center">
                        <button type="button" class="btn btn-success" style="padding:8px 12px;margin-right:8px;border-radius:10px;" onclick="previewPoolMailbox(${id})">
                            <i data-lucide="inbox"></i> 邮件
                        </button>
                        <button type="button" class="btn-delete" onclick="deletePoolEmailRow(${id})">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </td>
                </tr>`;
            }).join('');
            lucide.createIcons();
        }

        async function loadPoolEmails(showToast = false) {
            try {
                const res = await authFetch('/api/admin/pool-emails');
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.message || '加载邮箱列表失败');
                }
                poolEmailsList = Array.isArray(data.items) ? data.items : [];
                renderPoolEmailsTable();
                if (showToast) {
                    showMessage('邮箱列表已刷新', 'success');
                }
            } catch (error) {
                showMessage(error.message || '加载邮箱列表失败', 'error');
            }
        }

        function handlePoolMailFileImport(ev) {
            const input = ev.target;
            const file = input.files && input.files[0];
            if (!file) {
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const ta = document.getElementById('pool_mail_import_text');
                if (ta) {
                    ta.value = String(reader.result || '');
                }
                showMessage(`已载入文件：${file.name}`, 'success');
            };
            reader.onerror = () => showMessage('读取文件失败', 'error');
            reader.readAsText(file);
            input.value = '';
        }

        async function submitPoolMailImport() {
            const ta = document.getElementById('pool_mail_import_text');
            const text = ta ? ta.value.trim() : '';
            if (!text) {
                showMessage('请先粘贴内容或选择 mail.txt', 'warning');
                return;
            }
            try {
                const res = await authFetch('/api/admin/pool-emails/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text })
                });
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || '导入失败');
                }
                showMessage(data.message || '导入成功', 'success');
                await loadPoolEmails(false);
            } catch (error) {
                showMessage(error.message || '导入失败', 'error');
            }
        }

        async function previewPoolMailbox(id) {
            const panel = document.getElementById('pool_mail_preview_panel');
            const title = document.getElementById('pool_mail_preview_title');
            const tbody = document.getElementById('pool_mail_preview_body');
            if (!panel || !tbody) {
                return;
            }
            panel.style.display = 'block';
            if (title) {
                title.textContent = `邮件预览 (#${id})`;
            }
            tbody.innerHTML = '<tr><td colspan="4">加载中...</td></tr>';
            try {
                const res = await authFetch(`/api/admin/pool-emails/${id}/messages?limit=50`);
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || '加载失败');
                }
                const rows = data.messages || [];
                if (!rows.length) {
                    tbody.innerHTML = '<tr><td colspan="4">暂无邮件（请确认密码支持 IMAP，且已在系统配置中启用垃圾箱）</td></tr>';
                } else {
                    tbody.innerHTML = rows.map((m) => `
                    <tr>
                        <td>${escapeHtml(m.folder)}</td>
                        <td>${escapeHtml(m.subject)}</td>
                        <td>${escapeHtml(m.from)}</td>
                        <td>${escapeHtml(m.date)}</td>
                    </tr>`).join('');
                }
                lucide.createIcons();
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (error) {
                tbody.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message || '加载失败')}</td></tr>`;
            }
        }

        function closePoolMailPreview() {
            const panel = document.getElementById('pool_mail_preview_panel');
            if (panel) {
                panel.style.display = 'none';
            }
        }

        async function deletePoolEmailRow(id) {
            const ok = await showAdminConfirm(`确定删除邮箱池记录 #${id} ?`, '删除邮箱');
            if (!ok) {
                return;
            }
            try {
                const res = await authFetch(`/api/admin/pool-emails/${id}`, { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || '删除失败');
                }
                showMessage(data.message || '已删除', 'success');
                await loadPoolEmails(false);
            } catch (error) {
                showMessage(error.message || '删除失败', 'error');
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
            scheduleSessionRefresh(data.expiresAt);
            return data;
        }

        async function reloadSystemConfigFromServer() {
            const res = await authFetch('/api/admin/data');
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.message || '加载系统配置失败');
            }
            applySystemConfigFromData(data);
            return data;
        }

        function applySystemConfigFromData(data) {
            const cfg = data?.config || {};
            const maxConcurrentEl = document.getElementById('max_concurrent_activations');
            if (maxConcurrentEl) {
                maxConcurrentEl.value = cfg.max_concurrent_activations || 1;
            }
            loadTelegramConfig(data.telegram || {});
            loadHcaptchaConfig(data.hcaptcha || {});
            lastMaintenanceModeValue = Boolean(cfg.maintenance_mode);
            updateMaintenanceModeUI(cfg, window.__adminRuntime || { active_activation_jobs: 0 });
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
                const billingCurrency = data.stats.billing_currency || 'USD';
                const billingRevenue = Number(data.stats.billing_revenue || 0);
                document.getElementById('stat_billing_revenue').innerText = billingRevenue.toFixed(2);
                document.getElementById('stat_billing_revenue_meta').innerText = `成功账单累计 (${billingCurrency})`;
                document.getElementById('stat_billing_paid_count').innerText = data.stats.billing_paid_count || 0;
                document.getElementById('stat_card_total').innerText = (data.config.card_pool || []).length;
                document.getElementById('stat_foreground_slots').innerText = `${Number(data.runtime?.active_foreground_jobs || 0)}/${Number(data.config.max_concurrent_activations || 1)}`;
                const pool = data.runtime?.browser_pool;
                const poolMeta = (pool?.enabled && pool?.size)
                    ? `浏览器池 ${pool.idle ?? 0}/${pool.size} 空闲${pool.waiting ? ` · 排队 ${pool.waiting}` : ''} · `
                    : '';
                document.getElementById('stat_foreground_slots_meta').innerText = `${poolMeta}前台占用/最大前台并发`;

                if (isInitial) {
                    applySystemConfigFromData(data);
                    loadCardPoolList();
                }

                window.__adminRuntime = data.runtime || { active_activation_jobs: 0 };
                if (!isInitial) {
                    lastMaintenanceModeValue = Boolean(data.config.maintenance_mode);
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

        async function loadCdkList() {
            const cdkRes = await authFetch('/api/admin/cdks');
            let cdkData = [];
            try {
                cdkData = await cdkRes.json();
            } catch (parseError) {
                throw new Error('CDK 列表响应解析失败');
            }
            if (!cdkRes.ok) {
                throw new Error(cdkData?.message || `加载 CDK 失败（${cdkRes.status}）`);
            }
            cdkPool = Array.isArray(cdkData)
                ? cdkData
                : (Array.isArray(cdkData?.cdks) ? cdkData.cdks : []);
            pruneSelection('cdk', cdkPool);
            renderCDKTable();
        }

        let sessionList = [];
        let sessionTotal = 0;
        let sessionSearch = '';
        let sessionRenewalStatus = {};
        let sessionRenewalFetchInFlight = false;
        let sessionRenewalJobKeySnapshot = '';

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
            if (!info) {
                return '<span style="color:var(--text-dim); font-size:12px;">查询中…</span>';
            }
            if (!info.ok) {
                const err = escapeHtml(info.error || '查询失败');
                return `<span style="color:#f87171; font-size:12px;" title="${err}">失败</span>`;
            }
            if (!info.hasActiveSubscription) {
                return '<span style="color:var(--text-dim); font-size:12px;">无订阅</span>';
            }
            if (info.autoRenewRaw === true) {
                return '<span class="status-badge status-success">已开启</span>';
            }
            if (info.autoRenewRaw === false) {
                return '<span class="status-badge" style="background:rgba(251,191,36,0.12);color:#fbbf24;">已关闭</span>';
            }
            return '<span style="color:var(--text-dim);">—</span>';
        }

        async function refreshSessionRenewalStatuses(force = false) {
            const jobKeys = getSessionRenewalJobKeys();
            if (!jobKeys.length) {
                return;
            }

            const snapshot = buildSessionRenewalSnapshot(jobKeys);
            if (!force && snapshot === sessionRenewalJobKeySnapshot && hasCachedRenewalStatuses(jobKeys)) {
                return;
            }
            if (sessionRenewalFetchInFlight) {
                return;
            }

            sessionRenewalFetchInFlight = true;
            sessionRenewalJobKeySnapshot = snapshot;

            jobKeys.forEach((jobKey) => {
                if (!sessionRenewalStatus[jobKey]) {
                    sessionRenewalStatus[jobKey] = null;
                }
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
                if (!parsed.ok) {
                    throw new Error(parsed.message);
                }
                const payload = parsed.data;
                if (!res.ok || !payload.success) {
                    throw new Error(payload.message || '查询自动续费状态失败');
                }
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
                if (!parsed.ok) {
                    throw new Error(parsed.message);
                }
                const data = Array.isArray(parsed.data)
                    ? { items: parsed.data, total: parsed.data.length }
                    : (parsed.data || {});
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
                if (showToast) {
                    showMessage('Session 列表已刷新', 'success');
                }
            } catch (error) {
                if (showToast) {
                    showMessage(error.message || '加载 Session 失败', 'error');
                }
            }
        }

        function renderSessionTable() {
            const tbody = document.getElementById('session_body');
            if (!tbody) {
                return;
            }
            if (!sessionList.length) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无 Session 记录</td></tr>';
                lucide.createIcons();
                return;
            }
            tbody.innerHTML = sessionList.map((row) => {
                const jobKey = escapeHtml(row.job_key || '');
                const preview = escapeHtml(row.token_preview || '-');
                const canView = row.has_session !== false;
                const renewInfo = sessionRenewalStatus[row.job_key];
                const canManageRenew = row.status === 'success'
                    && canView
                    && renewInfo?.ok
                    && renewInfo?.hasActiveSubscription;
                const sessionCell = canView
                    ? `<button type="button" class="session-preview-link" data-view-session="${jobKey}" title="点击查看完整 Session">${preview}</button>`
                    : `<code>${preview}</code>`;
                const cancelRenewBtn = canManageRenew && renewInfo.autoRenewRaw === true
                    ? `<button type="button" class="btn btn-danger" style="padding:4px 8px; font-size:12px;" data-cancel-renew="${jobKey}" title="取消自动续费">取消续费</button>`
                    : '';
                const enableRenewBtn = canManageRenew && renewInfo.autoRenewRaw === false
                    ? `<button type="button" class="btn btn-success" style="padding:4px 8px; font-size:12px;" data-enable-renew="${jobKey}" title="开启自动续费">开启续费</button>`
                    : '';
                return `
                <tr>
                    <td>${escapeHtml(row.time || row.created_at || '-')}</td>
                    <td><code>${escapeHtml(row.cdk_code || '-')}</code></td>
                    <td>${sessionCell}</td>
                    <td style="text-align:center">${escapeHtml(row.card_last4 || '-')}</td>
                    <td>${escapeHtml(row.message || '-')}</td>
                    <td>${renderStatus(row.status)}</td>
                    <td style="text-align:center">${renderAutoRenewCell(row)}</td>
                    <td style="text-align:center">
                        <div class="table-action-group">
                            <button type="button" class="btn btn-primary" style="padding:4px 8px; font-size:12px;" data-copy-session="${jobKey}" title="复制 Session">复制</button>
                            <button type="button" class="btn btn-success" style="padding:4px 8px; font-size:12px;" data-export-session="${jobKey}" title="导出 Session">导出</button>
                            ${enableRenewBtn}
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

        function updateMaintenanceModeUI(config = {}, runtime = {}) {
            const checkbox = document.getElementById('maintenance_mode');
            const hint = document.getElementById('maintenance_mode_hint');
            if (!checkbox || !hint) {
                return;
            }

            const enabled = Boolean(config.maintenance_mode);
            const drain = Boolean(config.maintenance_mode_drain);
            const activeJobs = Math.max(0, Number(runtime.active_activation_jobs || 0));

            const isPendingEnable = enabled && drain && activeJobs > 0;
            checkbox.checked = isPendingEnable ? false : enabled;
            checkbox.disabled = maintenanceModeSaving || isPendingEnable;

            if (isPendingEnable) {
                hint.textContent = `维护模式待开启，当前还有 ${activeJobs} 个任务在运行；新请求已拒绝，待现有任务全部完成后将自动开启`;
                return;
            }

            if (enabled) {
                hint.textContent = '维护模式已开启，当前拒绝所有新任务';
                return;
            }

            hint.textContent = '开启后立即拒绝所有新任务';
        }

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

        let browserPoolRefreshTimer = null;

        function formatDurationShort(sec) {
            const s = Math.max(0, Number(sec) || 0);
            if (s < 60) return `${s}秒`;
            if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return `${h}时${m}分`;
        }

        function stopBrowserPoolAutoRefresh() {
            if (browserPoolRefreshTimer) {
                clearInterval(browserPoolRefreshTimer);
                browserPoolRefreshTimer = null;
            }
        }

        function startBrowserPoolAutoRefresh() {
            stopBrowserPoolAutoRefresh();
            browserPoolRefreshTimer = setInterval(() => {
                if (document.getElementById('browser_pool')?.classList.contains('active')) {
                    loadBrowserPoolPage(false).catch(() => { });
                }
            }, 2000);
        }

        function renderBrowserPoolSlots(pool) {
            const grid = document.getElementById('browser_pool_slots_grid');
            if (!grid) return;
            const slots = Array.isArray(pool?.slots) ? pool.slots : [];
            if (!slots.length) {
                grid.innerHTML = '<div style="color:var(--text-dim); padding:16px;">暂无槽位（池未初始化或已禁用）</div>';
                return;
            }
            grid.innerHTML = slots.map((slot) => {
                const busy = Boolean(slot.inUse);
                const border = busy ? '#f59e0b' : '#22c55e';
                const bg = busy ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.06)';
                const statusText = busy ? '忙碌' : '空闲';
                const job = slot.jobKey ? escapeHtml(slot.jobKey) : '—';
                const urls = (slot.openUrls || []).map((u) => `<div style="font-size:11px; opacity:0.85; word-break:break-all;">${escapeHtml(u)}</div>`).join('') || '<div style="font-size:11px; opacity:0.6;">无打开页面</div>';
                return `
                <div style="border:1px solid ${border}; background:${bg}; border-radius:12px; padding:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                        <strong style="font-size:16px;">Slot #${slot.slotId}</strong>
                        <span style="font-size:12px; padding:4px 10px; border-radius:999px; background:rgba(0,0,0,0.25); color:${border};">${statusText}</span>
                    </div>
                    <div style="font-size:13px; line-height:1.65; color:var(--text-dim);">
                        <div>CDP: <code>${escapeHtml(slot.cdpUrl || '')}</code></div>
                        <div>端口: ${slot.port} · 累计 ${slot.uses || 0} 次 · 运行 ${formatDurationShort(slot.uptimeSec)}</div>
                        <div>Profile: ${escapeHtml(slot.profileSizeText || '0 B')}</div>
                        <div>页面数: ${slot.pageCount || 0}${busy ? ` · 任务 <code>${job}</code>` : ''}</div>
                    </div>
                    <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06);">${urls}</div>
                </div>`;
            }).join('');
        }

        async function loadBrowserPoolPage(showToast = false) {
            const res = await authFetch('/api/admin/browser-pool');
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '加载浏览器池失败');
            }
            const pool = data.pool || {};
            const mode = data.mode || {};
            const sys = data.system || {};
            const mem = pool.memory || {};

            const modeToggle = document.getElementById('bp_mode_enabled');
            if (modeToggle && document.activeElement !== modeToggle) {
                modeToggle.checked = Boolean(mode.enabled);
            }
            const modeHint = document.getElementById('bp_mode_hint');
            if (modeHint) {
                modeHint.textContent = mode.enabled
                    ? `当前：浏览器池 · 子进程 BROWSER_RUNTIME_MODE=pool`
                    : `当前：独立启动 · 子进程 BROWSER_RUNTIME_MODE=standalone`;
            }

            document.getElementById('bp_max_size').textContent = pool.maxPoolSize || 24;
            const sizeInput = document.getElementById('bp_pool_size_input');
            if (sizeInput && document.activeElement !== sizeInput) {
                sizeInput.max = String(pool.maxPoolSize || 48);
                sizeInput.value = pool.configuredSize || pool.size || 2;
            }

            const enabled = Boolean(mode.enabled) && pool.enabled && pool.initialized;
            document.getElementById('bp_stat_status').textContent = !mode.enabled
                ? '独立模式'
                : (!pool.enabled ? '已禁用' : (pool.initialized ? '运行中' : '未就绪'));
            document.getElementById('bp_stat_status').style.color = enabled ? '#86efac' : '#f87171';
            document.getElementById('bp_stat_slots').textContent = `${pool.size || 0} / ${pool.configuredSize || pool.size || 0}`;
            document.getElementById('bp_stat_usage').textContent = `${pool.idle || 0} / ${pool.busy || 0}`;
            document.getElementById('bp_stat_waiting').textContent = String(pool.waiting || 0);
            document.getElementById('bp_stat_uses').textContent = String(pool.totalUses || 0);
            document.getElementById('bp_stat_mem').textContent = pool.totals?.estimatedProcessText || '—';

            const hostLines = [];
            if (mem.hostTotalGb != null) {
                hostLines.push(`主机内存：已用 <strong>${mem.hostUsedGb?.toFixed?.(1) ?? mem.hostUsedGb} GB</strong> / 共 ${mem.hostTotalGb} GB（可用约 <strong style="color:#86efac;">${mem.hostFreeGb?.toFixed?.(1) ?? mem.hostFreeGb} GB</strong>）`);
            } else if (sys.memory?.text) {
                hostLines.push(`主机内存：${escapeHtml(sys.memory.text)}（${sys.memory.percent || 0}%）`);
            }
            hostLines.push(`CPU：${escapeHtml(sys.cpu?.text || '—')}（${sys.cpu?.percent || 0}%）`);
            hostLines.push(`池 Profile 磁盘：${escapeHtml(pool.totals?.profileSizeText || '0 B')} · CDP 基址端口 ${pool.basePort || 19222}`);
            hostLines.push(`前台任务：${data.foreground?.activeForegroundJobs ?? 0} 占用 · 槽位上限 ${pool.maxPoolSize || 24}`);
            if (mem.sizingHint) {
                hostLines.push(`<span style="color:#93c5fd;">💡 ${escapeHtml(mem.sizingHint)}</span>`);
            }
            document.getElementById('browser_pool_memory_hint').innerHTML = hostLines.join('<br>');

            renderBrowserPoolSlots(pool);

            const queue = Array.isArray(pool.queue) ? pool.queue : [];
            const queueEl = document.getElementById('browser_pool_queue');
            if (!queue.length) {
                queueEl.innerHTML = '无排队任务';
            } else {
                queueEl.innerHTML = queue.map((q, i) => `<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">#${i + 1} 等待槽位 · 任务 <code>${escapeHtml(q.jobKey || '—')}</code></div>`).join('');
            }

            if (showToast) {
                showMessage('浏览器池状态已刷新', 'success');
            }
            lucide.createIcons();
        }

        async function setBrowserPoolMode(enabled) {
            const hint = document.getElementById('bp_reload_hint');
            if (hint) hint.textContent = '正在切换模式…';
            try {
                const res = await authFetch('/api/admin/browser-pool/mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: Boolean(enabled) })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '切换失败');
                }
                if (hint) hint.textContent = data.message || '已切换';
                await loadBrowserPoolPage(false);
            } catch (error) {
                if (hint) hint.textContent = error.message || '切换失败';
                const toggle = document.getElementById('bp_mode_enabled');
                if (toggle) toggle.checked = !enabled;
            }
        }

        async function reloadBrowserPool() {
            const input = document.getElementById('bp_pool_size_input');
            const hint = document.getElementById('bp_reload_hint');
            const size = Number(input?.value || 0);
            if (!size || size < 1) {
                showMessage('请输入有效的槽位数量', 'error');
                return;
            }
            hint.textContent = '正在重载...';
            try {
                const res = await authFetch('/api/admin/browser-pool/reload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ size })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '重载失败');
                }
                hint.textContent = data.message || '已重载';
                showMessage(data.message || '浏览器池已重载', 'success');
                await loadBrowserPoolPage(false);
            } catch (e) {
                hint.textContent = '';
                showMessage(e.message, 'error');
            }
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
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '保存失败');
                }
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
                rowItem.last_check_ok = !!result.ok;
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
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '检测失败');
                }
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
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '批量检测失败');
                }
                const results = Array.isArray(data.results) ? data.results : [];
                let okCount = 0;
                results.forEach((result) => {
                    if (result.id) {
                        applyProxyTestResultToRow(result.id, result);
                    }
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
                    body: JSON.stringify({ is_active: !!isActive })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '更新失败');
                }
                const rowItem = proxyPoolList.find((item) => item.id === id);
                if (rowItem) rowItem.is_active = !!isActive;
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
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '删除失败');
                }
                showMessage('代理已删除', 'success');
                await loadProxyPool();
            } catch (error) {
                showMessage(error.message || '删除失败', 'error');
            }
        }

        function buildConfigPayload(overrides = {}) {
            return {
                max_concurrent_activations: Math.max(1, parseInt(document.getElementById('max_concurrent_activations').value, 10) || 1),
                maintenance_mode: Object.prototype.hasOwnProperty.call(overrides, 'maintenance_mode')
                    ? Boolean(overrides.maintenance_mode)
                    : document.getElementById('maintenance_mode').checked
            };
        }

        function getCurrentEmailSource() {
            if (document.getElementById('email_source_pool')?.checked) return 'pool';
            if (document.getElementById('email_source_inbox')?.checked) return 'inbox';
            return 'random';
        }

        function syncEmailSourceUI() {
            const src = getCurrentEmailSource();
            document.querySelectorAll('.email-source-card').forEach((card) => {
                const input = card.querySelector('input[type="radio"]');
                if (input) {
                    card.classList.toggle('is-active', !!input.checked);
                }
            });
            const setEnabled = (id, enabled) => {
                const el = document.getElementById(id);
                if (el) el.dataset.disabled = enabled ? '0' : '1';
            };
            setEnabled('random_email_options', src === 'random');
            setEnabled('pool_email_options', src === 'pool');
            setEnabled('inbox_email_options', src === 'inbox');
        }

        function normalizeRandomDomain(raw) {
            const cleaned = String(raw || '')
                .trim()
                .replace(/^@+/, '')
                .replace(/\s+/g, '')
                .toLowerCase();
            return cleaned || 'chiyiyi.cloud';
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
                    body: JSON.stringify(buildConfigPayload({
                        maintenance_mode: nextValue
                    }))
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '维护模式保存失败');
                }
                lastMaintenanceModeValue = nextValue;
                showMessage(data.message, 'success');
                await loadData(true);
            } catch (error) {
                if (checkbox) {
                    checkbox.checked = lastMaintenanceModeValue;
                }
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

        function shortenJobKey(jobKey) {
            const value = String(jobKey || '');
            if (!value) {
                return '-';
            }
            const parts = value.split('-');
            return parts.length > 1 ? parts[1] : value.slice(-8);
        }

        async function loadTaskLogs(showToast = false) {
            try {
                const res = await authFetch('/api/admin/task-logs');
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.message || `加载任务失败（${res.status}）`);
                }
                window.__adminLogs = Array.isArray(data.tasks) ? data.tasks : [];
                renderLogTable(window.__adminLogs);
                if (showToast) {
                    showMessage('任务列表已刷新', 'success');
                }
            } catch (error) {
                console.error('loadTaskLogs failed', error);
                if (showToast) {
                    showMessage(error.message || '加载任务失败', 'error');
                }
            }
            lucide.createIcons();
        }

        function renderCDKTable() {
            const tbody = document.getElementById('cdk_body');
            if (!tbody) {
                return;
            }
            const pageData = getPageItems(getFilteredItems('cdk'), 'cdk');
            tbody.innerHTML = pageData.items.map((cdk) => {
                const code = typeof cdk === 'string' ? cdk : (cdk.code || '');
                const status = typeof cdk === 'string' ? 'unused' : (cdk.status || 'unused');
                const shipped = typeof cdk === 'string' ? false : Boolean(cdk.shipped);
                const planType = typeof cdk === 'string' ? 'plus' : (cdk.plan_type || 'plus');
                const usedAt = typeof cdk === 'string' ? null : cdk.used_at;
                const sessionPreview = typeof cdk === 'string' ? null : (cdk.session_preview || null);

                const planTypeLabel = { plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' }[planType] || 'Plus';
                const planTypeColor = { plus: '#2563eb', pro_5x: '#8b5cf6', pro_20x: '#ec4899' }[planType] || '#2563eb';
                const planTypeBg = { plus: 'rgba(37, 99, 235, 0.12)', pro_5x: 'rgba(139, 92, 246, 0.12)', pro_20x: 'rgba(236, 72, 153, 0.12)' }[planType] || 'rgba(37, 99, 235, 0.12)';

                return `
                <tr>
                    <td class="select-cell"><input type="checkbox" ${selectedItems.cdk.has(code) ? 'checked' : ''} onchange="toggleSelection('cdk', '${code}', this.checked)"></td>
                    <td><span class="cdk-copy" onclick="copyCDK('${code}')"><code>${code}</code><i data-lucide="copy"></i></span></td>
                    <td style="text-align:center"><span class="status-badge" style="background: ${planTypeBg}; color: ${planTypeColor}">${planTypeLabel}</span></td>
                    <td><code>${sessionPreview ? escapeHtml(sessionPreview) : '-'}</code></td>
                    <td style="text-align:center"><span class="readonly-switch ${shipped ? 'active' : ''}" title="${shipped ? '已出库' : '未出库'}"></span></td>
                    <td>${status === 'processing'
                        ? '<span class="status-badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b;">开通中</span>'
                        : (status === 'used'
                            ? '<span class="status-badge status-success">已使用</span>'
                            : '<span class="status-badge status-running">未使用</span>')}</td>
                    <td>${usedAt || '-'}</td>
                    <td style="text-align:center">
                        <button class="btn-delete" onclick="deleteCDK('${code}')">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </td>
                </tr>
            `;
            }).join('');
            renderPagination('cdk_pagination', 'cdk', pageData.total);
            lucide.createIcons();
        }

        async function copyCDK(cdk) {
            try {
                await copyText(cdk);
                await markCDKShipped(cdk);
                showMessage(`已复制激活码: ${cdk}`, 'success');
            } catch (error) {
                showMessage('复制失败，请手动复制', 'error');
            }
        }

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

        async function markCDKShipped(cdk) {
            const res = await authFetch(`/api/admin/cdks/${encodeURIComponent(cdk)}/ship`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '标记出库失败');
            }
            const item = cdkPool.find((entry) => (typeof entry === 'string' ? entry : entry.code) === cdk);
            if (item && typeof item !== 'string') {
                item.shipped = true;
            }
            renderCDKTable();
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
            if (!ok) {
                return;
            }
            await Promise.all(codes.map((code) => authFetch(`/api/admin/cdks/${encodeURIComponent(code)}`, { method: 'DELETE' })));
            selectedItems.cdk.clear();
            await loadData();
        }

        async function batchDeletePhones() {
            const keys = Array.from(selectedItems.phone_pool);
            if (keys.length === 0) {
                showMessage('请选择要删除的号码', 'warning');
                return;
            }
            const ok = await showAdminConfirm(`确定删除选中的 ${keys.length} 个号码 ?`, '删除号码');
            if (!ok) {
                return;
            }
            phonePool = phonePool.filter((item) => !selectedItems.phone_pool.has(item.phone || ''));
            selectedItems.phone_pool.clear();
            renderPhoneTable();
        }

        async function batchDeleteCards() {
            // Legacy — no longer used; card pool now uses API-based deleteCardPoolItem
        }

        // ============ Stripe Card Pool Management ============

        let cardPoolList = [];

        function toggleCardPoolImportBox() {
            const box = document.getElementById('card_pool_import_box');
            box.classList.toggle('active');
        }

        async function loadCardPoolList() {
            try {
                const res = await authFetch('/api/admin/cards');
                const data = await res.json();
                cardPoolList = Array.isArray(data.cards) ? data.cards : (Array.isArray(data) ? data : []);
                renderCardPoolStats();
                renderCardPoolTable();
            } catch (e) {
                console.error('loadCardPoolList failed', e);
                showMessage('加载卡池列表失败', 'error');
            }
        }

        let orbitcardUsageList = [];
        const orbitcardUsageState = { page: 1, pageSize: 20, total: 0 };
        let orbitcardStrategyProducts = [];
        let orbitcardStrategyAutomatic = {};
        let orbitcardStrategyReuseLimits = { plus: 4, pro_5x: 1, pro_20x: 1 };

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
            if (!select || !summary || !tbody) return;
            const selectedCode = select.value || '';
            const selected = orbitcardStrategyProducts.find((item) => item.product_code === selectedCode);
            if (selectedCode && selected) {
                summary.innerHTML = `<div style="display:flex; gap:18px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:14px 16px; border:1px solid var(--border); border-radius:8px; background:var(--bg-secondary);">
                    <div><strong>持续指定产品</strong><div style="font-size:13px; color:var(--text-dim); margin-top:5px;">渠道 ${Number(selected.channel || 0) || '-'} · ${escapeHtml(selected.network || '卡')} · BIN ${escapeHtml(selected.bin || '未知')} · ${escapeHtml(selected.product_code)}</div></div>
                    <div style="font-size:13px; font-weight:600;">${escapeHtml(orbitcardInventoryLabel(selected))}</div>
                </div>`;
            } else {
                summary.innerHTML = `<div style="padding:14px 16px; border-left:3px solid var(--primary); background:var(--bg-secondary);">
                    <strong>自动按优先级选择</strong>
                    <div style="font-size:13px; color:var(--text-dim); margin-top:5px;">实际开卡时按当前渠道优先级和实时可用产品选择；下表展示本次目录对应的选择结果。</div>
                </div>`;
            }
            const planLabels = { plus: 'ChatGPT Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' };
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
            if (!select || !hint) return;
            const previous = select.value || '';
            select.disabled = true;
            try {
                const res = await authFetch('/api/admin/orbitcard/products');
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.message || '产品目录查询失败');
                orbitcardStrategyProducts = Array.isArray(data.products) ? data.products : [];
                orbitcardStrategyAutomatic = data.automatic || {};
                orbitcardStrategyReuseLimits = {
                    plus: Number(data.reuse_limits?.plus) || 4,
                    pro_5x: Number(data.reuse_limits?.pro_5x) || 1,
                    pro_20x: Number(data.reuse_limits?.pro_20x) || 1
                };
                for (const planType of ['plus', 'pro_5x', 'pro_20x']) {
                    const input = document.getElementById(`orbitcard_reuse_limit_${planType}`);
                    if (input) input.value = orbitcardStrategyReuseLimits[planType];
                }
                const configured = String(data.selected_product_code || previous || '');
                select.innerHTML = '<option value="">自动按优先级选择</option>';
                for (const product of orbitcardStrategyProducts) {
                    const option = document.createElement('option');
                    option.value = product.product_code || '';
                    option.textContent = `渠道 ${product.channel || '-'} ${product.network || '卡'} · BIN ${product.bin || '未知'} · ${product.product_code} · ${orbitcardInventoryLabel(product)}`;
                    select.appendChild(option);
                }
                const available = Array.from(select.options).some((option) => option.value === configured);
                select.value = available ? configured : '';
                const fetchedAt = data.fetched_at ? new Date(data.fetched_at).toLocaleString('zh-CN', { hour12: false }) : '刚刚';
                hint.textContent = `库存直接来自本次 Orbitcard 产品目录，查询时间：${fetchedAt}。供应商实时校验型产品不显示“0 张”。`;
                renderOrbitcardStrategyDetails();
                if (showToast) showMessage('上游产品与库存已刷新', 'success');
            } catch (error) {
                hint.textContent = `产品目录读取失败：${error.message || '未知错误'}`;
                if (showToast) showMessage(error.message || '产品目录读取失败', 'error');
            } finally {
                select.disabled = false;
                lucide.createIcons();
            }
        }

        async function saveOrbitcardProductStrategy() {
            const productCode = document.getElementById('orbitcard_strategy_product_code')?.value || '';
            const reuseLimits = {};
            for (const planType of ['plus', 'pro_5x', 'pro_20x']) {
                const value = Number(document.getElementById(`orbitcard_reuse_limit_${planType}`)?.value);
                if (!Number.isInteger(value) || value < 1 || value > 20) {
                    showMessage(`${planType} 的一卡几冲必须是 1-20 的整数`, 'warning');
                    return;
                }
                reuseLimits[planType] = value;
            }
            try {
                const res = await authFetch('/api/admin/orbitcard/product-strategy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ product_code: productCode, reuse_limits: reuseLimits })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.message || '保存开卡策略失败');
                showMessage(data.message || '开卡策略已保存', 'success');
                await loadOrbitcardProductStrategy(false);
            } catch (error) {
                showMessage(error.message || '保存开卡策略失败', 'error');
            }
        }

        async function loadOrbitcardUsage(showToast = false, refreshBalances = false, page = orbitcardUsageState.page) {
            const tbody = document.getElementById('orbitcard_usage_body');
            if (!tbody) return;
            orbitcardUsageState.page = Math.max(1, Number(page) || 1);
            try {
                const params = new URLSearchParams({
                    page: String(orbitcardUsageState.page),
                    page_size: String(orbitcardUsageState.pageSize)
                });
                if (refreshBalances) params.set('refresh', '1');
                const res = await authFetch(`/api/admin/orbitcard/usage?${params.toString()}`);
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.message || '加载 Orbitcard 用卡记录失败');
                orbitcardUsageList = Array.isArray(data.cards) ? data.cards : [];
                orbitcardUsageState.total = Number(data.total || 0);
                orbitcardUsageState.page = Number(data.page || orbitcardUsageState.page);
                renderOrbitcardUsageTable();
                renderOrbitcardUsagePagination();
                if (showToast) showMessage('Orbitcard 用卡记录已刷新', 'success');
            } catch (error) {
                console.error('loadOrbitcardUsage failed', error);
                tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--error); padding:36px 0;">${escapeHtml(error.message || '加载失败')}</td></tr>`;
                const pagination = document.getElementById('orbitcard_usage_pagination');
                if (pagination) pagination.innerHTML = '';
                if (showToast) showMessage(error.message || '加载 Orbitcard 记录失败', 'error');
            }
            lucide.createIcons();
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
                ${getPaginationItems(page, totalPages).map((item) => item === 'ellipsis'
                    ? '<span class="pagination-ellipsis">...</span>'
                    : `<button class="${item === page ? 'active' : ''}" onclick="loadOrbitcardUsage(false, false, ${item})">${item}</button>`).join('')}
                <button class="pagination-nav" onclick="loadOrbitcardUsage(false, false, ${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
            </div>`;
        }

        function formatOrbitcardPlan(planType) {
            return { plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' }[planType] || planType || '-';
        }

        function formatOrbitcardRechargeStatus(status) {
            const labels = { success: '成功', succeeded: '成功', processing: '处理中', running: '进行中', failed: '失败' };
            const label = labels[String(status || '').toLowerCase()] || String(status || '-');
            const cls = ['success', 'succeeded'].includes(String(status || '').toLowerCase())
                ? 'status-success'
                : (['failed', 'error'].includes(String(status || '').toLowerCase()) ? 'status-failed' : 'status-running');
            return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
        }

        function renderOrbitcardUsageTable() {
            const tbody = document.getElementById('orbitcard_usage_body');
            if (!tbody) return;
            if (!orbitcardUsageList.length) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-dim); padding:36px 0;">暂无 Orbitcard 用卡记录</td></tr>';
                return;
            }
            tbody.innerHTML = orbitcardUsageList.map((card) => {
                const histories = Array.isArray(card.recharges) ? card.recharges : [];
                const historyHtml = histories.length
                    ? histories.map((item) => `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:3px 0; border-bottom:1px solid var(--border);">
                        <span>${escapeHtml(item.accountEmail || '账号未返回')}</span>
                        <span style="color:var(--text-dim);">${escapeHtml(formatOrbitcardPlan(item.planType))} #${Number(item.useNumber || 0)}</span>
                        ${formatOrbitcardRechargeStatus(item.status)}
                        <span style="color:var(--text-dim);">${escapeHtml(formatTimeShort(item.createdAt))}</span>
                    </div>`).join('')
                    : '<span style="color:var(--text-dim);">暂无账号记录</span>';
                const status = String(card.status || '').toUpperCase();
                const statusLabel = status === 'PROVIDER_DELETED' ? '上游已删除' : (status === 'RETIRED' ? '已退役' : (card.inUse ? '使用中' : '可复用'));
                const statusClass = ['PROVIDER_DELETED', 'RETIRED'].includes(status) ? 'status-failed' : (card.inUse ? 'status-warning' : 'status-success');
                const balanceTitle = card.balanceUpdatedAt ? `最近查询：${formatTimeShort(card.balanceUpdatedAt)}` : '';
                const balanceText = card.balance == null
                    ? (status === 'PROVIDER_DELETED' ? '<span style="color:var(--error);">上游已删除</span>' : (card.balanceError ? `<span title="${escapeHtml(card.balanceError)}" style="color:var(--error);">${escapeHtml(card.balanceError === '上游未提供单卡余额' ? '上游未返回' : '查询失败')}</span>` : '<span style="color:var(--text-dim);">未查询</span>'))
                    : `<span title="${escapeHtml(balanceTitle)}">${Number(card.balance).toFixed(2)} ${escapeHtml(card.balanceCurrency || 'USD')}</span>${card.balanceError ? `<br><small title="${escapeHtml(card.balanceError)}" style="color:var(--error);">${escapeHtml(card.balanceError === '上游未提供单卡余额' ? '上游未提供新余额' : '刷新失败')}</small>` : ''}`;
                const canRestore = status === 'RETIRED' && !card.inUse && Number(card.usageCount || 0) < Number(card.maxUsageCount || 1);
                return `<tr>
                    <td><code>${escapeHtml(card.cardId)}</code></td>
                    <td><code>${escapeHtml(card.cardLast4 || '****')}</code></td>
                    <td>${escapeHtml(formatOrbitcardPlan(card.planType))}</td>
                    <td style="text-align:center; font-weight:600;">${Number(card.usageCount || 0)}/${Number(card.maxUsageCount || 1)}</td>
                    <td>${card.initialAmount == null ? '-' : `${Number(card.initialAmount).toFixed(2)} USD`}</td>
                    <td>${balanceText}</td>
                    <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                    <td style="min-width:300px; font-size:13px;">${historyHtml}</td>
                    <td>${escapeHtml(formatTimeShort(card.lastUsedAt))}</td>
                    <td style="text-align:center;">${canRestore ? `<button type="button" class="btn btn-success" style="padding:5px 9px; font-size:12px;" onclick="restoreOrbitcardCard(${Number(card.cardId)})">恢复</button>` : '<span style="color:var(--text-dim);">-</span>'}</td>
                </tr>`;
            }).join('');
            lucide.createIcons();
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

        function renderCardPoolStats() {
            const total = cardPoolList.length;
            let active = 0, cooldown = 0, exhausted = 0;
            for (const card of cardPoolList) {
                const status = (card.status || '').toLowerCase();
                if (!card.is_active || card.is_active === 0 || status === '已报废') {
                    exhausted++;
                } else if (status === '冷却中' || (card.cooldown_until && new Date(card.cooldown_until) > new Date())) {
                    cooldown++;
                } else {
                    active++;
                }
            }
            document.getElementById('card_stat_total').textContent = total;
            document.getElementById('card_stat_active').textContent = active;
            document.getElementById('card_stat_cooldown').textContent = cooldown;
            document.getElementById('card_stat_exhausted').textContent = exhausted;
        }

        function formatBoundAddress(card) {
            const line1 = card.payment_address_line1 || '';
            const city = card.payment_address_city || '';
            const state = card.payment_address_state || '';
            const postal = card.payment_address_postal || '';
            if (!line1 && !city) return '-';
            const parts = [line1, city, state, postal].filter(Boolean);
            return parts.join(', ');
        }

        function renderCardPoolTable() {
            const tbody = document.getElementById('card_pool_list_body');
            if (cardPoolList.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>';
                lucide.createIcons();
                return;
            }
            tbody.innerHTML = cardPoolList.map((card) => {
                const cardNumber = escapeHtml(card.card_number || card.last4 || '****');
                const cardExpiry = escapeHtml(card.card_expiry || '-');
                const cardCvc = escapeHtml(card.card_cvc || '-');
                const importHolder = escapeHtml(card.card_holder || '-');
                const paymentHolder = escapeHtml(card.payment_holder_name || '-');
                const boundAddress = escapeHtml(formatBoundAddress(card));
                const usageCount = Number(card.usage_count || 0);
                const lastUsed = card.last_used_at ? formatTimeShort(card.last_used_at) : '-';
                const statusBadge = getCardStatusBadge(card);
                return `
                <tr>
                    <td><code>${cardNumber}</code></td>
                    <td><code>${cardExpiry}</code></td>
                    <td><code>${cardCvc}</code></td>
                    <td>${importHolder}</td>
                    <td>${paymentHolder}</td>
                    <td style="font-size:12px; color:var(--text-secondary); max-width:280px; word-break:break-word;">${boundAddress}</td>
                    <td style="text-align:center">${statusBadge}</td>
                    <td style="text-align:center">${usageCount}</td>
                    <td style="text-align:center">${lastUsed}</td>
                    <td style="text-align:center">
                        <button class="btn-delete" onclick="deleteCardPoolItem(${card.id})" title="删除">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </td>
                </tr>`;
            }).join('');
            lucide.createIcons();
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

        function formatTimeShort(ts) {
            if (!ts) return '-';
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '-';
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

        async function deleteCardPoolItem(cardId) {
            const ok = await showAdminConfirm('确定删除该卡片？删除后不可恢复。', '删除卡片');
            if (!ok) return;
            try {
                const res = await authFetch(`/api/admin/cards/${cardId}`, { method: 'DELETE' });
                if (res.ok) {
                    showMessage('卡片已删除', 'success');
                    cardPoolList = cardPoolList.filter((c) => c.id !== cardId);
                    renderCardPoolStats();
                    renderCardPoolTable();
                } else {
                    const err = await res.json().catch(() => ({}));
                    showMessage(err.error || '删除失败', 'error');
                }
            } catch (e) {
                showMessage('删除请求失败', 'error');
            }
        }

        async function importCardPool() {
            const textarea = document.getElementById('card_pool_import_text');
            const resultEl = document.getElementById('card_pool_import_result');
            const btn = document.getElementById('card_pool_import_btn');
            const text = (textarea.value || '').trim();
            if (!text) {
                showMessage('请输入要导入的卡片数据', 'warning');
                return;
            }

            // Parse pipe-delimited format: number|expiry|CVC|holder
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const cards = [];
            const parseErrors = [];
            for (let i = 0; i < lines.length; i++) {
                const parts = lines[i].split('|');
                if (parts.length < 3) {
                    parseErrors.push(`第 ${i + 1} 行格式错误（需至少 3 个字段，用 | 分隔）`);
                    continue;
                }
                const card_number = (parts[0] || '').trim();
                const card_expiry = (parts[1] || '').trim();
                const card_cvc = (parts[2] || '').trim();
                const card_holder = (parts[3] || '').trim();
                cards.push({ card_number, card_expiry, card_cvc, card_holder });
            }

            if (cards.length === 0) {
                showMessage('未解析到有效卡片数据，请检查格式', 'error');
                if (parseErrors.length > 0) {
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
                    resultEl.textContent = `导入完成：成功 ${imported}，跳过 ${skipped}，失败 ${failed}${failureHint}`;
                    resultEl.style.color = imported > 0 ? 'var(--success)' : 'var(--text-dim)';
                    showMessage(`成功导入 ${imported} 张卡片`, 'success');
                    textarea.value = '';
                    await loadCardPoolList();
                } else {
                    showMessage(data.error || '导入失败', 'error');
                    resultEl.textContent = data.error || '导入失败';
                    resultEl.style.color = 'var(--error)';
                }
            } catch (e) {
                showMessage('导入请求失败', 'error');
                resultEl.textContent = '网络错误';
                resultEl.style.color = 'var(--error)';
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i data-lucide="check-check"></i> 解析并导入';
                lucide.createIcons();
            }
        }

        // ============ End Card Pool Management ============

        let activationManualHolds = [];

        function formatManualHoldPlan(planType) {
            return { plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' }[String(planType || '')] || String(planType || '-');
        }

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
                    <td>${escapeHtml(formatManualHoldPlan(hold.planType))}</td>
                    <td><code title="${escapeHtml(hold.failedJobKey || '')}">${escapeHtml(shortenJobKey(hold.failedJobKey || '-'))}</code></td>
                    <td><code>${escapeHtml(hold.cdkCode || '-')}</code></td>
                    <td style="max-width:320px; white-space:normal;">${escapeHtml(hold.reason || '-')}</td>
                    <td>${escapeHtml(formatTimeShort(hold.createdAt))}</td>
                    <td style="text-align:center;"><button type="button" class="btn btn-success" style="padding:5px 9px; font-size:12px;" onclick="resolveActivationManualHold(${Number(hold.id)})">解除</button></td>
                </tr>
            `).join('');
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
            const plan = formatManualHoldPlan(hold?.planType);
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
            if (!tbody) {
                return;
            }
            const pageData = getPageItems(logs, 'log');
            if (!pageData.items.length) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color: var(--text-dim); padding: 36px 0;">暂无任务记录</td></tr>';
                renderPagination('log_pagination', 'log', 0);
                return;
            }
            tbody.innerHTML = pageData.items.map((l) => {
                const infoParts = [];
                if (l.message) {
                    infoParts.push(escapeHtml(l.message));
                }
                if (l.automation?.phase && l.automation.phase !== l.message) {
                    infoParts.push(`<span style="color:var(--text-dim); font-size:12px;">阶段：${escapeHtml(l.automation.phase)}</span>`);
                }
                if (l.automation?.checkoutOpened) {
                    infoParts.push('<span style="color:#047857; font-size:12px;">Checkout 已打开</span>');
                }
                const infoCell = infoParts.length ? infoParts.join('<br>') : '-';
                return `
                <tr>
                    <td>${escapeHtml(l.time || '-')}</td>
                    <td><code>${escapeHtml(l.cdk || '-')}</code></td>
                    <td><code>${escapeHtml(l.token || '-')}</code></td>
                    <td>${infoCell}</td>
                    <td>
                        <div style="font-size: 12px; margin-bottom: 2px;">${l.progress}%</div>
                        <div class="progress-mini-track">
                            <div class="progress-mini-bar ${l.status}" style="width: ${l.progress}%"></div>
                        </div>
                    </td>
                    <td>${renderStatus(l.status)}</td>
                    <td style="text-align:center">
                        <div class="table-action-group">
                            <button type="button" class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" title="查看充值详细日志" data-view-task-log="${escapeHtml(l.id)}"><i data-lucide="scroll-text"></i> 日志</button>
                            <button type="button" class="btn-delete" title="删除此任务记录" data-delete-task="${escapeHtml(l.id)}"><i data-lucide="trash-2"></i></button>
                        </div>
                    </td>
                </tr>`;
            }).join('');
            renderPagination('log_pagination', 'log', pageData.total);
            lucide.createIcons();
        }

        async function deleteAdminTaskLog(jobKey) {
            const key = String(jobKey || '').trim();
            if (!key) {
                return;
            }
            const ok = await showAdminConfirm(
                `确定删除任务记录「${key}」？仅删除数据库中的本条记录，不会强制终止正在运行的子进程。`,
                '删除任务'
            );
            if (!ok) {
                return;
            }
            try {
                const res = await authFetch(`/api/admin/task-logs/${encodeURIComponent(key)}`, { method: 'DELETE' });
                let data = {};
                try {
                    data = await res.json();
                } catch (_) {
                    /* ignore */
                }
                if (!res.ok) {
                    throw new Error(data.message || `删除失败（${res.status}）`);
                }
                showMessage(data.message || '任务记录已删除', 'success');
                await loadData();
            } catch (e) {
                showMessage(e.message || '删除失败', 'error');
            }
            lucide.createIcons();
        }

        let cdkPlanTypeFilter = 'all';
        function selectCdkPlanTypeFilter(value, label) {
            cdkPlanTypeFilter = value;
            const dropdown = document.querySelector('.filter-dropdown[data-filter="cdk_plan_type_filter"]');
            dropdown.querySelector('.filter-trigger span').innerText = label;
            dropdown.querySelectorAll('.filter-option').forEach(item => {
                item.classList.toggle('active', item.textContent.trim() === label);
            });
            closeFilterMenus();
            paginationState.cdk.page = 1;
            renderCDKTable();
        }

        async function generateCDKs(btn) {
            const count = parseInt(document.getElementById('cdk_count').value, 10) || 1;
            const plan_type = document.getElementById('cdk_plan_type').value || 'plus';
            const original = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 生成中...';
            lucide.createIcons();

            try {
                const res = await authFetch('/api/admin/cdks/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ count, plan_type })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '生成失败');
                }
                showMessage(data.message || '生成成功', 'success');
                tableFilters.cdk = 'all';
                paginationState.cdk.page = 1;
                const dropdown = document.querySelector('.filter-dropdown[data-filter="cdk"] .filter-trigger span');
                if (dropdown) {
                    dropdown.textContent = '全部状态';
                }
                await loadCdkList();
            } catch (error) {
                showMessage(error.message || '生成失败', 'error');
            } finally {
                btn.innerHTML = original;
                lucide.createIcons();
            }
        }

        async function deleteCDK(cdk) {
            const ok = await showAdminConfirm(`确定删除 CDK: ${cdk} ?`, '删除 CDK');
            if (!ok) {
                return;
            }
            await authFetch(`/api/admin/cdks/${encodeURIComponent(cdk)}`, { method: 'DELETE' });
            await loadData();
        }

        function renderPhoneTable() {
            const pageData = getPageItems(getFilteredItems('phone_pool'), 'phone_pool');
            document.getElementById('phone_pool_body').innerHTML = pageData.items.map((item, index) => {
                const actualIndex = phonePool.indexOf(item);
                const isActive = isAssetActive(item);
                const key = item.phone || '';
                return `
                <tr>
                    <td class="select-cell"><input type="checkbox" ${selectedItems.phone_pool.has(key) ? 'checked' : ''} onchange="toggleSelection('phone_pool', '${key}', this.checked)"></td>
                    <td><input type="text" class="asset-input" value="${item.phone}" onchange="phonePool[${actualIndex}].phone=this.value" placeholder="13800000000"></td>
                    <td><input type="text" class="asset-input" value="${item.key}" onchange="phonePool[${actualIndex}].key=this.value" placeholder="API Key"></td>
                    <td style="text-align:center">${Number(item.usage_count || 0)}</td>
                    <td style="text-align:center">${renderAssetStatus(isActive)}</td>
                    <td style="text-align:center"><button class="btn-delete" onclick="phonePool.splice(${actualIndex},1);renderPhoneTable()" title="删除"><i data-lucide="trash-2"></i></button></td>
                </tr>
            `;
            }).join('');
            renderPagination('phone_pool_pagination', 'phone_pool', pageData.total);
            lucide.createIcons();
        }

        function formatCardExpiryForDisplay(expiry) {
            return String(expiry || '').replace(/\D/g, '').slice(0, 4);
        }

        function formatCardExpiryForSave(expiry) {
            const digits = String(expiry || '').replace(/\D/g, '').slice(0, 4);
            if (digits.length === 4) {
                return `${digits.slice(0, 2)}/${digits.slice(2)}`;
            }
            return String(expiry || '');
        }

        function renderCardTable() {
            // Legacy renderCardTable is now a no-op; card pool uses API-based rendering
            // Delegate to new loadCardPoolList if called
            loadCardPoolList();
        }

        function renderAssetStatus(isActive) {
            return isActive
                ? '<span class="status-badge status-success">正常</span>'
                : '<span class="status-badge status-failed">已作废</span>';
        }

        function getImportBoxId(type) {
            if (type === 'phone_pool') return 'phone_import_box';
            if (type === 'card_pool') return 'card_import_box';
            return 'cdk_import_box';
        }

        function toggleImportBox(type) {
            const currentBox = document.getElementById(getImportBoxId(type));
            ['phone_pool', 'card_pool', 'cdk'].forEach((key) => {
                if (key !== type) {
                    document.getElementById(getImportBoxId(key))?.classList.remove('active');
                }
            });
            currentBox?.classList.toggle('active');
        }

        function normalizeImportLines(rawText) {
            return String(rawText || '')
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
        }

        function upsertPhoneAsset(phone, key) {
            const existing = phonePool.find((item) => String(item.phone || '') === phone);
            if (existing) {
                existing.key = key;
                existing.is_active = 1;
                existing.status = 'normal';
                return false;
            }
            phonePool.push({ phone, key, usage_count: 0, is_active: 1, status: 'normal' });
            return true;
        }

        function upsertCardAsset(number, expiry, cvc) {
            const existing = cardPool.find((item) => String(item.number || '') === number);
            if (existing) {
                existing.expiry = expiry;
                existing.cvc = cvc;
                existing.is_active = 1;
                existing.status = 'normal';
                return false;
            }
            cardPool.push({ number, expiry, cvc, usage_count: 0, is_active: 1, status: 'normal' });
            return true;
        }

        function importAssets(type) {
            const isPhonePool = type === 'phone_pool';
            const textarea = document.getElementById(isPhonePool ? 'phone_import_text' : 'card_import_text');
            const lines = normalizeImportLines(textarea?.value);

            if (lines.length === 0) {
                showMessage('请输入要导入的内容', 'warning');
                return;
            }

            let createdCount = 0;
            let updatedCount = 0;

            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];

                if (isPhonePool) {
                    const match = line.match(/^([0-9]+)\s*-\s*(.+)$/);
                    if (!match) {
                        showMessage(`第 ${index + 1} 行格式错误，请使用 号码-APIKEY`, 'error');
                        return;
                    }

                    const [, phone, key] = match;
                    const isNew = upsertPhoneAsset(phone.trim(), key.trim());
                    if (isNew) createdCount += 1;
                    else updatedCount += 1;
                    continue;
                }

                const match = line.match(/^([0-9]{12,19})\s*-\s*([0-9/]{4,5})\s*-\s*([0-9]{3,4})$/);
                if (!match) {
                    showMessage(`第 ${index + 1} 行格式错误，请使用 卡号-有效期-安全码`, 'error');
                    return;
                }

                const [, number, rawExpiry, cvc] = match;
                const expiry = formatCardExpiryForDisplay(rawExpiry);
                if (expiry.length !== 4) {
                    showMessage(`第 ${index + 1} 行有效期错误，请使用 4 位 MMYY`, 'error');
                    return;
                }

                const isNew = upsertCardAsset(number.trim(), expiry, cvc.trim());
                if (isNew) createdCount += 1;
                else updatedCount += 1;
            }

            if (isPhonePool) {
                paginationState.phone_pool.page = Math.max(1, Math.ceil(phonePool.length / paginationState.phone_pool.pageSize));
                renderPhoneTable();
            } else {
                paginationState.card_pool.page = Math.max(1, Math.ceil(cardPool.length / paginationState.card_pool.pageSize));
                renderCardTable();
            }

            textarea.value = '';
            document.getElementById(isPhonePool ? 'phone_import_box' : 'card_import_box')?.classList.remove('active');
            showMessage(`导入完成，新增 ${createdCount} 条，更新 ${updatedCount} 条`, 'success');
        }

        function normalizeCdkImportValues(rawText) {
            return [...new Set(
                String(rawText || '')
                    .split(/[\s,，]+/)
                    .map((item) => item.trim())
                    .filter(Boolean)
            )];
        }

        async function importCDKs() {
            const textarea = document.getElementById('cdk_import_text');
            const codes = normalizeCdkImportValues(textarea?.value);

            if (codes.length === 0) {
                showMessage('请输入要导入的卡密', 'warning');
                return;
            }

            try {
                const res = await authFetch('/api/admin/cdks/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cdks: codes })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '导入失败');
                }
                textarea.value = '';
                document.getElementById('cdk_import_box')?.classList.remove('active');
                await loadData();
                showMessage(
                    `导入完成，新增 ${Number(data.insertedCount || 0)} 个，重复 ${Number(data.duplicateCount || 0)} 个`,
                    'success'
                );
            } catch (error) {
                showMessage(error.message || '导入失败', 'error');
            }
        }

        function addAssetRow(type) {
            if (type === 'phone_pool') {
                phonePool.push({ phone: '', key: '', usage_count: 0, is_active: 1, status: 'normal' });
                paginationState.phone_pool.page = Math.max(1, Math.ceil(phonePool.length / paginationState.phone_pool.pageSize));
                renderPhoneTable();
                return;
            }

            cardPool.push({ number: '', expiry: '', cvc: '', usage_count: 0, is_active: 1, status: 'normal' });
            paginationState.card_pool.page = Math.max(1, Math.ceil(cardPool.length / paginationState.card_pool.pageSize));
            renderCardTable();
        }

        function loadTelegramConfig(telegram) {
            const cfg = telegram || {};
            const setValue = (id, value, placeholder) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.value = value ?? '';
                if (placeholder !== undefined) {
                    el.placeholder = placeholder;
                }
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
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '保存失败');
                }
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
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '测试失败');
                }
                showMessage(data.message, 'success');
            } catch (error) {
                showMessage(error.message || 'Telegram 测试失败', 'error');
            }
        }

        function loadHcaptchaConfig(hcaptcha) {
            const cfg = hcaptcha || {};
            const setValue = (id, value, placeholder) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.value = value ?? '';
                if (placeholder !== undefined) {
                    el.placeholder = placeholder;
                }
            };
            const setChecked = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.checked = Boolean(value);
            };
            setChecked('hcaptcha_enabled', cfg.enabled !== false);
            setChecked('hcaptcha_no_vlm', cfg.no_vlm);
            const keySaved = Boolean(cfg.vlm_api_key_saved || cfg.vlm_api_key);
            const keyPreview = cfg.vlm_api_key_preview
                || (cfg.vlm_api_key ? `${cfg.vlm_api_key.slice(0, 10)}…` : '');
            const keyPlaceholder = keySaved
                ? `已保存（${keyPreview || 'sk-…'}）留空不修改`
                : 'sk-...（也可写在 .env 的 HCAPTCHA_VLM_API_KEY）';
            setValue('hcaptcha_vlm_api_key', '', keyPlaceholder);
            const platformKeySaved = Boolean(cfg.captcha_platform_api_key_saved || cfg.captcha_platform_api_key);
            const platformKeyPreview = cfg.captcha_platform_api_key_preview
                || (cfg.captcha_platform_api_key ? `${cfg.captcha_platform_api_key.slice(0, 8)}…` : '');
            const platformKeyPlaceholder = platformKeySaved
                ? `已保存（${platformKeyPreview || 'CAP-…'}）留空不修改`
                : 'clientKey（也可写在 .env 的 HCAPTCHA_CAPTCHA_PLATFORM_API_KEY）';
            setValue('hcaptcha_captcha_platform_api_key', '', platformKeyPlaceholder);
            setValue('hcaptcha_captcha_platform_api_url', cfg.captcha_platform_api_url || 'https://api.anti-captcha.com');
            setValue('hcaptcha_captcha_platform_timeout', cfg.captcha_platform_timeout || 180);
            setValue('hcaptcha_vlm_base_url', cfg.vlm_base_url || 'https://api.openai.com/v1');
            setValue('hcaptcha_vlm_model', cfg.vlm_model || 'gpt-5.5');
            setValue('hcaptcha_vlm_timeout', cfg.vlm_timeout || 45);
            setValue('hcaptcha_solver_timeout', cfg.solver_timeout || 240);
            setValue('hcaptcha_cdp_port', cfg.cdp_port || 9222);
            const hint = document.getElementById('hcaptcha_status_hint');
            if (hint) {
                if (platformKeySaved) {
                    hint.textContent = '✓ 打码平台 Key 已持久化。passive checkbox 将优先走打码平台；VLM 仅作图片题备选。';
                } else if (keySaved) {
                    hint.textContent = '✓ VLM 已持久化（MySQL + data/hcaptcha-config.json）。重建 app 容器无需重填 Key；留空保存不会覆盖已有 Key。';
                } else if (cfg.enabled === false) {
                    hint.textContent = '当前已关闭自动求解。';
                } else {
                    hint.textContent = '建议配置打码平台 API Key（推荐）。也可将 Key 写入 .env 的 HCAPTCHA_CAPTCHA_PLATFORM_API_KEY。';
                }
            }
        }

        function buildHcaptchaPayload() {
            return {
                enabled: Boolean(document.getElementById('hcaptcha_enabled')?.checked),
                vlm_api_key: document.getElementById('hcaptcha_vlm_api_key')?.value.trim() || '',
                vlm_base_url: document.getElementById('hcaptcha_vlm_base_url')?.value.trim() || 'https://api.openai.com/v1',
                vlm_model: document.getElementById('hcaptcha_vlm_model')?.value.trim() || 'gpt-5.5',
                vlm_timeout: Math.max(10, parseInt(document.getElementById('hcaptcha_vlm_timeout')?.value, 10) || 45),
                solver_timeout: Math.max(60, parseInt(document.getElementById('hcaptcha_solver_timeout')?.value, 10) || 240),
                no_vlm: Boolean(document.getElementById('hcaptcha_no_vlm')?.checked),
                cdp_port: String(document.getElementById('hcaptcha_cdp_port')?.value || '9222').trim() || '9222',
                captcha_platform_api_key: document.getElementById('hcaptcha_captcha_platform_api_key')?.value.trim() || '',
                captcha_platform_api_url: document.getElementById('hcaptcha_captcha_platform_api_url')?.value.trim() || 'https://api.anti-captcha.com',
                captcha_platform_timeout: Math.max(30, parseInt(document.getElementById('hcaptcha_captcha_platform_timeout')?.value, 10) || 180)
            };
        }

        async function saveHcaptchaConfig() {
            try {
                const res = await authFetch('/api/admin/hcaptcha', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(buildHcaptchaPayload())
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '保存失败');
                }
                showMessage(data.message, 'success');
                await reloadSystemConfigFromServer();
            } catch (error) {
                showMessage(error.message || 'hCaptcha 配置保存失败', 'error');
            }
        }

        async function testHcaptchaSolver() {
            try {
                const res = await authFetch('/api/admin/hcaptcha/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const data = await res.json();
                const hint = document.getElementById('hcaptcha_status_hint');
                if (hint) {
                    hint.textContent = data.message || data.status?.message || '';
                }
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '检测失败');
                }
                showMessage(data.message, 'success');
                await refreshHcaptchaLogs();
            } catch (error) {
                showMessage(error.message || 'hCaptcha 环境检测失败', 'error');
            }
        }

        async function testHcaptchaVlm() {
            try {
                const res = await authFetch('/api/admin/hcaptcha/test-vlm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(buildHcaptchaPayload())
                });
                const data = await res.json();
                const hint = document.getElementById('hcaptcha_status_hint');
                const detail = [
                    data.message,
                    data.model ? `model=${data.model}` : '',
                    data.latency_ms != null ? `latency=${data.latency_ms}ms` : '',
                    data.response_preview ? `reply=${data.response_preview}` : ''
                ].filter(Boolean).join(' | ');
                if (hint) hint.textContent = detail;
                if (!res.ok || !data.success) {
                    throw new Error(data.message || 'VLM 测试失败');
                }
                showMessage(data.message, 'success');
            } catch (error) {
                showMessage(error.message || 'VLM 连通性测试失败', 'error');
            }
        }

        async function testHcaptchaCaptchaPlatform() {
            try {
                const payload = buildHcaptchaPayload();
                const res = await authFetch('/api/admin/hcaptcha/test-captcha-platform', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                const hint = document.getElementById('hcaptcha_status_hint');
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '打码平台测试失败');
                }
                if (hint) {
                    hint.textContent = data.message || '打码平台连通正常';
                    hint.style.color = 'var(--success)';
                }
                showMessage(data.message || '打码平台连通正常', 'success');
            } catch (error) {
                showMessage(error.message || '打码平台测试失败', 'error');
            }
        }

        async function refreshHcaptchaLogs() {
            const panel = document.getElementById('hcaptcha_log_panel');
            const output = document.getElementById('hcaptcha_log_output');
            if (!panel || !output) return;
            try {
                const res = await authFetch('/api/admin/hcaptcha/logs?limit=10');
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '读取日志失败');
                }
                panel.style.display = 'block';
                const runtimeLines = (data.runtime || []).map((e) => `[${new Date(e.ts).toLocaleTimeString()}] ${e.text}`);
                const fileList = (data.files || []).map((f) => `${f.name} (${Math.round(f.size / 1024)}KB)`);
                let latestFileLines = [];
                if (data.files && data.files[0]) {
                    const fileRes = await authFetch(`/api/admin/hcaptcha/logs?file=${encodeURIComponent(data.files[0].name)}`);
                    const fileData = await fileRes.json();
                    if (fileRes.ok && fileData.success) {
                        latestFileLines = fileData.lines || [];
                    }
                }
                output.textContent = [
                    '=== 运行时 CAPTCHA 日志 ===',
                    ...(runtimeLines.length ? runtimeLines : ['（暂无，跑一笔任务后刷新）']),
                    '',
                    '=== Solver 文件 ===',
                    ...(fileList.length ? fileList : ['（暂无 solver 日志文件）']),
                    '',
                    '=== 最新 solver 日志尾部 ===',
                    ...(latestFileLines.length ? latestFileLines : ['（空）'])
                ].join('\n');
            } catch (error) {
                panel.style.display = 'block';
                output.textContent = `读取日志失败: ${error.message}`;
            }
        }

        async function saveAllConfigs() {
            const btn = event.currentTarget;
            const originalContent = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 处理中...';
            lucide.createIcons();

            const payload = buildConfigPayload();

            try {
                const res = await authFetch('/api/admin/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '保存失败');
                }
                showMessage(data.message, 'success');
                await loadData(true);
            } catch (error) {
                showMessage(error.message || '保存失败', 'error');
            } finally {
                btn.innerHTML = originalContent;
                lucide.createIcons();
            }
        }

        async function changeAdminPassword() {
            const btn = event.currentTarget;
            const originalContent = btn.innerHTML;
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

            btn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> 提交中...';
            lucide.createIcons();

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
                btn.innerHTML = originalContent;
                lucide.createIcons();
            }
        }

        function renderProductTable() {
            const pageData = getPageItems(getFilteredItems('product'), 'product');
            const tbody = document.getElementById('product_body');
            if (!tbody) return;

            tbody.innerHTML = pageData.items.map((p) => {
                const isActive = p.status === '正常';
                return `
                <tr>
                    <td class="select-cell"><input type="checkbox" ${selectedItems.product.has(String(p.id)) ? 'checked' : ''} onchange="toggleSelection('product', '${p.id}', this.checked)"></td>
                    <td><code>${p.email}</code></td>
                    <td>${p.claimed_cdk ? `<code>${p.claimed_cdk}</code>` : '<span style="color: var(--text-dim);">-</span>'}</td>
                    <td>
                        ${p.imap_key
                            ? `<a href="https://imap.chiyiyi.cloud/?key=${encodeURIComponent(p.imap_key)}" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: none; font-family: monospace;">${p.imap_key}</a>`
                            : '<span style="color: var(--text-dim);">-</span>'}
                    </td>
                    <td>${p.time}</td>
                    <td style="text-align:center">
                        <span class="status-badge ${isActive ? 'status-success' : 'status-failed'}" style="cursor: pointer;" onclick="toggleProductStatus('${p.id}', '${p.status}')" title="${isActive ? '点击封禁' : '点击恢复'}">${p.status}</span>
                    </td>
                    <td style="text-align:center">
                        <span class="readonly-switch ${p.shipped ? 'active' : ''}" title="${p.shipped ? '已出库' : '未出库'}"></span>
                    </td>
                    <td>
                        <div style="display: flex; justify-content: center; gap: 8px;">
                            <button class="btn-delete" style="background: rgba(16, 185, 129, 0.12); color: var(--success);" onclick="exportSingleProduct('${p.id}', '${p.email}')" title="单个出库下载">
                                <i data-lucide="download"></i>
                            </button>
                            <button class="btn-delete" onclick="deleteProduct('${p.id}')" title="删除">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
            }).join('');
            renderPagination('product_pagination', 'product', pageData.total);
            lucide.createIcons();
        }

        async function toggleProductStatus(id, currentStatus) {
            const newStatus = currentStatus === '正常' ? '封禁' : '正常';
            try {
                const res = await authFetch(`/api/admin/products/${id}/status`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: newStatus })
                });
                if (res.ok) {
                    showMessage('状态已更新', 'success');
                    loadData();
                } else {
                    showMessage('状态更新失败', 'error');
                }
            } catch (e) {
                showMessage('网络错误', 'error');
            }
        }

        async function batchDeleteProducts() {
            const selected = Array.from(selectedItems.product);
            if (selected.length === 0) {
                showMessage('请先选择要删除的成品号', 'warn');
                return;
            }
            const ok = await showAdminConfirm(
                `确定要删除选中的 ${selected.length} 个成品号吗？此操作不可恢复。`,
                '删除成品号'
            );
            if (!ok) {
                return;
            }
            let successCount = 0;
            for (const id of selected) {
                try {
                    const res = await authFetch(`/api/admin/products/${id}`, { method: 'DELETE' });
                    if (res.ok) successCount++;
                } catch (e) {
                    console.error('Delete error', e);
                }
            }
            showMessage(`成功删除 ${successCount} 个成品号`, 'success');
            selectedItems.product.clear();
            loadData(); // reload data
        }

        async function batchExportProducts() {
            const selected = Array.from(selectedItems.product);
            if (selected.length === 0) {
                showMessage('请先选择要导出的成品号', 'warn');
                return;
            }

            const okExport = await showAdminConfirm(
                `确定要将选中的 ${selected.length} 个成品号批量出库并导出为一个 JSON 文件吗？`,
                '批量出库'
            );
            if (!okExport) {
                return;
            }

            try {
                const res = await authFetch('/api/admin/products/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: selected })
                });

                if (!res.ok) {
                    let message = '批量出库失败';
                    try {
                        const data = await res.json();
                        message = data.message || message;
                    } catch (_) { }
                    throw new Error(message);
                }

                const blob = await res.blob();
                const disposition = res.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename=([^;]+)/i);
                const fileName = match ? decodeURIComponent(match[1].replace(/"/g, '').trim()) : `成品号批量出库_${Date.now()}.json`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                showMessage(`已批量出库 ${selected.length} 个成品号`, 'success');
                selectedItems.product.clear();
                loadData();
            } catch (e) {
                showMessage(e.message || '批量出库失败', 'error');
            }
        }

        async function exportSingleProduct(id, email) {
            try {
                const res = await authFetch(`/api/admin/products/${id}/export`);
                if (!res.ok) {
                    throw new Error(await res.text() || '单个出库失败');
                }

                const blob = await res.blob();
                const disposition = res.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename=([^;]+)/i);
                const fileName = match ? decodeURIComponent(match[1].replace(/"/g, '').trim()) : `成品号出库_${Date.now()}.json`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                showMessage(`已单个出库 ${email}`, 'success');
                await loadData();
            } catch (error) {
                showMessage(error.message || '单个出库失败', 'error');
            }
        }

        async function deleteProduct(id) {
            const ok = await showAdminConfirm('确定要删除该成品号吗？', '删除成品号');
            if (!ok) {
                return;
            }
            try {
                await authFetch(`/api/admin/products/${id}`, { method: 'DELETE' });
                showMessage('成品号已删除', 'success');
                await loadData();
            } catch (error) {
                showMessage(error.message, 'error');
            }
        }

        async function runAdminProductGeneration(btn, endpoint, payload, options = {}) {
            const container = document.getElementById('product_gen_progress_container');
            const bar = document.getElementById('product_gen_bar');
            const percentText = document.getElementById('product_gen_percent');
            const statusText = document.getElementById('product_gen_status');
            const count = Math.max(1, Number(options.count || payload?.count || 1));
            const wsHeartbeatIntervalMs = 5000;
            const wsHeartbeatTimeoutMs = 12000;

            if (btn.disabled) return;

            btn.disabled = true;
            const originalContent = btn.innerHTML;
            btn.innerHTML = `<i data-lucide="loader" class="animate-spin"></i> ${options.loadingText || '生产中...'}`;
            lucide.createIcons();

            if (options.switchToProducts) {
                switchPage('products');
            }

            container.style.display = 'block';
            bar.style.width = '0%';
            percentText.innerText = '0%';
            statusText.innerText = options.initialText || `准备生产 ${count} 个成品号...`;
            bar.style.background = 'linear-gradient(90deg, var(--accent), #a855f7)';

            let socket = null;
            let settled = false;
            let heartbeatInterval = null;
            let heartbeatTimeout = null;
            let reconnectTimer = null;

            const clearHeartbeat = () => {
                clearInterval(heartbeatInterval);
                clearTimeout(heartbeatTimeout);
                heartbeatInterval = null;
                heartbeatTimeout = null;
            };

            const scheduleHeartbeatTimeout = () => {
                clearTimeout(heartbeatTimeout);
                heartbeatTimeout = setTimeout(() => {
                    if (socket && !settled) {
                        console.warn('Admin product WS heartbeat timeout, reconnecting...');
                        try {
                            socket.close();
                        } catch (_) { }
                    }
                }, wsHeartbeatTimeoutMs);
            };

            const startHeartbeat = () => {
                clearHeartbeat();
                scheduleHeartbeatTimeout();
                heartbeatInterval = setInterval(() => {
                    if (!socket || socket.readyState !== WebSocket.OPEN) {
                        return;
                    }
                    try {
                        socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
                        scheduleHeartbeatTimeout();
                    } catch (error) {
                        console.error('Admin product ws ping failed', error);
                    }
                }, wsHeartbeatIntervalMs);
            };

            const cleanupSocket = () => {
                clearHeartbeat();
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
                if (socket) {
                    try { socket.close(); } catch (_) { }
                }
                socket = null;
            };

            const finish = async (message, isSuccess) => {
                if (settled) return;
                settled = true;
                cleanupSocket();
                window.__adminProductGenJobKey = '';
                setProductGenStopVisible(false);
                statusText.innerText = message;
                bar.style.background = isSuccess ? 'var(--success)' : 'var(--danger)';
                btn.disabled = false;
                btn.innerHTML = originalContent;
                lucide.createIcons();
                await loadData();
            };

            try {
                const response = await authFetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload || {})
                });
                const data = await response.json();

                if (!data.success || !data.jobKey) {
                    throw new Error(data.message || options.failMessage || '后台成品生产启动失败');
                }

                window.__adminProductGenJobKey = String(data.jobKey);
                setProductGenStopVisible(true);

                statusText.innerText = data.message || options.runningText || `后台成品生产已启动，并发上限 ${data.workerCount || 1}`;

                const connectSocket = () => {
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    socket = new WebSocket(`${protocol}//${window.location.host}`);

                    socket.onopen = () => {
                        clearTimeout(reconnectTimer);
                        reconnectTimer = null;
                        socket.send(JSON.stringify({ type: 'subscribe', jobKey: data.jobKey }));
                        startHeartbeat();
                    };

                    socket.onmessage = async (event) => {
                        try {
                            const payload = JSON.parse(event.data);
                            if (payload.type === 'pong') {
                                scheduleHeartbeatTimeout();
                                return;
                            }
                            if (payload.jobKey !== data.jobKey) return;

                            scheduleHeartbeatTimeout();

                            const progress = Math.max(0, Math.min(100, Math.round(Number(payload.progress) || 0)));
                            bar.style.width = `${progress}%`;
                            percentText.innerText = `${progress}%`;
                            if (payload.message) {
                                statusText.innerText = payload.message;
                            }

                            if (payload.status === 'success') {
                                await finish(payload.message || `成功生产 ${count} 个成品号！`, true);
                            } else if (payload.status === 'failed' || payload.status === 'maintenance') {
                                await finish(payload.message || '后台成品生产失败', false);
                            }
                        } catch (error) {
                            console.error('Admin product ws parse failed', error);
                        }
                    };

                    socket.onclose = () => {
                        clearHeartbeat();
                        socket = null;
                        if (!settled) {
                            statusText.innerText = '连接中断，正在重连...';
                            clearTimeout(reconnectTimer);
                            reconnectTimer = setTimeout(connectSocket, 3000);
                        }
                    };

                    socket.onerror = (error) => {
                        console.error('Admin product ws error', error);
                    };
                };

                connectSocket();
            } catch (error) {
                window.__adminProductGenJobKey = '';
                setProductGenStopVisible(false);
                container.style.display = 'none';
                bar.style.width = '0%';
                percentText.innerText = '0%';
                statusText.innerText = '正在准备生产环境...';
                bar.style.background = 'linear-gradient(90deg, var(--accent), #a855f7)';
                btn.disabled = false;
                btn.innerHTML = originalContent;
                lucide.createIcons();
                showMessage(error.message || options.failMessage || '后台成品生产启动失败', 'error');
            }
        }

        async function startProductGeneration(btn) {
            const count = parseInt(document.getElementById('product_gen_count').value, 10) || 1;
            await runAdminProductGeneration(btn, '/api/admin/products/generate', { count }, {
                count,
                loadingText: '生产中...',
                initialText: `准备生产 ${count} 个成品号...`,
                failMessage: '后台成品生产启动失败'
            });
        }

        async function resumePendingProducts(btn) {
            const count = Math.max(1, Number(btn?.dataset?.count || 1));
            await runAdminProductGeneration(btn, '/api/admin/products/resume', {}, {
                count,
                loadingText: '继续中...',
                initialText: `准备继续生产剩余 ${count} 个成品号...`,
                failMessage: '继续生产启动失败',
                switchToProducts: true
            });
        }

        // ==================== 账单记录 ====================
        const billingState = { page: 1, pageSize: 20, total: 0 };

        function getBillingFilters() {
            return {
                start_date: document.getElementById('billing_start_date')?.value || '',
                end_date: document.getElementById('billing_end_date')?.value || '',
                card_last4: document.getElementById('billing_card_last4')?.value.trim() || '',
                plan_type: document.getElementById('billing_plan_type')?.value || '',
                status: document.getElementById('billing_status')?.value || ''
            };
        }

        async function loadBillingRecords(page) {
            billingState.page = page || billingState.page;
            const filters = getBillingFilters();
            const params = new URLSearchParams();
            if (filters.start_date) params.set('start_date', filters.start_date);
            if (filters.end_date) params.set('end_date', filters.end_date);
            if (filters.card_last4) params.set('card_last4', filters.card_last4);
            if (filters.plan_type) params.set('plan_type', filters.plan_type);
            if (filters.status) params.set('status', filters.status);
            params.set('page', billingState.page);

            try {
                const res = await authFetch(`/api/admin/billing?${params.toString()}`);
                const data = await res.json();
                if (!data.success) {
                    showMessage(data.error || '查询失败', 'error');
                    return;
                }
                billingState.total = data.total || 0;
                renderBillingTable(data.records || []);
                renderBillingPagination();
                const hint = document.getElementById('billing_total_hint');
                if (hint) hint.textContent = `共 ${billingState.total} 条记录`;
            } catch (e) {
                showMessage('查询账单失败: ' + e.message, 'error');
            }
        }

        function renderBillingTable(records) {
            const tbody = document.getElementById('billing_body');
            if (!tbody) return;
            if (!records.length) {
                tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-dim); padding:32px;">暂无账单记录</td></tr>`;
                return;
            }
            const planLabels = { plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' };
            tbody.innerHTML = records.map(r => {
                const time = r.payment_time ? new Date(r.payment_time).toLocaleString('zh-CN') : '-';
                const statusClass = r.status === 'success' ? 'status-success' : 'status-failed';
                const statusText = r.status === 'success' ? '成功' : '失败';
                const planLabel = planLabels[r.plan_type] || r.plan_type || '-';
                const cardDisplay = escapeHtml(r.card_number || r.card_last4 || '-');
                const cardSummaryKey = escapeHtml(r.card_last4 || (r.card_number ? String(r.card_number).slice(-4) : ''));
                return `<tr>
                    <td>${escapeHtml(time)}</td>
                    <td><a href="javascript:void(0)" onclick="showCardBillingSummary('${cardSummaryKey}')" style="cursor:pointer; color:var(--primary); font-weight:600; font-family:monospace;">${cardDisplay}</a></td>
                    <td>${escapeHtml(r.amount != null ? Number(r.amount).toFixed(2) : '-')}</td>
                    <td>${escapeHtml(r.currency || '-')}</td>
                    <td>${escapeHtml(planLabel)}</td>
                    <td style="font-family:monospace; font-size:12px;">${escapeHtml(r.cdk_code || '-')}</td>
                    <td style="font-size:12px;">${escapeHtml(r.email || '-')}</td>
                    <td style="text-align:center"><span class="status-badge ${statusClass}">${statusText}</span></td>
                    <td style="text-align:center">
                        <button type="button" class="btn-delete" data-delete-billing="${escapeHtml(String(r.id))}" title="删除此账单">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </td>
                </tr>`;
            }).join('');
            lucide.createIcons();
        }

        async function deleteBillingRecord(id) {
            if (!id) {
                return;
            }
            const ok = await showAdminConfirm('确定删除这条账单记录吗？');
            if (!ok) {
                return;
            }
            try {
                const res = await authFetch(`/api/admin/billing/${encodeURIComponent(id)}`, { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '删除失败');
                }
                showMessage('账单记录已删除', 'success');
                await loadBillingRecords();
            } catch (error) {
                showMessage(error.message || '删除失败', 'error');
            }
        }

        async function clearFailedBillingRecords() {
            const ok = await showAdminConfirm('确定清除所有失败状态的账单记录吗？此操作不可恢复。');
            if (!ok) {
                return;
            }
            try {
                const res = await authFetch('/api/admin/billing/failed', { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '清除失败');
                }
                showMessage(`已清除 ${data.deleted || 0} 条失败账单`, 'success');
                await loadBillingRecords(1);
            } catch (error) {
                showMessage(error.message || '清除失败', 'error');
            }
        }

        function renderBillingPagination() {
            const container = document.getElementById('billing_pagination');
            if (!container) return;
            const totalPages = Math.max(1, Math.ceil(billingState.total / billingState.pageSize));
            const page = billingState.page;
            const start = billingState.total === 0 ? 0 : ((page - 1) * billingState.pageSize) + 1;
            const end = Math.min(page * billingState.pageSize, billingState.total);

            let paginationHtml = `<div class="pagination-meta">显示 ${start}-${end}，共 ${billingState.total} 条</div>`;
            paginationHtml += `<div class="pagination">`;
            paginationHtml += `<button class="pagination-nav" onclick="loadBillingRecords(${page - 1})" ${page <= 1 ? 'disabled' : ''}>上一页</button>`;
            // Page numbers
            const items = getBillingPaginationItems(page, totalPages);
            items.forEach(item => {
                if (item === '...') {
                    paginationHtml += `<span class="pagination-ellipsis">...</span>`;
                } else {
                    paginationHtml += `<button class="${item === page ? 'active' : ''}" onclick="loadBillingRecords(${item})">${item}</button>`;
                }
            });
            paginationHtml += `<button class="pagination-nav" onclick="loadBillingRecords(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页</button>`;
            paginationHtml += `</div>`;
            container.innerHTML = paginationHtml;
        }

        function getBillingPaginationItems(current, totalPages) {
            if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
            const items = [];
            items.push(1);
            if (current > 3) items.push('...');
            for (let i = Math.max(2, current - 1); i <= Math.min(totalPages - 1, current + 1); i++) {
                items.push(i);
            }
            if (current < totalPages - 2) items.push('...');
            items.push(totalPages);
            return items;
        }

        async function exportBillingCSV() {
            const filters = getBillingFilters();
            const params = new URLSearchParams();
            if (filters.start_date) params.set('start_date', filters.start_date);
            if (filters.end_date) params.set('end_date', filters.end_date);
            if (filters.card_last4) params.set('card_last4', filters.card_last4);
            if (filters.plan_type) params.set('plan_type', filters.plan_type);
            if (filters.status) params.set('status', filters.status);

            try {
                const res = await authFetch(`/api/admin/billing/export?${params.toString()}`);
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    showMessage(errData.error || '导出失败', 'error');
                    return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `billing_export_${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showMessage('CSV 导出成功', 'success');
            } catch (e) {
                showMessage('导出 CSV 失败: ' + e.message, 'error');
            }
        }

        async function showCardBillingSummary(cardLast4) {
            if (!cardLast4) return;
            const panel = document.getElementById('billing_summary_panel');
            const title = document.getElementById('billing_summary_title');
            const stats = document.getElementById('billing_summary_stats');
            if (!panel || !title || !stats) return;

            title.textContent = `卡片 **** ${cardLast4} 消费汇总`;
            stats.innerHTML = `<div style="padding:20px; color:var(--text-dim);">加载中...</div>`;
            panel.style.display = 'block';
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            try {
                const res = await authFetch(`/api/admin/billing/summary/${encodeURIComponent(cardLast4)}`);
                const data = await res.json();
                if (!data.success) {
                    stats.innerHTML = `<div style="padding:20px; color:var(--error);">${escapeHtml(data.error || '查询失败')}</div>`;
                    return;
                }
                const summary = data;
                stats.innerHTML = `
                    <div class="stat-card">
                        <div class="stat-header">
                            <span class="stat-label">累计消费金额</span>
                            <div class="stat-icon" style="background: rgba(16, 185, 129, 0.1); color: #10b981;">
                                <i data-lucide="banknote"></i>
                            </div>
                        </div>
                        <div class="stat-value" style="color: #047857;">${Number(summary.cumulative_amount || 0).toFixed(2)}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-header">
                            <span class="stat-label">成功支付次数</span>
                            <div class="stat-icon" style="background: rgba(16, 185, 129, 0.1); color: #10b981;">
                                <i data-lucide="check-circle"></i>
                            </div>
                        </div>
                        <div class="stat-value" style="color: var(--success);">${summary.success_count || 0}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-header">
                            <span class="stat-label">失败支付次数</span>
                            <div class="stat-icon" style="background: rgba(239, 68, 68, 0.1); color: #f87171;">
                                <i data-lucide="x-circle"></i>
                            </div>
                        </div>
                        <div class="stat-value" style="color: var(--error);">${summary.failed_count || 0}</div>
                    </div>
                `;
                lucide.createIcons();
            } catch (e) {
                stats.innerHTML = `<div style="padding:20px; color:var(--error);">加载失败: ${escapeHtml(e.message)}</div>`;
            }
        }

        function closeBillingSummary() {
            const panel = document.getElementById('billing_summary_panel');
            if (panel) panel.style.display = 'none';
        }

        async function bootAdmin() {
            try {
                const res = await fetch('/api/public/admin-paths');
                const data = await res.json();
                if (data.success && data.loginUrl) {
                    adminLoginPath = data.loginUrl;
                }
            } catch (_) { }

            document.getElementById('admin_login_path')?.addEventListener('input', updateAdminPathPreview);
            document.getElementById('admin_panel_path')?.addEventListener('input', updateAdminPathPreview);

            if (!getAdminToken()) {
                redirectToLogin();
                return;
            }

            try {
                await ensureAdminSession();
                await loadData(true);
                await loadRegionConfig();
                await loadGptApiConfig();
                if (adminDataRefreshTimer) {
                    clearInterval(adminDataRefreshTimer);
                }
                adminDataRefreshTimer = setInterval(() => {
                    if (!adminDataRefreshPaused) {
                        loadData(false).catch(() => { });
                    }
                }, 3000);
                updateAdminDataRefreshButton();
                lucide.createIcons();
            } catch (error) {
                console.error('Admin boot failed', error);
            }
        }

        document.getElementById('maintenance_mode')?.addEventListener('change', () => {
            if (maintenanceModeSaving) {
                return;
            }
            saveMaintenanceMode().catch((error) => {
                console.error('Maintenance mode save failed', error);
            });
        });

        document.querySelectorAll('input[name="email_source"]').forEach((el) => {
            el.addEventListener('change', () => syncEmailSourceUI());
        });

        // ─── Region & Address Management ───────────────────────────────────────────
        let regionAddressList = [];
        let currentRegion = 'PH';
        let checkoutPlanMap = { plus: 'chatgptplusplan', pro_5x: 'chatgptprolite', pro_20x: 'chatgptpro' };
        let checkoutDebugJobKey = '';
        let checkoutDebugLogAfter = 0;
        let checkoutDebugLogText = '';
        let checkoutDebugLogPollTimer = null;
        let checkoutDebugStatusPollTimer = null;

        function clearCheckoutDebugForm() {
            const input = document.getElementById('checkout_session_input');
            if (input) input.value = '';
            const box = document.getElementById('checkout_result_box');
            if (box) box.style.display = 'none';
            const pre = document.getElementById('checkout_debug_log_pre');
            if (pre) pre.textContent = '';
            checkoutDebugLogText = '';
            checkoutDebugLogAfter = 0;
        }

        function appendCheckoutDebugLogEntries(entries) {
            if (!entries || !entries.length || !checkoutDebugJobKey) {
                return;
            }
            const filtered = entries.filter((entry) => entry.jobKey === checkoutDebugJobKey);
            if (!filtered.length) {
                return;
            }
            const chunk = filtered.map(formatRuntimeLogLine).join('\n') + '\n';
            checkoutDebugLogText += chunk;
            if (checkoutDebugLogText.length > 120000) {
                checkoutDebugLogText = checkoutDebugLogText.slice(-100000);
            }
            const pre = document.getElementById('checkout_debug_log_pre');
            if (!pre) return;
            pre.textContent = checkoutDebugLogText;
            const autoscroll = document.getElementById('checkout_log_autoscroll');
            const wrap = pre.parentElement;
            if (autoscroll && autoscroll.checked && wrap) {
                wrap.scrollTop = wrap.scrollHeight;
            }
        }

        function stopCheckoutDebugLogStream() {
            if (checkoutDebugLogPollTimer) {
                clearInterval(checkoutDebugLogPollTimer);
                checkoutDebugLogPollTimer = null;
            }
            if (checkoutDebugStatusPollTimer) {
                clearInterval(checkoutDebugStatusPollTimer);
                checkoutDebugStatusPollTimer = null;
            }
        }

        async function fetchCheckoutDebugLogsTail() {
            const res = await authFetch('/api/admin/runtime-logs?tail=1&limit=2000');
            const data = await res.json();
            if (!data.success) {
                throw new Error(data.message || '加载日志失败');
            }
            checkoutDebugLogAfter = Number(data.nextAfter || 0);
            if (!checkoutDebugJobKey) {
                return;
            }
            const filtered = (data.entries || []).filter((entry) => entry.jobKey === checkoutDebugJobKey);
            checkoutDebugLogText = filtered.map(formatRuntimeLogLine).join('\n');
            if (checkoutDebugLogText) checkoutDebugLogText += '\n';
            const pre = document.getElementById('checkout_debug_log_pre');
            if (pre) {
                pre.textContent = checkoutDebugLogText;
                const wrap = pre.parentElement;
                const autoscroll = document.getElementById('checkout_log_autoscroll');
                if (autoscroll && autoscroll.checked && wrap) {
                    wrap.scrollTop = wrap.scrollHeight;
                }
            }
        }

        async function fetchCheckoutDebugLogsIncremental() {
            if (!checkoutDebugJobKey) return;
            try {
                const res = await authFetch(`/api/admin/runtime-logs?after=${checkoutDebugLogAfter}&limit=500`);
                const data = await res.json();
                if (!data.success) return;
                if (data.entries && data.entries.length) {
                    appendCheckoutDebugLogEntries(data.entries);
                }
                checkoutDebugLogAfter = Number(data.nextAfter || checkoutDebugLogAfter);
            } catch (_) { /* ignore */ }
        }

        function startCheckoutDebugLogStream() {
            stopCheckoutDebugLogStream();
            if (checkoutDebugJobKey) {
                fetchCheckoutDebugLogsTail().catch(() => { });
            }
            checkoutDebugLogPollTimer = setInterval(() => {
                fetchCheckoutDebugLogsIncremental();
            }, 1500);
            checkoutDebugStatusPollTimer = setInterval(() => {
                pollCheckoutDebugStatus(false);
            }, 2000);
        }

        async function refreshCheckoutDebugLogs() {
            try {
                await fetchCheckoutDebugLogsTail();
                await pollCheckoutDebugStatus(true);
                showMessage('日志已刷新', 'success');
            } catch (e) {
                showMessage(e.message || '刷新失败', 'error');
            }
        }

        function renderCheckoutDebugStatus(data) {
            const box = document.getElementById('checkout_result_box');
            const statusEl = document.getElementById('checkout_result_status');
            const emailEl = document.getElementById('checkout_result_email');
            const urlWrap = document.getElementById('checkout_result_url_wrap');
            const shotWrap = document.getElementById('checkout_screenshot_wrap');
            const hint = document.getElementById('checkout_job_hint');
            if (box) box.style.display = 'block';

            const status = data.status || 'running';
            const checkoutUrl = data.checkout_url || '';
            if (hint && checkoutDebugJobKey) {
                hint.textContent = `Job: ${checkoutDebugJobKey}`;
            }
            if (statusEl) {
                if (status === 'success') {
                    statusEl.textContent = '✅ 支付链接已生成';
                    statusEl.style.color = 'var(--success, #22c55e)';
                } else if (status === 'running') {
                    statusEl.textContent = '⏳ 浏览器调试进行中...';
                    statusEl.style.color = 'var(--text-dim)';
                } else {
                    statusEl.textContent = `❌ ${data.message || '调试失败'}`;
                    statusEl.style.color = 'var(--error, #ef4444)';
                }
            }
            if (emailEl && data.email) {
                emailEl.textContent = `账号: ${data.email}`;
            }
            if (urlWrap) {
                urlWrap.innerHTML = checkoutUrl
                    ? `<a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener" style="color: var(--primary);">${escapeHtml(checkoutUrl)}</a>`
                    : (status === 'running' ? '<span style="color:var(--text-dim); font-size:13px;">等待 Checkout URL...</span>' : '');
            }
            if (shotWrap) {
                const shots = Array.isArray(data.screenshots) ? data.screenshots : [];
                if (shots.length) {
                    shotWrap.innerHTML = `<div style="font-size:13px; margin-bottom:8px; color:var(--text-dim);">失败截图 (${shots.length})</div>`
                        + shots.map((p) => `<div style="margin-bottom:10px;"><img src="${buildScreenshotUrl(p)}" alt="${escapeHtml(p)}" style="max-width:100%; border-radius:8px; border:1px solid var(--divider);"></div>`).join('');
                } else {
                    shotWrap.innerHTML = '';
                }
            }
        }

        async function pollCheckoutDebugStatus(forceToast) {
            if (!checkoutDebugJobKey) return;
            try {
                const res = await authFetch(`/api/admin/checkout/status/${encodeURIComponent(checkoutDebugJobKey)}`);
                const data = await res.json();
                if (!data.success) return;
                renderCheckoutDebugStatus(data);
                if (data.status === 'success' || data.status === 'failed') {
                    if (checkoutDebugStatusPollTimer) {
                        clearInterval(checkoutDebugStatusPollTimer);
                        checkoutDebugStatusPollTimer = null;
                    }
                    const btn = document.getElementById('checkout_generate_btn');
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '<i data-lucide="play"></i> 启动浏览器调试';
                        lucide.createIcons();
                    }
                    if (forceToast) {
                        showMessage(data.status === 'success' ? '支付链接生成成功' : (data.message || '调试失败'), data.status === 'success' ? 'success' : 'error');
                    }
                }
            } catch (_) { /* ignore */ }
        }

        async function startCheckoutDebug() {
            const sessionRaw = document.getElementById('checkout_session_input')?.value?.trim();
            const planType = document.getElementById('checkout_plan_type')?.value || 'plus';
            syncCheckoutPlanName();
            const planName = getCheckoutPlanNameForSubmit();
            const regionSel = document.getElementById('checkout_region_selector');
            const region = regionSel?.value || currentRegion;
            const btn = document.getElementById('checkout_generate_btn');

            if (!sessionRaw) {
                showMessage('请粘贴 Session JSON', 'warning');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i data-lucide="loader"></i> 启动中...';
                lucide.createIcons();
            }

            checkoutDebugLogText = '';
            checkoutDebugLogAfter = 0;
            checkoutDebugJobKey = '';
            const pre = document.getElementById('checkout_debug_log_pre');
            if (pre) pre.textContent = '';

            try {
                const res = await authFetch('/api/admin/checkout/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session: sessionRaw,
                        plan_type: planType,
                        plan_name: planName || undefined,
                        country: region
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '启动失败');
                }

                checkoutDebugJobKey = data.jobKey;
                renderCheckoutDebugStatus({ status: 'running', email: data.email, checkout_url: '', screenshots: [] });
                showMessage(`浏览器任务已启动：${data.jobKey}`, 'success');
                startCheckoutDebugLogStream();
            } catch (e) {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i data-lucide="play"></i> 启动浏览器调试';
                    lucide.createIcons();
                }
                showMessage(e.message || '启动失败', 'error');
            }
        }

        function onCheckoutRegionChange() {
            const sel = document.getElementById('checkout_region_selector');
            if (sel) currentRegion = sel.value || currentRegion;
            const labels = { PH: '菲律宾 / PHP', US: '美国 / USD', SG: '新加坡 / SGD', MY: '马来西亚 / MYR' };
            updateCheckoutRegionHint(labels[currentRegion] || currentRegion, '');
        }

        async function loadCheckoutDebugPage() {
            await loadRegionConfig();
            await loadCheckoutPlans();
            const sel = document.getElementById('checkout_region_selector');
            if (sel) sel.value = currentRegion;
            onCheckoutRegionChange();
            lucide.createIcons();
        }

        function renderCheckoutPlanTypeOptions() {
            const sel = document.getElementById('checkout_plan_type');
            if (!sel) return;
            const labels = { plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x' };
            const current = sel.value || 'plus';
            sel.innerHTML = Object.keys(checkoutPlanMap).map((key) => {
                const name = checkoutPlanMap[key] || checkoutPlanMap.plus;
                return `<option value="${escapeHtml(key)}">${escapeHtml(labels[key] || key)} — ${escapeHtml(name)}</option>`;
            }).join('');
            sel.value = checkoutPlanMap[current] ? current : 'plus';
            syncCheckoutPlanName();
        }

        function syncCheckoutPlanName() {
            const planType = document.getElementById('checkout_plan_type')?.value || 'plus';
            const input = document.getElementById('checkout_plan_name');
            const mapped = checkoutPlanMap[planType] || checkoutPlanMap.plus || 'chatgptplusplan';
            if (input) {
                input.value = mapped;
                input.dataset.autoValue = mapped;
            }
        }

        function getCheckoutPlanNameForSubmit() {
            const planType = document.getElementById('checkout_plan_type')?.value || 'plus';
            const input = document.getElementById('checkout_plan_name');
            const mapped = checkoutPlanMap[planType] || checkoutPlanMap.plus || 'chatgptplusplan';
            const typed = String(input?.value || '').trim();
            // 仅当用户手动改过 plan_name 时才作为 override 提交
            if (typed && typed !== mapped && typed !== input?.dataset?.autoValue) {
                return typed;
            }
            return undefined;
        }

        function updateCheckoutRegionHint(label, currency) {
            const hint = document.getElementById('checkout_region_hint');
            if (hint) {
                hint.textContent = `将使用: ${label || currentRegion} / ${currency || ''}`;
            }
        }

        async function loadCheckoutPlans() {
            try {
                const res = await authFetch('/api/admin/checkout/plans');
                const data = await res.json();
                if (data.success && data.plans) {
                    checkoutPlanMap = data.plans;
                    renderCheckoutPlanTypeOptions();
                    updateCheckoutRegionHint(data.label, data.currency);
                }
            } catch (e) {
                renderCheckoutPlanTypeOptions();
            }
        }

        async function loadRegionConfig() {
            try {
                const res = await authFetch('/api/admin/region');
                const data = await res.json();
                if (data.success) {
                    currentRegion = data.region || 'PH';
                    const sel = document.getElementById('region_selector');
                    if (sel) sel.value = currentRegion;
                    const badge = document.getElementById('region_current_badge');
                    if (badge) badge.textContent = `当前: ${data.label || currentRegion} (${data.currency || 'USD'})`;
                    updateCheckoutRegionHint(data.label, data.currency);
                }
            } catch (e) {
                console.error('loadRegionConfig failed', e);
            }
        }

        async function savePaymentRegion() {
            const sel = document.getElementById('region_selector');
            const region = sel ? sel.value : '';
            if (!region) {
                showMessage('请选择地区', 'warning');
                return;
            }
            try {
                const res = await authFetch('/api/admin/region', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ region })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '保存失败');
                }
                currentRegion = data.region;
                const badge = document.getElementById('region_current_badge');
                if (badge) badge.textContent = `当前: ${data.label || currentRegion} (${data.currency || 'USD'})`;
                updateCheckoutRegionHint(data.label, data.currency);
                showMessage('支付地区已更新', 'success');
            } catch (e) {
                showMessage(e.message || '保存地区失败', 'error');
            }
            lucide.createIcons();
        }

        // ─── 第三方代充 API 配置 ─────────────────────────────────────────────
        async function loadGptApiConfig() {
            try {
                const res = await authFetch('/api/admin/gpt-api');
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '加载 API 配置失败');
                }
                const cfg = data.config || {};
                const enabledEl = document.getElementById('gpt_api_enabled');
                if (enabledEl) enabledEl.checked = Boolean(cfg.enabled);
                const baseUrlEl = document.getElementById('gpt_api_base_url');
                if (baseUrlEl) baseUrlEl.value = cfg.base_url || '';
                const keyEl = document.getElementById('gpt_api_key');
                const planKeyEl = document.getElementById('gpt_api_plan_key');
                const keyHint = document.getElementById('gpt_api_key_hint');
                const cardSourceEl = document.getElementById('gpt_api_card_source');
                const orbitBaseEl = document.getElementById('orbitcard_base_url');
                const orbitKeyEl = document.getElementById('orbitcard_api_key');
                const orbitKeyHint = document.getElementById('orbitcard_api_key_hint');
                const orbitSecretEl = document.getElementById('orbitcard_api_secret');
                const orbitSecretHint = document.getElementById('orbitcard_api_secret_hint');
                if (keyEl) keyEl.value = '';
                if (keyEl) keyEl.placeholder = cfg.api_key_saved
                    ? `已保存（${cfg.api_key_preview || 'ap_live_…'}）留空不修改`
                    : 'ap_live_...';
                if (planKeyEl) planKeyEl.value = cfg.plan_key || '';
                if (cardSourceEl) cardSourceEl.value = cfg.card_source || 'local';
                if (orbitBaseEl) orbitBaseEl.value = cfg.orbitcard_base_url || 'https://orbitcard.cc';
                if (orbitKeyEl) orbitKeyEl.value = '';
                if (orbitKeyHint) orbitKeyHint.textContent = cfg.orbitcard_api_key_saved ? `✓ API Key 已保存（${cfg.orbitcard_api_key_preview || '已隐藏'}）` : '尚未配置 Orbitcard API Key';
                if (orbitSecretEl) {
                    orbitSecretEl.value = '';
                    orbitSecretEl.placeholder = cfg.orbitcard_api_secret_configured ? `已保存（${cfg.orbitcard_api_secret_preview || '已隐藏'}）留空不修改` : '填写 Orbitcard Secret';
                }
                if (orbitSecretHint) orbitSecretHint.textContent = cfg.orbitcard_api_secret_configured
                    ? '✓ Orbitcard Secret 已保存，留空不修改'
                    : '尚未配置 Orbitcard Secret';
                updateOrbitcardConfigVisibility();
                if (keyHint) {
                    keyHint.textContent = cfg.api_key_saved ? '✓ API Key 已保存' : '尚未配置 API Key';
                }
                if (cfg.api_key_saved) refreshGptApiStatus();
            } catch (e) {
                console.error('loadGptApiConfig failed', e);
            }
        }

        function buildGptApiPayload() {
            return {
                enabled: Boolean(document.getElementById('gpt_api_enabled')?.checked),
                base_url: document.getElementById('gpt_api_base_url')?.value.trim() || '',
                api_key: document.getElementById('gpt_api_key')?.value.trim() || '',
                plan_key: document.getElementById('gpt_api_plan_key')?.value.trim() || '',
                card_source: document.getElementById('gpt_api_card_source')?.value || 'local',
                orbitcard_base_url: document.getElementById('orbitcard_base_url')?.value.trim() || '',
                orbitcard_api_key: document.getElementById('orbitcard_api_key')?.value.trim() || '',
                orbitcard_api_secret: document.getElementById('orbitcard_api_secret')?.value.trim() || ''
            };
        }

        function updateOrbitcardConfigVisibility() {
            const source = document.getElementById('gpt_api_card_source')?.value || 'local';
            const fields = document.getElementById('orbitcard_config_fields');
            if (fields) fields.style.display = source === 'orbitcard' ? 'block' : 'none';
        }

        async function saveGptApiConfig() {
            try {
                const res = await authFetch('/api/admin/gpt-api', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(buildGptApiPayload())
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.message || '保存失败');
                }
                showMessage(data.message, 'success');
                await loadGptApiConfig();
            } catch (error) {
                showMessage(error.message || '第三方代充 API 配置保存失败', 'error');
            }
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
                ? `Plus=${mappings.plus || '—'}、Pro 5x=${mappings.pro_5x || '—'}、Pro 20x=${mappings.pro_20x || '—'}`
                : (gptPlans.length
                    ? gptPlans.map((p) => `${p.name || p.key} (${p.key || '—'})`).join('、')
                    : (data.configured_plan ? `已配置代码：${data.configured_plan}` : '供应商未提供套餐列表'));
            const creditPlans = data.credit_plans || [];
            document.getElementById('gpt_api_credit_plans').textContent = creditPlans.length
                ? creditPlans.map((p) => `${p.name || p.id}: ${p.credits ?? '—'} 積分`).join('、')
                : '無';
            const orders = data.recent_orders || [];
            document.getElementById('gpt_api_recent_orders').innerHTML = orders.length
                ? `<table style="width:100%; border-collapse:collapse"><thead><tr><th style="text-align:left">訂單</th><th style="text-align:left">狀態</th><th style="text-align:left">套餐卡密</th><th style="text-align:left">更新時間</th></tr></thead><tbody>${orders.map((o) => `<tr><td>${escapeHtml(String(o.order_id || o.task_id || '—'))}</td><td>${escapeHtml(o.status || '—')}</td><td>${escapeHtml(o.topup_code || '—')}</td><td>${escapeHtml(o.updated_at || '—')}</td></tr>`).join('')}</tbody></table>`
                : '尚無失敗的第三方代充訂單';
            document.getElementById('gpt_api_status_hint').textContent = data.balance_error
                ? `積分查詢失敗：${data.balance_error}`
                : `${data.card_source_message || (data.card_source?.source === 'orbitcard' ? `Orbitcard 可用卡 ${data.card_source.cardCount ?? '—'} 张` : '卡源：本地卡池')}；${data.account
                    ? `账户：${data.account.email || data.account.accountName || '—'}；数据来自供应商账户接口，完整卡密不会由接口回传。`
                    : '数据来自供应商账户接口；完整卡密不会由接口回传。'}`;
        }

        async function readApiJson(response, fallbackMessage) {
            const contentType = response.headers.get('content-type') || '';
            const text = await response.text();
            if (!contentType.includes('application/json')) {
                const preview = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
                throw new Error(`${fallbackMessage}：伺服器回傳 HTML，請重新啟動應用服務後再試${preview ? `（${preview}）` : ''}`);
            }
            try {
                return JSON.parse(text);
            } catch (_) {
                throw new Error(`${fallbackMessage}：伺服器回傳了無法解析的 JSON`);
            }
        }

        async function refreshGptApiStatus() {
            try {
                const res = await authFetch('/api/admin/gpt-api/status');
                const data = await readApiJson(res, '狀態查詢失敗');
                if (!res.ok || !data.success) throw new Error(data.message || '狀態查詢失敗');
                renderGptApiStatus(data);
            } catch (error) {
                document.getElementById('gpt_api_status_hint').textContent = error.message || '狀態查詢失敗';
            }
            lucide.createIcons();
        }

        async function testGptApiConnection() {
            const payload = buildGptApiPayload();
            const hasSavedKey = Boolean(document.getElementById('gpt_api_key_hint')?.textContent.includes('已保存'));
            if (!payload.api_key && !hasSavedKey) {
                showMessage('請先填寫並保存 API Key', 'warning');
                return;
            }
            try {
                const res = await authFetch('/api/admin/gpt-api/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await readApiJson(res, 'API 連線測試失敗');
                if (!res.ok || !data.success) throw new Error(data.message || '連線失敗');
                showMessage(data.message, 'success');
                await refreshGptApiStatus();
            } catch (error) {
                showMessage(error.message || 'API 連線測試失敗', 'error');
            }
        }

        document.getElementById('gpt_api_card_source')?.addEventListener('change', () => {
            updateOrbitcardConfigVisibility();
        });

        const US_TAX_FREE_STATE_NAMES = ['Oregon', 'Delaware', 'Montana', 'New Hampshire', 'Alaska'];
        const US_STATE_ABBR_MAP = { OR: 'Oregon', DE: 'Delaware', MT: 'Montana', NH: 'New Hampshire', AK: 'Alaska' };

        function normalizeUsStateInput(state) {
            const raw = String(state || '').trim();
            if (!raw) return raw;
            const upper = raw.toUpperCase();
            if (US_STATE_ABBR_MAP[upper]) return US_STATE_ABBR_MAP[upper];
            return raw;
        }

        async function loadAddressList(region) {
            try {
                const res = await authFetch(`/api/admin/addresses?region=${encodeURIComponent(region)}`);
                const data = await res.json();
                if (data.success) {
                    regionAddressList = data.addresses || [];
                } else {
                    regionAddressList = [];
                }
            } catch (e) {
                regionAddressList = [];
            }
            renderAddressTable();
        }

        function renderAddressTable() {
            const tbody = document.getElementById('address_list_body');
            const hint = document.getElementById('address_empty_hint');
            if (!tbody) return;
            if (regionAddressList.length === 0) {
                tbody.innerHTML = '';
                if (hint) hint.style.display = 'block';
                lucide.createIcons();
                return;
            }
            if (hint) hint.style.display = 'none';
            tbody.innerHTML = regionAddressList.map((addr) => {
                const isBound = Number(addr.is_bound) === 1;
                const statusBadge = isBound
                    ? '<span class="status-badge status-success">已绑定</span>'
                    : '<span class="status-badge" style="opacity:.85;">未绑定</span>';
                const editBtn = isBound
                    ? '<button class="btn-delete" disabled style="opacity:0.4;cursor:not-allowed;" title="已绑定不可编辑"><i data-lucide="pencil"></i></button>'
                    : `<button class="btn-delete" style="background: rgba(37, 99, 235, 0.1); color: var(--primary); border-color: #bfdbfe;" onclick="editAddress(${addr.id})" title="编辑"><i data-lucide="pencil"></i></button>`;
                const deleteBtn = isBound
                    ? '<button class="btn-delete" disabled style="opacity:0.4;cursor:not-allowed;" title="已绑定不可删"><i data-lucide="trash-2"></i></button>'
                    : `<button class="btn-delete" onclick="deleteAddress(${addr.id})" title="删除"><i data-lucide="trash-2"></i></button>`;
                return `
                <tr>
                    <td>${escapeHtml(addr.line1)}</td>
                    <td>${escapeHtml(addr.city)}</td>
                    <td>${escapeHtml(addr.state)}</td>
                    <td>${escapeHtml(addr.postal_code)}</td>
                    <td>${escapeHtml(addr.country)}</td>
                    <td style="text-align:center">${statusBadge}</td>
                    <td style="text-align:center">
                        <div style="display: flex; justify-content: center; gap: 8px;">
                            ${editBtn}
                            ${deleteBtn}
                        </div>
                    </td>
                </tr>`;
            }).join('');
            lucide.createIcons();
        }

        function showAddressForm(addr) {
            const box = document.getElementById('address_form_box');
            const title = document.getElementById('address_form_title');
            const submitLabel = document.getElementById('address_form_submit_label');
            const editId = document.getElementById('address_edit_id');
            if (box) box.classList.add('active');
            clearAddressFormErrors();
            if (addr) {
                if (title) title.textContent = '编辑地址模板';
                if (submitLabel) submitLabel.textContent = '更新';
                if (editId) editId.value = String(addr.id);
                document.getElementById('addr_line1').value = addr.line1 || '';
                document.getElementById('addr_city').value = addr.city || '';
                document.getElementById('addr_state').value = normalizeUsStateInput(addr.state || '');
                document.getElementById('addr_postal_code').value = addr.postal_code || '';
                document.getElementById('addr_country').value = addr.country || '';
            } else {
                if (title) title.textContent = '新增地址模板';
                if (submitLabel) submitLabel.textContent = '保存';
                if (editId) editId.value = '';
                document.getElementById('addr_line1').value = '';
                document.getElementById('addr_city').value = '';
                document.getElementById('addr_state').value = '';
                document.getElementById('addr_postal_code').value = '';
                document.getElementById('addr_country').value = 'US';
            }
            lucide.createIcons();
        }

        function hideAddressForm() {
            const box = document.getElementById('address_form_box');
            if (box) box.classList.remove('active');
            clearAddressFormErrors();
        }

        function clearAddressFormErrors() {
            ['line1', 'city', 'state', 'postal_code', 'country'].forEach((f) => {
                const el = document.getElementById(`addr_${f}_err`);
                if (el) { el.style.display = 'none'; el.textContent = ''; }
            });
        }

        function validateAddressForm() {
            clearAddressFormErrors();
            const fields = {
                line1: { max: 200, label: '街道地址' },
                city: { max: 100, label: '城市' },
                state: { max: 100, label: '州/省' },
                postal_code: { max: 20, label: '邮编' },
                country: { max: 2, label: '国家代码' }
            };
            let valid = true;
            const values = {};
            for (const [key, cfg] of Object.entries(fields)) {
                const input = document.getElementById(`addr_${key}`);
                const val = (input ? input.value : '').trim();
                values[key] = val;
                const errEl = document.getElementById(`addr_${key}_err`);
                if (!val) {
                    if (errEl) { errEl.textContent = `${cfg.label}不能为空`; errEl.style.display = 'block'; }
                    valid = false;
                } else if (val.length > cfg.max) {
                    if (errEl) { errEl.textContent = `${cfg.label}最长 ${cfg.max} 字符`; errEl.style.display = 'block'; }
                    valid = false;
                }
            }
            // country must be exactly 2 uppercase letters
            if (values.country && !/^[A-Z]{2}$/.test(values.country.toUpperCase())) {
                const errEl = document.getElementById('addr_country_err');
                if (errEl) { errEl.textContent = '国家代码必须为 2 位大写字母'; errEl.style.display = 'block'; }
                valid = false;
            } else if (values.country) {
                values.country = values.country.toUpperCase();
            }
            values.state = normalizeUsStateInput(values.state);
            if (values.state && !US_TAX_FREE_STATE_NAMES.some((s) => s.toLowerCase() === values.state.toLowerCase())) {
                const errEl = document.getElementById('addr_state_err');
                if (errEl) {
                    errEl.textContent = '请填写免税州完整英文名：Oregon / Delaware / Montana / New Hampshire / Alaska';
                    errEl.style.display = 'block';
                }
                valid = false;
            }
            return valid ? values : null;
        }

        async function submitAddressForm() {
            const values = validateAddressForm();
            if (!values) return;

            const editId = document.getElementById('address_edit_id')?.value;
            const isEdit = Boolean(editId);
            const payload = { ...values, region: 'US' };

            try {
                let res;
                if (isEdit) {
                    res = await authFetch(`/api/admin/addresses/${editId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } else {
                    res = await authFetch('/api/admin/addresses', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || (data.details ? data.details.join(', ') : '保存失败'));
                }
                showMessage(isEdit ? '地址模板已更新' : '地址模板已添加', 'success');
                hideAddressForm();
                await loadAddressList('US');
            } catch (e) {
                showMessage(e.message || '保存失败', 'error');
            }
            lucide.createIcons();
        }

        function editAddress(id) {
            const addr = regionAddressList.find((a) => a.id === id);
            if (!addr) {
                showMessage('地址不存在', 'error');
                return;
            }
            if (Number(addr.is_bound) === 1) {
                showMessage('已绑定地址不可编辑', 'warning');
                return;
            }
            showAddressForm(addr);
        }

        async function deleteAddress(id) {
            const ok = await showAdminConfirm('确定删除该地址模板？删除后不可恢复。', '删除地址模板');
            if (!ok) return;
            try {
                const res = await authFetch(`/api/admin/addresses/${id}`, { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '删除失败');
                }
                showMessage('地址模板已删除', 'success');
                await loadAddressList('US');
            } catch (e) {
                showMessage(e.message || '删除失败', 'error');
            }
            lucide.createIcons();
        }

        async function generateRandomUsAddresses() {
            const ok = await showAdminConfirm(
                '将随机生成 10 条美国免税州地址（OR / DE / MT / NH / AK）并加入 US 地址池，继续？',
                '批量生成美国免税地址'
            );
            if (!ok) return;
            try {
                const res = await authFetch('/api/admin/addresses/generate-random-us', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ count: 10 })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '生成失败');
                }
                showMessage(`已生成 ${data.count} 条美国免税地址`, 'success');
                await loadAddressList('US');
            } catch (e) {
                showMessage(e.message || '生成失败', 'error');
            }
            lucide.createIcons();
        }

        async function clearUnboundAddresses() {
            const unboundCount = regionAddressList.filter((a) => Number(a.is_bound) !== 1).length;
            if (unboundCount === 0) {
                showMessage('没有可清空的未绑定地址', 'warning');
                return;
            }
            const ok = await showAdminConfirm(
                `将清空 ${unboundCount} 条未绑定地址（从未支付成功使用过的），已绑定的会保留。继续？`,
                '清空未绑定地址'
            );
            if (!ok) return;
            try {
                const res = await authFetch('/api/admin/addresses/unbound?region=US', { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || data.message || '清空失败');
                }
                showMessage(`已清空 ${data.count} 条未绑定地址`, 'success');
                await loadAddressList('US');
            } catch (e) {
                showMessage(e.message || '清空失败', 'error');
            }
            lucide.createIcons();
        }

        bootAdmin();
