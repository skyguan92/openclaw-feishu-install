const express = require('express');
const fs = require('fs');
const path = require('path');
const { SSEBus } = require('./events');
const runnerModule = require('../automation/runner');
const preflightModule = require('../config/preflight');
const { BROWSER_PROFILE_DIR, STATE_FILE } = require('../utils/paths');

function trimValue(value) {
  if (value == null) {
    return '';
  }

  return String(value).trim();
}

function removePathIfExists(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

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
    if (runner && runner.running) {
      return res.status(409).json({ error: 'Automation is already running' });
    }

    const savedState = require('../config/openclaw').loadState() || {};

    try {
      runner = new runnerModule.Runner(bus, {
        appName: trimValue(req.body.appName) || trimValue(savedState.appName),
        botName: trimValue(req.body.botName) || trimValue(savedState.botName),
        appDescription: trimValue(req.body.appDescription) || trimValue(savedState.appDescription),
        appId: trimValue(req.body.appId) || trimValue(savedState.appId),
        appSecret: trimValue(req.body.appSecret) || trimValue(savedState.appSecret),
        startPhase: trimValue(req.body.startPhase),
        endPhase: trimValue(req.body.endPhase),
        clearLogin: Boolean(req.body.clearLogin),
        resetState: Boolean(req.body.resetState),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({
      status: 'started',
      startPhase: runner.startPhase,
      endPhase: runner.endPhase,
      selectedPhases: runner.selectedPhases,
    });

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
      const phase = trimValue(req.body.phase);
      await runner.retryCurrent(phase || runner.currentPhase);
      res.json({ status: 'retrying', phase: phase || runner.currentPhase });
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
    res.json({
      ...(state || {}),
      phases: runnerModule.PHASES,
      running: Boolean(runner && runner.running),
    });
  });

  app.post('/api/reset', async (req, res) => {
    if (runner && runner.running) {
      return res.status(409).json({ error: 'Automation is already running' });
    }

    const clearedState = removePathIfExists(STATE_FILE);
    const clearedLogin = req.body && req.body.clearLogin
      ? removePathIfExists(BROWSER_PROFILE_DIR)
      : false;

    res.json({ status: 'reset', clearedState, clearedLogin });
  });

  app.post('/api/reset-login', async (req, res) => {
    if (runner && runner.running) {
      return res.status(409).json({ error: 'Automation is already running' });
    }

    const cleared = removePathIfExists(BROWSER_PROFILE_DIR);
    res.json({ status: 'login-reset', cleared });
  });

  return app;
}

module.exports = { createApp };
