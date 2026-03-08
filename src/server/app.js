const express = require('express');
const path = require('path');
const { SSEBus } = require('./events');
const runnerModule = require('../automation/runner');
const preflightModule = require('../config/preflight');

function createApp() {
  const app = express();
  const bus = new SSEBus();
  let runner = null;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../web')));

  // SSE endpoint
  app.get('/api/events', (req, res) => {
    bus.addClient(res);
  });

  // Preflight check
  app.get('/api/preflight', async (req, res) => {
    try {
      const result = await preflightModule.runPreflight();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start automation
  app.post('/api/start', async (req, res) => {
    const { appName, botName, appDescription } = req.body;

    if (!appName || !botName) {
      return res.status(400).json({ error: 'appName and botName are required' });
    }

    if (runner && runner.running) {
      return res.status(409).json({ error: 'Automation is already running' });
    }

    runner = new runnerModule.Runner(bus, {
      appName,
      botName,
      appDescription: appDescription || `${appName} - powered by OpenClaw`,
    });

    res.json({ status: 'started' });

    // Run in background
    runner.run().catch(err => {
      bus.sendError('unknown', err.message);
    });
  });

  // Retry current phase
  app.post('/api/retry', async (req, res) => {
    if (!runner) {
      return res.status(400).json({ error: 'No automation session' });
    }
    try {
      await runner.retryCurrent();
      res.json({ status: 'retrying' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel
  app.post('/api/cancel', async (req, res) => {
    if (runner) {
      await runner.cancel();
      runner = null;
    }
    res.json({ status: 'cancelled' });
  });

  // Get saved state (for resume)
  app.get('/api/state', async (req, res) => {
    const ocConfig = require('../config/openclaw');
    const state = ocConfig.loadState();
    res.json(state || {});
  });

  return app;
}

module.exports = { createApp };
