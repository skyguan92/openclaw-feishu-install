const { createApp } = require('./server/app');
const path = require('path');

const PORT = 19090;

async function startServer() {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, async () => {
      const url = `http://localhost:${PORT}`;
      console.log(`OpenClaw Feishu Installer running at ${url}`);

      // Dynamically import 'open' (ESM module)
      try {
        const open = (await import('open')).default;
        await open(url);
        console.log('Opened browser. Follow the instructions in the web UI.');
      } catch {
        console.log(`Please open ${url} in your browser.`);
      }

      resolve(server);
    });

    server.on('error', reject);
  });
}

module.exports = { startServer };
