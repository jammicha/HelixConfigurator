// Line-surgery editor for the managed Helix exporters in the gateway YAML.
// The app owns only otlphttp/bmchelix_<id> exporters and their membership in
// each pipeline's exporters list; everything else (receivers, processors, the
// viewer exporter, hand-added exporters, comments) is preserved verbatim. We
// do NOT parse-and-reemit: js-yaml would strip every comment in the file.
const yaml = require('js-yaml');
const { MANAGED_PREFIX, LEGACY_EXPORTER, exporterName, envSuffix } = require('./connectionModel');

const isManagedName = (name) => name === LEGACY_EXPORTER || name.startsWith(MANAGED_PREFIX);
const indentWidth = (line) => line.match(/^(\s*)/)[1].length;
const isBlankOrComment = (line) => { const t = line.trim(); return t === '' || t.startsWith('#'); };

const exporterBlock = (id, indent) => {
  const suf = envSuffix(id);
  const p = ' '.repeat(indent);
  const p2 = ' '.repeat(indent + 2);
  const p3 = ' '.repeat(indent + 4);
  return [
    `${p}${exporterName(id)}:`,
    `${p2}# Managed by Manage Connections. Regenerated on every connection change.`,
    `${p2}endpoint: \${env:HELIX_ENDPOINT_${suf}}`,
    `${p2}headers:`,
    `${p3}X-Api-Key: \${env:HELIX_API_KEY_${suf}}`,
    `${p3}X-Source: \${env:X_SOURCE_${suf}}`,
    `${p2}sending_queue:`,
    `${p3}enabled: true`,
    `${p3}num_consumers: 100`,
    `${p3}queue_size: 10000`,
  ];
};

// [start,end) of a top-level block whose key is `key` (column 0). end is the
// first column-0 line after the header, or EOF.
const topLevelBlockRange = (lines, key) => {
  const start = lines.findIndex((l) => l.match(new RegExp(`^${key}:\\s*(#.*)?$`)));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentWidth(lines[i]) === 0) { end = i; break; }
  }
  return { start, end };
};

