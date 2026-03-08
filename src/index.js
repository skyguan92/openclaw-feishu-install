const { createApp } = require('./server/app');
const {
  getWindowsInteractiveTaskCommand,
  isLikelyWindowsSshSession,
} = require('./utils/runtime-context');

const PORT = 19090;

async function startServer() {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, async () => {
      const url = `http://localhost:${PORT}`;
      console.log(`OpenClaw Feishu Installer running at ${url}`);

      if (isLikelyWindowsSshSession()) {
        console.log('Detected a Windows SSH session. GUI browsers may not be visible on the desktop user session.');
        console.log(`If the user cannot see the browser window, run this in an interactive task instead: ${getWindowsInteractiveTaskCommand()}`);
        console.log(`Open ${url} manually after the task starts.`);
        resolve(server);
        return;
      }

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
