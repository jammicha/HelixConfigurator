// backend/k8sChart/index.js
// Façade for the k8s chart generator (the Phase-2 seam: this resource model is
// what a future @kubernetes/client-node layer will reconcile live).
module.exports = {
  ...require('./transformCollectorConfig'),
  ...require('./renderValues'),
  ...require('./buildChart'),
};
