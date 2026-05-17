// Response shape for GET /api/step-zero/agentless/status.
// Mirrors backend/routes/step-zero/agentless.js return value.
export type ReceiverStatus = {
  enabled: boolean;
  acceptedMetricPoints: number;
};

export type AgentlessStatus = {
  hostmetrics: ReceiverStatus;
  dockerstats: ReceiverStatus;
};
