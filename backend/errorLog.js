// Tiny in-memory ring buffer of tagged errors. Lifecycle / diagnostics /
// discovery routes push here at any existing console.warn / console.error
// site that represents a user-relevant failure; the dashboard polls
// `recent()` to surface the latest in the System Health panel.
const CAP = 50;
let buffer = [];

const push = (tag, message, detail) => {
  buffer.push({ ts: Date.now(), tag, message, detail });
  if (buffer.length > CAP) buffer = buffer.slice(buffer.length - CAP);
};

const recent = (limit = 10) => {
  const slice = buffer.slice(-limit).reverse();
  return slice;
};

// Test-only — resets the buffer between cases.
const _reset = () => { buffer = []; };

module.exports = { push, recent, _reset };
