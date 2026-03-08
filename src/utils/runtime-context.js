const path = require('path');

function isLikelyWindowsSshSession() {
  return process.platform === 'win32'
    && Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

function getWindowsInteractiveTaskCommand(cwd = process.cwd()) {
  const workdir = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
    ? cwd.replace(/\//g, '\\')
    : path.resolve(cwd);
  return `schtasks /create /tn "OpenClawFeishu" /tr "cmd /c cd /d ""${workdir}"" && node bin/cli.js" /sc once /st 00:00 /f /ru %USERNAME% /it && schtasks /run /tn "OpenClawFeishu"`;
}

module.exports = {
  getWindowsInteractiveTaskCommand,
  isLikelyWindowsSshSession,
};
