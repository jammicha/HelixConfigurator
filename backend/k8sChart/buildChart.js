// backend/k8sChart/buildChart.js
// Assembles the chart: the two generated files (from live state) + a streamer
// that globs the static skeleton and appends the generated files under the
// single `helix-otel/` chart directory. Mirrors demo.js's writePackageToArchive.
const { transformCollectorConfig } = require('./transformCollectorConfig');
const { renderValues } = require('./renderValues');

const CHART_DIR_NAME = 'helix-otel';

function buildChartFiles({ collectorYaml, endpoint = '', xSource = '', viewerEnabled = true, viewerServiceName = 'helix-viewer' }) {
  const gatewayConfig = transformCollectorConfig(collectorYaml, { viewerEnabled, viewerServiceName });
  const values = renderValues({ endpoint, xSource, viewerEnabled });
  return { values, gatewayConfig };
}

// `archive` is an archiver('zip') instance; `projectRoot` is the repo root that
// contains the `helix-otel/` skeleton. `files` is the buildChartFiles() result.
function streamChartArchive(archive, { projectRoot, files }) {
  archive.glob(`${CHART_DIR_NAME}/**`, { cwd: projectRoot, dot: true });
  archive.append(files.values, { name: `${CHART_DIR_NAME}/values.yaml` });
  archive.append(files.gatewayConfig, { name: `${CHART_DIR_NAME}/config/gateway-collector.yaml` });
}

module.exports = { buildChartFiles, streamChartArchive, CHART_DIR_NAME };
