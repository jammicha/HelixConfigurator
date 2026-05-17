// Pure helpers for editing the helix-gateway's OWN OTel collector config
// (helix-otel-collector.yaml). Uses js-yaml load/dump — comments will not
// be preserved across edits. This is acceptable for our config (which has
// no comments today); for CUSTOMER configs we use the text-level patcher in
// backend/routes/discovery.js instead.
const yaml = require('js-yaml');

const VALID_SIGNALS = new Set(['traces', 'metrics', 'logs']);

const hasReceiver = (yamlText, receiverName) => {
  const parsed = yaml.load(yamlText);
  return !!(parsed && parsed.receivers && parsed.receivers[receiverName]);
};

// Add a receiver block under receivers: and wire it into a new pipeline.
// If the receiver or pipeline already exists, the operation is a no-op for
// that piece (idempotent) — callers can re-invoke safely.
const addReceiverAndPipeline = (yamlText, opts) => {
  const {
    receiverName,
    receiverConfig,
    pipelineName,
    pipelineSignal,
    exporters,
  } = opts;
  if (!VALID_SIGNALS.has(pipelineSignal)) {
    throw new Error(
      `addReceiverAndPipeline: pipelineSignal must be one of traces/metrics/logs, got ${JSON.stringify(pipelineSignal)}`
    );
  }
  const parsed = yaml.load(yamlText) || {};
  parsed.receivers = parsed.receivers || {};
  parsed.service = parsed.service || {};
  parsed.service.pipelines = parsed.service.pipelines || {};

  // Receiver: overwrite if present so config drift (e.g. collection_interval
  // change) re-applies cleanly. The toggle is "enabled / not enabled" — there's
  // no half-state we need to merge.
  parsed.receivers[receiverName] = receiverConfig;

  // Pipeline: ensure it exists with the requested receiver list. Don't merge
  // existing arbitrary pipelines named the same — names like "metrics/host"
  // are ours, so overwriting is the intended behavior.
  parsed.service.pipelines[pipelineName] = {
    receivers: [receiverName],
    exporters: [...exporters],
  };

  // dump with -1 line width so long URLs and headers don't wrap (matches
  // diagnostics.js#revertDebugMode style).
  return yaml.dump(parsed, { lineWidth: -1 });
};

module.exports = { addReceiverAndPipeline, hasReceiver };
