// YAML structural validation for the gateway config editor. Run on save to
// surface typos in top-level keys, undefined pipeline references, and
// known-incompatible exporters/processors — separate from yaml.load()'s own
// parse-error reporting, which only catches syntax mistakes.
const yaml = require('js-yaml');

const TOP_LEVEL_KEYS = ['receivers', 'processors', 'exporters', 'extensions', 'connectors', 'service'];

const levenshtein = (a, b) => {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
};

const closestKey = (key, candidates) => {
  let best = null, bestDist = Infinity;
  candidates.forEach(c => {
    const d = levenshtein(key.toLowerCase(), c.toLowerCase());
    if (d < bestDist && d <= 3) { best = c; bestDist = d; }
  });
  return best;
};

const findLineForKey = (yamlText, key) => {
  const lines = yamlText.split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
};

const validateConfig = (yamlString) => {
  const warnings = [];
  let parsed;
  try { parsed = yaml.load(yamlString); } catch { return warnings; }
  if (!parsed || typeof parsed !== 'object') return warnings;

  // Typos at top level
  Object.keys(parsed).forEach(key => {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      const suggestion = closestKey(key, TOP_LEVEL_KEYS);
      warnings.push({
        line: findLineForKey(yamlString, key),
        message: `Unknown top-level key "${key}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
      });
    }
  });

  const definedReceivers = Object.keys(parsed.receivers || {});
  const definedProcessors = Object.keys(parsed.processors || {});
  const definedExporters = Object.keys(parsed.exporters || {});

  // BMC Helix AIOps doesn't support the OTel transform processor; flag it as
  // a structural-lint warning so users know it'll be silently ignored or hurt
  // collector throughput.
  const transformProcessors = definedProcessors.filter(
    name => name === 'transform' || name.startsWith('transform/')
  );
  if (transformProcessors.length > 0) {
    transformProcessors.forEach(name => {
      warnings.push({
        line: findLineForKey(yamlString, name),
        message: 'The Transform processor is not supported by BMC Helix AIOps and may impact collector performance.',
      });
    });
  }

  // The configurator's local "View OTel Data" page depends on the gateway
  // fanning traces+logs to /api/otlp/* via the otlphttp/helix_local_viewer
  // exporter. If the user removes it (typically by hand-editing or loading
  // an older template), trace flow into /otel-data goes silent — flag that
  // as an info-level warning so they know what they're giving up.
  if (!definedExporters.includes('otlphttp/helix_local_viewer')) {
    warnings.push({
      line: 1,
      message: 'otlphttp/helix_local_viewer exporter is missing — the local View OTel Data page will not receive traces or logs. Helix delivery is unaffected.',
    });
  } else if (parsed.service && parsed.service.pipelines) {
    // Defined but not wired into traces/logs pipelines is the same effective
    // outcome — surface it for the same reason.
    const tracesUses = (parsed.service.pipelines.traces?.exporters || []).includes('otlphttp/helix_local_viewer');
    const logsUses = (parsed.service.pipelines.logs?.exporters || []).includes('otlphttp/helix_local_viewer');
    if (!tracesUses && !logsUses) {
      warnings.push({
        line: findLineForKey(yamlString, 'pipelines'),
        message: 'otlphttp/helix_local_viewer is defined but not wired into the traces or logs pipelines — View OTel Data will be empty.',
      });
    }
  }

  if (definedReceivers.length === 0) {
    warnings.push({ line: 1, message: 'No receivers defined — gateway has no telemetry input' });
  }
  if (definedExporters.length === 0) {
    warnings.push({ line: 1, message: 'No exporters defined — gateway has no telemetry output' });
  }

  if (!parsed.service) {
    warnings.push({ line: 1, message: 'Missing required "service" section' });
  } else if (parsed.service.pipelines) {
    Object.entries(parsed.service.pipelines).forEach(([pipelineName, pipeline]) => {
      const pipelineLine = findLineForKey(yamlString, pipelineName);
      ['receivers', 'processors', 'exporters'].forEach(kind => {
        const refs = (pipeline && pipeline[kind]) || [];
        const defined = kind === 'receivers' ? definedReceivers : kind === 'processors' ? definedProcessors : definedExporters;
        if (refs.length === 0 && kind !== 'processors') {
          warnings.push({ line: pipelineLine, message: `Pipeline "${pipelineName}" has no ${kind} — telemetry won't flow` });
        }
        refs.forEach(ref => {
          if (!defined.includes(ref)) {
            const singular = kind.slice(0, -1);
            const suggestion = closestKey(ref, defined);
            warnings.push({
              line: pipelineLine,
              message: `Pipeline "${pipelineName}" references undefined ${singular} "${ref}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
            });
          }
        });
      });
    });
  }

  return warnings;
};

module.exports = { validateConfig, findLineForKey };
