// backend/k8sChart/buildChart.js
// Assembles the chart: the two generated files (from live state) + a streamer
// that globs the static skeleton and appends the generated files. The skeleton
// dir is engine-dependent: helix-otel (Deployment) or helix-otel-operator (CRs).
const { transformCollectorConfig } = require('./transformCollectorConfig');
const { renderValues } = require('./renderValues');

const CHART_DIR_DEPLOYMENT = 'helix-otel';
const CHART_DIR_OPERATOR = 'helix-otel-operator';

function chartDirForEngine(engine) {
  return engine === 'operator' ? CHART_DIR_OPERATOR : CHART_DIR_DEPLOYMENT;
}

function buildChartFiles({ collectorYaml, endpoint = '', xSource = '', target = 'local', engine = 'deployment', languages } = {}) {
  const gatewayConfig = transformCollectorConfig(collectorYaml, { target });
  const values = renderValues({ endpoint, xSource, engine, languages });
  return { values, gatewayConfig };
}

// `archive` is an archiver('zip') instance; `projectRoot` contains the skeleton.
// `files` is the buildChartFiles() result; `engine` selects the skeleton dir.
function streamChartArchive(archive, { projectRoot, files, engine = 'deployment' }) {
  const dir = chartDirForEngine(engine);
  archive.glob(`${dir}/**`, { cwd: projectRoot, dot: true });
  archive.append(files.values, { name: `${dir}/values.yaml` });
  archive.append(files.gatewayConfig, { name: `${dir}/config/gateway-collector.yaml` });
}

module.exports = {
  buildChartFiles, streamChartArchive, chartDirForEngine,
  CHART_DIR_NAME: CHART_DIR_DEPLOYMENT, // back-compat export
  CHART_DIR_DEPLOYMENT, CHART_DIR_OPERATOR,
};
