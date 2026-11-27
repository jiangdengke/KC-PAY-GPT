#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BANNED_PATTERNS = [
    { label: 'playwright', regex: /\bplaywright(?:-extra|-stealth)?\b/i },
    { label: 'puppeteer', regex: /\bpuppeteer(?:-core|-extra)?\b/i },
    { label: 'hcaptcha-solver', regex: /\bhcaptcha-(?:solver|runtime)\b/i },
    { label: 'legacy stripe-payment', regex: /\bstripe-payment\b/i },
    { label: 'legacy browser-pool', regex: /\bbrowser-pool(?:-client)?\b/i },
    { label: 'legacy pricing-checkout', regex: /\bpricing-checkout\b/i },
    { label: 'legacy tax-free-address', regex: /\btax-free-address\b/i },
    { label: 'removed proxy-pool module', regex: /\bproxy-pool\b/i },
    { label: 'removed public admin-paths endpoint', regex: /\/api\/public\/admin-paths\b/ }
];

function collectFiles(dir, extensions) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            out.push(...collectFiles(full, extensions));
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
            out.push(full);
        }
    }
    return out.sort();
}

const errors = [];

// 1. Node syntax check on all JS/MJS files
const jsFiles = [
    path.join(rootDir, 'server.js'),
    ...collectFiles(path.join(rootDir, 'src'), ['.js']),
    ...collectFiles(path.join(rootDir, 'public', 'admin-assets'), ['.js']),
    ...collectFiles(path.join(rootDir, 'scripts'), ['.js', '.mjs']),
    ...collectFiles(path.join(rootDir, 'test'), ['.js'])
].filter((filePath) => fs.existsSync(filePath));

for (const filePath of jsFiles) {
    try {
        execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    } catch (error) {
        const rel = path.relative(rootDir, filePath);
        errors.push(`Syntax error in ${rel}:\n${error.stderr?.toString() || error.message}`);
    }
}

// 2. Parse inline <script> blocks in public/*.html and verify no legacy /admin.js or /admin.css links
const htmlFiles = collectFiles(path.join(rootDir, 'public'), ['.html']);
for (const filePath of htmlFiles) {
    const rel = path.relative(rootDir, filePath);
    const html = fs.readFileSync(filePath, 'utf8');

    if (/["']\/admin\.(?:js|css)\b/.test(html)) {
        errors.push(`Legacy unprotected asset reference found in ${rel} (must use /admin/assets/*)`);
    }

    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let index = 0;
    while ((match = scriptRegex.exec(html)) !== null) {
        const attrs = match[1] || '';
        const body = match[2] || '';
        if (/\bsrc\s*=/.test(attrs) || !body.trim()) {
            continue;
        }
        index += 1;
        try {
            new vm.Script(body, { filename: `${rel}#script-${index}` });
        } catch (error) {
            errors.push(`Inline script syntax error in ${rel}#script-${index}: ${error.message}`);
        }
    }
}

// 3. Guard against banned legacy dependencies or removed endpoints in active runtime files
const guardedFiles = [
    path.join(rootDir, 'server.js'),
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'Dockerfile'),
    path.join(rootDir, 'docker-compose.yml'),
    ...collectFiles(path.join(rootDir, 'src'), ['.js']),
    ...collectFiles(path.join(rootDir, 'public'), ['.js', '.html'])
].filter((filePath) => fs.existsSync(filePath));

for (const filePath of guardedFiles) {
    const rel = path.relative(rootDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rule of BANNED_PATTERNS) {
        if (rule.regex.test(content)) {
            errors.push(`Banned legacy reference (${rule.label}) found in ${rel}`);
        }
    }
}

if (errors.length > 0) {
    console.error(`Check failed with ${errors.length} issue(s):\n`);
    for (const item of errors) {
        console.error(`- ${item}`);
    }
    process.exit(1);
}

console.log(`All checks passed (${jsFiles.length} JS/MJS files, ${htmlFiles.length} HTML files, ${guardedFiles.length} guarded files).`);
