const express = require('express');
const fs = require('fs');
const path = require('path');
const { SSEBus } = require('./events');
const runnerModule = require('../automation/runner');
const preflightModule = require('../config/preflight');
const stateModule = require('../config/state');
const { getBrowserProfileDir } = require('../utils/paths');
const { DEFAULT_CHANNEL, normalizeChannel } = require('../config/channels');

function trimValue(value) {
  if (value == null) {
    return '';
  }

  return String(value).trim();
}

function hasBodyValue(body, key) {
  return Boolean(body && Object.prototype.hasOwnProperty.call(body, key));
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
      const channel = normalizeChannel(
        trimValue(req.body.channel) || trimValue(savedState.channel) || DEFAULT_CHANNEL,
        DEFAULT_CHANNEL
      );
      runner = new runnerModule.Runner(bus, {
        channel,
        appName: trimValue(req.body.appName) || trimValue(savedState.appName),
        botName: trimValue(req.body.botName) || trimValue(savedState.botName),
        appDescription: trimValue(req.body.appDescription) || trimValue(savedState.appDescription),
        appId: trimValue(req.body.appId) || trimValue(savedState.appId),
        appSecret: trimValue(req.body.appSecret) || trimValue(savedState.appSecret),
        botId: trimValue(req.body.botId) || trimValue(savedState.botId),
        botSecret: trimValue(req.body.botSecret) || trimValue(savedState.botSecret),
        websocketUrl: trimValue(req.body.websocketUrl) || trimValue(savedState.websocketUrl),
        skipPairingApproval: hasBodyValue(req.body, 'skipPairingApproval')
          ? Boolean(req.body.skipPairingApproval)
          : Boolean(savedState.skipPairingApproval),
        expectedTesterName: hasBodyValue(req.body, 'expectedTesterName')
          ? trimValue(req.body.expectedTesterName)
          : trimValue(savedState.expectedTesterName),
        expectedTesterId: hasBodyValue(req.body, 'expectedTesterId')
          ? trimValue(req.body.expectedTesterId)
          : trimValue(savedState.expectedTesterId),
        pairingApprovalWindowMs: hasBodyValue(req.body, 'pairingApprovalWindowMs')
          ? trimValue(req.body.pairingApprovalWindowMs)
          : trimValue(savedState.pairingApprovalWindowMs),
        startPhase: trimValue(req.body.startPhase),
        endPhase: trimValue(req.body.endPhase),
        clearLogin: Boolean(req.body.clearLogin),
        resetState: Boolean(req.body.resetState),
        forceNewVersion: Boolean(req.body.forceNewVersion),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({
      status: 'started',
      channel: runner.channel,
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
    try {
      const requestedChannel = trimValue(req.query.channel);
      const state = stateModule.loadState({
        channel: requestedChannel ? normalizeChannel(requestedChannel, DEFAULT_CHANNEL) : undefined,
      });
      res.json({
        ...(state || {}),
        running: Boolean(runner && runner.running),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reset', async (req, res) => {
    if (runner && runner.running) {
      return res.status(409).json({ error: 'Automation is already running' });
    }

    try {
      const channel = trimValue(req.body.channel || (runner && runner.channel) || stateModule.loadState()?.channel || DEFAULT_CHANNEL);
      const clearedState = stateModule.clearState();
      const clearedLogin = req.body && req.body.clearLogin
        ? removePathIfExists(getBrowserProfileDir(normalizeChannel(channel, DEFAULT_CHANNEL)))
        : false;

      res.json({ status: 'reset', clearedState, clearedLogin });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reset-login', async (req, res) => {
    if (runner && runner.running) {
      return res.status(409).json({ error: 'Automation is already running' });
    }

    try {
      const channel = trimValue(req.body && req.body.channel) || stateModule.loadState()?.channel || DEFAULT_CHANNEL;
      const normalizedChannel = normalizeChannel(channel, DEFAULT_CHANNEL);
      const cleared = removePathIfExists(getBrowserProfileDir(normalizedChannel));
      res.json({ status: 'login-reset', cleared });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createApp };