const exporterEntries = (lines, start, end) => {
  let childIndent = -1;
  const entries = [];
  for (let i = start + 1; i < end; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const ind = indentWidth(lines[i]);
    if (childIndent < 0) childIndent = ind;
    if (ind !== childIndent) continue;
    const m = lines[i].match(/^\s*([\w./-]+):\s*(#.*)?$/);
    if (!m) continue;
    let j = i + 1;
    for (; j < end; j++) {
      if (isBlankOrComment(lines[j])) continue;
      if (indentWidth(lines[j]) <= childIndent) break;
    }
    // Trailing blank/comment lines right before the boundary describe the
    // *next* entry (or trail the block), not this one; do not swallow them
    // into this entry's span or they get deleted along with it.
    let to = j;
    while (to > i + 1 && isBlankOrComment(lines[to - 1])) to--;
    entries.push({ name: m[1], from: i, to });
  }
  return { childIndent: childIndent < 0 ? 2 : childIndent, entries };
};

const replaceExporterMap = (lines, connections) => {
  const range = topLevelBlockRange(lines, 'exporters');
  if (!range) return lines;
  const { childIndent, entries } = exporterEntries(lines, range.start, range.end);
  const managed = entries.filter((e) => isManagedName(e.name));
  const insertAt = managed.length ? managed[0].from : range.start + 1;
  let out = lines.slice();
  for (const e of [...managed].sort((a, b) => b.from - a.from)) out.splice(e.from, e.to - e.from);
  const removedBefore = managed.filter((e) => e.from < insertAt).reduce((n, e) => n + (e.to - e.from), 0);
  const at = insertAt - removedBefore;
  const generated = connections.flatMap((c) => exporterBlock(c.id, childIndent));
  out.splice(at, 0, ...generated);
  return out;
};

const replacePipelineExporters = (lines, signal, ids) => {
  const svc = topLevelBlockRange(lines, 'service');
  if (!svc) return lines;
  const findChild = (from, to, name, baseIndent) => {
    for (let i = from; i < to; i++) {
      if (isBlankOrComment(lines[i])) continue;
      if (indentWidth(lines[i]) === baseIndent && lines[i].trim().replace(/:.*/, '') === name) return i;
    }
    return -1;
  };
  const pipelinesIdx = findChild(svc.start + 1, svc.end, 'pipelines', 2);
  if (pipelinesIdx < 0) return lines;
  const sigIdx = findChild(pipelinesIdx + 1, svc.end, signal, 4);
  if (sigIdx < 0) return lines;
  const expIdx = findChild(sigIdx + 1, svc.end, 'exporters', 6);
  if (expIdx < 0) return lines;
  let from = expIdx + 1, to = from;
  for (let i = expIdx + 1; i < svc.end; i++) {
    if (isBlankOrComment(lines[i])) { to = i + 1; continue; }
    if (indentWidth(lines[i]) > 6 && lines[i].trim().startsWith('- ')) { to = i + 1; continue; }
    break;
  }
  // Trailing blank/comment lines right before the boundary describe whatever
  // follows (the next pipeline/signal, or trail the block), not this list;
  // do not swallow them into the spliced range or they get deleted.
  while (to > from && isBlankOrComment(lines[to - 1])) to--;
  const items = [];
  for (let i = from; i < to; i++) {
    const m = lines[i].match(/^\s*-\s*([\w./-]+)\s*(#.*)?$/);
    if (m) items.push({ name: m[1], i });
  }
  const itemIndent = items.length ? indentWidth(lines[items[0].i]) : 8;
  const hasManaged = items.some((it) => isManagedName(it.name));
  const rebuilt = [];
  if (hasManaged) {
    let placed = false;
    for (const it of items) {
      if (isManagedName(it.name)) { if (!placed) { rebuilt.push('__MANAGED__'); placed = true; } }
      else rebuilt.push(it.name);
    }
  } else {
    for (const it of items) rebuilt.push(it.name);
    rebuilt.push('__MANAGED__');
  }
  const seqLines = rebuilt.flatMap((token) =>
    token !== '__MANAGED__'
      ? [`${' '.repeat(itemIndent)}- ${token}`]
      : ids.map((id) => `${' '.repeat(itemIndent)}- ${exporterName(id)}`));
  const out = lines.slice();
  out.splice(from, to - from, ...seqLines);
  return out;
};

const syncManagedExporters = (yamlString, connections) => {
  let lines = yamlString.split('\n');
  lines = replaceExporterMap(lines, connections);
  for (const signal of ['traces', 'metrics', 'logs']) {
    const ids = connections.filter((c) => c.signals && c.signals[signal]).map((c) => c.id);
    lines = replacePipelineExporters(lines, signal, ids);
  }
  return lines.join('\n');
};

const readManagedExporters = (yamlString) => {
  const doc = yaml.load(yamlString) || {};
  return Object.keys(doc.exporters || {})
    .filter((n) => n.startsWith(MANAGED_PREFIX))
    .map((n) => n.slice(MANAGED_PREFIX.length));
};

const verifyManagedYaml = (yamlString, connections, envVars) => {
  const doc = yaml.load(yamlString) || {};
  const want = new Set(connections.map((c) => c.id));
  const got = new Set(readManagedExporters(yamlString));
  if (want.size !== got.size || [...want].some((id) => !got.has(id))) {
    throw new Error(`managed exporter set mismatch: want ${[...want]} got ${[...got]}`);
  }
  for (const signal of ['traces', 'metrics', 'logs']) {
    const wantSig = connections.filter((c) => c.signals[signal]).map((c) => exporterName(c.id)).sort();
    const gotSig = ((doc.service && doc.service.pipelines && doc.service.pipelines[signal] && doc.service.pipelines[signal].exporters) || [])
      .filter((n) => n.startsWith(MANAGED_PREFIX)).sort();
    if (wantSig.join(',') !== gotSig.join(',')) throw new Error(`pipeline ${signal} membership mismatch`);
  }
  for (const c of connections) {
    for (const key of [`HELIX_ENDPOINT_${envSuffix(c.id)}`, `HELIX_API_KEY_${envSuffix(c.id)}`, `X_SOURCE_${envSuffix(c.id)}`]) {
      if (!(key in envVars)) throw new Error(`missing env key ${key}`);
    }
  }
};

module.exports = { syncManagedExporters, readManagedExporters, verifyManagedYaml };
