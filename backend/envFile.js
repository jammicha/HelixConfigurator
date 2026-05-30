// Idempotently set KEY=value in a .env file: replace the existing line or append.
// Preserves all other lines verbatim. Creates the file if missing. Generalizes
// the pattern in auth.js so feature code can persist single env vars.
const fs = require('fs');

function upsertEnvVar(envPath, key, value) {
  let lines = [];
  try {
    lines = fs.readFileSync(envPath, 'utf8').split('\n');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // file absent → start fresh
  }
  let found = false;
  lines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

module.exports = { upsertEnvVar };
