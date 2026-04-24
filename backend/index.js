const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Docker = require('dockerode');
const axios = require('axios');
const { exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const port = 3001;
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const CONFIG_PATH = path.join(__dirname, '../helix-otel-collector.yaml');

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '../frontend-dist')));

// GET current config
app.get('/api/config', (req, res) => {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    res.json({ yaml: fileContents });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read config file' });
  }
});

// POST update config
app.post('/api/config', (req, res) => {
  const { content } = req.body;
  try {
    // Validate YAML syntax
    yaml.load(content);
    fs.writeFileSync(CONFIG_PATH, content, 'utf8');
    res.json({ message: 'Config updated successfully' });
  } catch (e) {
    res.status(400).json({ error: 'Invalid YAML syntax', details: e.message });
  }
});

// POST restart collector
app.post('/api/lifecycle/restart', async (req, res) => {
  try {
    const containerName = process.env.TARGET_CONTAINER_NAME || 'otel-collector';
    const container = docker.getContainer(containerName);
    await container.restart();
    res.json({ message: `Container ${containerName} restarted successfully` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to restart container', details: e.message });
  }
});

// GET environment variables
app.get('/api/env', (req, res) => {
  try {
    const envPath = path.join(__dirname, '../.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const vars = {};
    envContent.split('\n').forEach(line => {
      const [key, ...value] = line.split('=');
      if (key && value) {
        vars[key.trim()] = value.join('=').trim();
      }
    });
    
    res.json({
      HELIX_ENDPOINT: vars.HELIX_ENDPOINT || '',
      HELIX_API_KEY: vars.HELIX_API_KEY || '',
      X_SOURCE: vars.X_SOURCE || ''
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read .env file' });
  }
});

// POST update environment variables
app.post('/api/env', (req, res) => {
  const { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE } = req.body;
  try {
    const envPath = path.join(__dirname, '../.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    const updates = { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE };
    
    let lines = envContent.split('\n');
    Object.keys(updates).forEach(key => {
      let found = false;
      lines = lines.map(line => {
        if (line.startsWith(`${key}=`)) {
          found = true;
          return `${key}=${updates[key]}`;
        }
        return line;
      });
      if (!found) {
        lines.push(`${key}=${updates[key]}`);
      }
    });

    const newContent = lines.join('\n');
    fs.writeFileSync(envPath, newContent, 'utf8');
    
    // Reload into process.env
    process.env.HELIX_ENDPOINT = HELIX_ENDPOINT;
    process.env.HELIX_API_KEY = HELIX_API_KEY;
    process.env.X_SOURCE = X_SOURCE;
    
    res.json({ message: 'Environment variables updated and reloaded' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update .env file' });
  }
});

// GET network diagnostics
app.get('/api/diagnostics/network', async (req, res) => {
  try {
    const endpoint = process.env.HELIX_ENDPOINT;
    if (!endpoint) throw new Error('HELIX_ENDPOINT not configured');
    
    const startTime = Date.now();
    await axios.get(endpoint, { timeout: 5000 }).catch(err => {
        // OTLP endpoints might return 405 or 404 on GET, which is still "reachable"
        if (err.response) return err.response;
        throw err;
    });
    
    res.json({ 
        status: 'Success', 
        latency: `${Date.now() - startTime}ms`,
        endpoint 
    });
  } catch (e) {
    res.status(500).json({ status: 'Failed', error: e.message });
  }
});

// GET telemetry diagnostics
app.get('/api/diagnostics/telemetry', async (req, res) => {
  try {
    // Query collector's own metrics if available
    const response = await axios.get('http://otel-collector:8888/metrics');
    // Simple check if metrics are being exposed
    if (response.data.includes('otelcol_exporter_sent_spans')) {
        res.json({ status: 'Healthy', details: 'Collector is emitting spans' });
    } else {
        res.json({ status: 'Warning', details: 'Collector is running but no spans sent yet' });
    }
  } catch (e) {
    res.status(500).json({ status: 'Disconnected', error: 'Could not reach collector metrics endpoint' });
  }
});

// GET discovered services
app.get('/api/services', (req, res) => {
    try {
        const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config = yaml.load(fileContents);
        
        // Simple logic to extract "services" from pipelines or resource detection
        const services = [];
        if (config.service && config.service.pipelines) {
            Object.keys(config.service.pipelines).forEach(p => {
                services.push({
                    name: `Pipeline: ${p}`,
                    type: 'OpenTelemetry Pipeline',
                    status: 'Active',
                    link: `https://bmc-helix-portal.com/dashboards?service=${p}`
                });
            });
        }
        
        res.json(services);
    } catch (e) {
        res.status(500).json({ error: 'Failed to parse services' });
    }
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
