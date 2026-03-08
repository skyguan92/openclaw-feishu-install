#!/usr/bin/env node

const { startServer } = require('../src/index');

startServer().catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
