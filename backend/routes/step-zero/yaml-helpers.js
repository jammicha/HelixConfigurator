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

  // Pipeline: append the receiver into the existing pipeline's receivers
  // list, or create a new pipeline if absent. We append (not overwrite)
  // because multiple Step 0 receivers share the metrics/host pipeline —
  // enabling docker_stats after hostmetrics must NOT drop hostmetrics.
  const existing = parsed.service.pipelines[pipelineName] || { receivers: [], exporters: [...exporters] };
  const mergedReceivers = Array.from(new Set([...(existing.receivers || []), receiverName]));
  parsed.service.pipelines[pipelineName] = {
    receivers: mergedReceivers,
    exporters: [...exporters],
  };

  // dump with -1 line width so long URLs and headers don't wrap (matches
  // diagnostics.js#revertDebugMode style).
  return yaml.dump(parsed, { lineWidth: -1 });
};

module.exports = { addReceiverAndPipeline, hasReceiver };
