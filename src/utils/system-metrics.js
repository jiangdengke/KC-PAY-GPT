'use strict';

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT_DIR } = require('../config/env');

let previousCpuSnapshot = getCpuTimesSnapshot();
let cachedDiskMetrics = {
    percent: 0,
    usedBytes: 0,
    totalBytes: 0,
    usedText: '0.0G',
    totalText: '0.0G',
    drive: '',
    updatedAt: 0
};
let diskMetricsPromise = null;
const serverStartedAt = Date.now();

function getCpuTimesSnapshot() {
    const cpus = os.cpus() || [];
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
        const times = cpu.times || {};
        idle += Number(times.idle || 0);
        total += Number(times.user || 0)
            + Number(times.nice || 0)
            + Number(times.sys || 0)
            + Number(times.idle || 0)
            + Number(times.irq || 0);
    }
    return { idle, total, cores: cpus.length || 1 };
}

function getCpuUsagePercent() {
    const current = getCpuTimesSnapshot();
    const totalDiff = current.total - previousCpuSnapshot.total;
    const idleDiff = current.idle - previousCpuSnapshot.idle;
    previousCpuSnapshot = current;

    if (totalDiff <= 0) {
        return { percent: 0, cores: current.cores };
    }
    const usedRatio = Math.max(0, Math.min(1, 1 - (idleDiff / totalDiff)));
    return {
        percent: Math.round(usedRatio * 100),
        cores: current.cores
    };
}

function formatGigabytes(bytes) {
    const numeric = Number(bytes || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return '0.0G';
    }
    return `${(numeric / (1024 ** 3)).toFixed(1)}G`;
}

function formatUptimeDuration(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(safeSeconds / 86400);
    const hours = Math.floor((safeSeconds % 86400) / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (days > 0) return `${days}天${hours}时${minutes}分${seconds}秒`;
    if (hours > 0) return `${hours}时${minutes}分${seconds}秒`;
    if (minutes > 0) return `${minutes}分${seconds}秒`;
    return `${seconds}秒`;
}

function getDiskMetrics() {
    const now = Date.now();
    if (now - cachedDiskMetrics.updatedAt < 15000 && cachedDiskMetrics.totalBytes > 0) {
        return Promise.resolve(cachedDiskMetrics);
    }
    if (diskMetricsPromise) {
        return diskMetricsPromise;
    }

    diskMetricsPromise = new Promise((resolve) => {
        if (process.platform === 'win32') {
            const driveName = path.parse(ROOT_DIR).root.replace(/\\+$/, '').slice(0, 1) || 'C';
            const script = `$d = Get-PSDrive -Name '${driveName}'; [PSCustomObject]@{ Used = [double]$d.Used; Free = [double]$d.Free; Name = $d.Name } | ConvertTo-Json -Compress`;
            execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 }, (error, stdout) => {
                if (!error && stdout) {
                    try {
                        const parsed = JSON.parse(String(stdout).trim());
                        const usedBytes = Math.max(0, Number(parsed.Used || 0));
                        const freeBytes = Math.max(0, Number(parsed.Free || 0));
                        const totalBytes = usedBytes + freeBytes;
                        const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
                        cachedDiskMetrics = {
                            percent,
                            usedBytes,
                            totalBytes,
                            usedText: formatGigabytes(usedBytes),
                            totalText: formatGigabytes(totalBytes),
                            drive: `${parsed.Name || driveName}:`,
                            updatedAt: Date.now()
                        };
                    } catch (_) { /* keep cached */ }
                }
                diskMetricsPromise = null;
                resolve(cachedDiskMetrics);
            });
            return;
        }

        execFile('df', ['-kP', ROOT_DIR], { timeout: 5000 }, (error, stdout) => {
            if (!error && stdout) {
                const lines = String(stdout).trim().split(/\r?\n/);
                if (lines.length >= 2) {
                    const cols = lines[lines.length - 1].trim().split(/\s+/);
                    const totalKb = Number(cols[1] || 0);
                    const usedKb = Number(cols[2] || 0);
                    if (totalKb > 0) {
                        const totalBytes = totalKb * 1024;
                        const usedBytes = usedKb * 1024;
                        cachedDiskMetrics = {
                            percent: Math.round((usedBytes / totalBytes) * 100),
                            usedBytes,
                            totalBytes,
                            usedText: formatGigabytes(usedBytes),
                            totalText: formatGigabytes(totalBytes),
                            drive: cols[5] || '/',
                            updatedAt: Date.now()
                        };
                    }
                }
            }
            diskMetricsPromise = null;
            resolve(cachedDiskMetrics);
        });
    });

    return diskMetricsPromise;
}

async function getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
    const cpu = getCpuUsagePercent();
    const disk = await getDiskMetrics();
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - serverStartedAt) / 1000));

    return {
        cpu: {
            percent: cpu.percent,
            cores: cpu.cores,
            text: `${cpu.percent}% (${cpu.cores}核)`
        },
        memory: {
            percent: memPercent,
            usedBytes: usedMem,
            totalBytes: totalMem,
            usedText: formatGigabytes(usedMem),
            totalText: formatGigabytes(totalMem),
            text: `${formatGigabytes(usedMem)}/${formatGigabytes(totalMem)}`
        },
        disk: {
            percent: disk.percent,
            usedBytes: disk.usedBytes,
            totalBytes: disk.totalBytes,
            usedText: disk.usedText,
            totalText: disk.totalText,
            drive: disk.drive,
            text: `${disk.usedText}/${disk.totalText}`
        },
        uptime: {
            seconds: uptimeSeconds,
            text: formatUptimeDuration(uptimeSeconds)
        }
    };
}

module.exports = {
    getSystemMetrics,
    formatGigabytes,
    formatUptimeDuration
};
