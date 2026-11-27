'use strict';

const express = require('express');
const qs = require('qs');
const { safeJsonReviver } = require('../security/admin-auth');

function createSafeJsonMiddleware(limit = '15mb') {
    return express.json({ limit, reviver: safeJsonReviver });
}

function createQueryParser() {
    return (str) => qs.parse(str, { allowPrototypes: false, depth: 5 });
}

function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
}

module.exports = {
    safeJsonReviver,
    createSafeJsonMiddleware,
    createQueryParser,
    securityHeadersMiddleware
};
