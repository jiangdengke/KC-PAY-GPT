'use strict';

const pool = require('./pool');
const configRepo = require('./config-repo');
const cdkRepo = require('./cdk-repo');
const taskRepo = require('./task-repo');
const orbitcardRepo = require('./orbitcard-repo');
const securityRepo = require('./security-repo');
const cardRepo = require('./card-repo');
const proxyRepo = require('./proxy-repo');

async function ensureReady() {
    await pool.ensureActiveSchema();
    await configRepo.ensureDefaultConfigs();
    await proxyRepo.migrateLegacyProxyConfig();
    await taskRepo.cleanupStaleLegacyTasks();
}

module.exports = {
    ...pool,
    ...configRepo,
    ...cdkRepo,
    ...taskRepo,
    ...orbitcardRepo,
    ...securityRepo,
    ...cardRepo,
    ...proxyRepo,
    ensureReady
};
