/* global lucide, BUSINESS_PAGES, paginationState, getAdminToken, redirectToLogin, ensureAdminSession,
   updateAdminPathPreview, loadAdminSecurityStatus, loadIpBans, loadAdminLoginLogs,
   reloadSystemConfigFromServer, loadGptApiConfig, updateOrbitcardConfigVisibility, saveMaintenanceMode,
   loadCardPoolList, loadOrbitcardUsage, loadOrbitcardProductStrategy,
   loadCdkList, renderCDKTable, loadSessions, openSessionModal, copySessionByJobKey, exportSessionByJobKey,
   cancelAutoRenewByJobKey, loadData, loadTaskLogs, renderLogTable, deleteAdminTaskLog, openTaskLogModal,
   loadActivationManualHolds, startRuntimeLogStream, stopRuntimeLogStream, updateAdminDataRefreshButton,
   adminDataRefreshPaused */
/* exported switchAdminSection, toggleNavGroup, switchPage, changePage */
'use strict';

let adminDataRefreshTimer = null;

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
    if (group === 'card-assets' && target === 'local') {
        loadCardPoolList().catch(() => { });
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

function resolveNavItem(pId, el) {
    if (el && el.classList.contains('nav-item')) return el;
    return document.querySelector(`.nav-item[data-page="${pId}"]`)
        || document.querySelector(`.nav-item[onclick*="'${pId}'"]`);
}

function switchPage(pId, el) {
    document.querySelectorAll('.nav-item.active').forEach((i) => i.classList.remove('active'));
    const page = document.getElementById(pId);
    if (!page) return;
    page.classList.add('active');
    document.querySelectorAll('.page-view').forEach((p) => {
        if (p.id !== pId) p.classList.remove('active');
    });

    if (BUSINESS_PAGES.has(pId)) {
        document.getElementById('nav_group_business')?.classList.add('expanded');
    }
    resolveNavItem(pId, el)?.classList.add('active');

    if (pId === 'runtime_logs') startRuntimeLogStream();
    else stopRuntimeLogStream();

    if (pId === 'sessions') loadSessions(false).catch(() => { });
    if (pId === 'cards') {
        loadOrbitcardUsage(false, false).catch(() => { });
        loadCardPoolList().catch(() => { });
    }
    if (pId === 'config') {
        reloadSystemConfigFromServer().catch(() => { });
        loadAdminSecurityStatus().catch(() => { });
    }
    if (pId === 'admin_login_logs') {
        loadIpBans().catch(() => { });
        loadAdminLoginLogs().catch(() => { });
    }
    if (pId === 'cdks') loadCdkList().catch((e) => console.error('Failed to load CDK list', e));
    if (pId === 'logs') loadTaskLogs(false).catch((e) => console.error('Failed to load task logs', e));
}

function changePage(stateKey, nextPage) {
    if (!paginationState[stateKey]) return;
    paginationState[stateKey].page = nextPage;
    if (stateKey === 'cdk') renderCDKTable();
    if (stateKey === 'log') renderLogTable(window.__adminLogs || []);
    if (stateKey === 'session') loadSessions(false);
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
        cancelAutoRenewByJobKey(cancelRenewBtn.getAttribute('data-cancel-renew') || '', cancelRenewBtn);
    }
});

document.getElementById('maintenance_mode')?.addEventListener('change', () => {
    saveMaintenanceMode().catch((error) => console.error('Maintenance mode save failed', error));
});

document.getElementById('gpt_api_card_source')?.addEventListener('change', () => {
    updateOrbitcardConfigVisibility();
});

async function bootAdmin() {
    document.getElementById('admin_login_path')?.addEventListener('input', updateAdminPathPreview);
    document.getElementById('admin_panel_path')?.addEventListener('input', updateAdminPathPreview);

    if (!getAdminToken()) {
        redirectToLogin();
        return;
    }

    try {
        await ensureAdminSession();
        await loadData(true);
        await loadGptApiConfig();
        if (adminDataRefreshTimer) clearInterval(adminDataRefreshTimer);
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

bootAdmin();
