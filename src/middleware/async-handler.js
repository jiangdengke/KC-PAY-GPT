'use strict';

function wrapHandler(fn) {
    if (typeof fn !== 'function' || fn.length === 4) {
        return fn;
    }
    return function wrappedAsyncHandler(req, res, next) {
        try {
            const ret = fn(req, res, next);
            if (ret && typeof ret.then === 'function') {
                ret.catch(next);
            }
        } catch (err) {
            next(err);
        }
    };
}

/**
 * Express 4 does not catch rejected promises returned by async handlers.
 * Wrapping registration methods on an app or router guarantees rejections
 * flow into the error middleware instead of hitting unhandledRejection.
 */
function forwardAsyncErrors(target) {
    for (const method of ['use', 'get', 'post', 'put', 'delete', 'patch', 'all']) {
        const original = target[method].bind(target);
        target[method] = (...args) => original(...args.map(wrapHandler));
    }
    return target;
}

module.exports = {
    wrapHandler,
    forwardAsyncErrors
};
