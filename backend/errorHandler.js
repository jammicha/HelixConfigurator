// Terminal Express error-handling middleware. Registered last in index.js as
// the safety net for any route that throws or rejects without its own catch.
// Express 5 forwards rejected promises from async handlers here too, so this
// covers both synchronous throws and unhandled async rejections — without it,
// the former leaks a stack-trace HTML page and the latter can crash the
// process via an unhandledRejection.
const errorLog = require('./errorLog');

function errorHandler(err, req, res, next) {
  // Full detail (including stack) goes to the server log only.
  console.error('[unhandled]', err && err.stack ? err.stack : err);
  errorLog.push(
    'unhandled',
    err && err.message ? err.message : String(err),
    req && req.method ? `${req.method} ${req.originalUrl || req.url}` : undefined,
  );

  // Once the response has started streaming we can't change status or body —
  // hand off to Express's default handler, which finalizes/closes the response.
  if (res.headersSent) return next(err);

  res.status(500).json({
    error: 'Internal server error',
    details: err && err.message ? err.message : undefined,
  });
}

module.exports = { errorHandler };
