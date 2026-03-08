const fs = require('fs');
const path = require('path');

function addIfDefined(list, value) {
  if (value) {
    list.push(value);
  }
}

function addWindowsPath(list, root, ...segments) {
  if (root) {
    list.push(path.join(root, ...segments));
  }
}

function getSystemBrowserCandidates() {
  const candidates = [];

  if (process.platform === 'darwin') {
    addIfDefined(candidates, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    addIfDefined(candidates, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    addIfDefined(candidates, '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];

    addWindowsPath(candidates, localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe');
    addWindowsPath(candidates, programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
    addWindowsPath(candidates, programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe');
    addWindowsPath(candidates, localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    addWindowsPath(candidates, programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    addWindowsPath(candidates, programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    addWindowsPath(candidates, localAppData, 'Chromium', 'Application', 'chrome.exe');
    addWindowsPath(candidates, programFiles, 'Chromium', 'Application', 'chrome.exe');
    addWindowsPath(candidates, programFilesX86, 'Chromium', 'Application', 'chrome.exe');
  } else {
    addIfDefined(candidates, '/usr/bin/google-chrome');
    addIfDefined(candidates, '/usr/bin/google-chrome-stable');
    addIfDefined(candidates, '/usr/bin/microsoft-edge');
    addIfDefined(candidates, '/usr/bin/chromium-browser');
    addIfDefined(candidates, '/usr/bin/chromium');
    addIfDefined(candidates, '/snap/bin/chromium');
  }

  return Array.from(new Set(candidates));
}

function findSystemBrowserExecutable() {
  for (const candidate of getSystemBrowserCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  findSystemBrowserExecutable,
  getSystemBrowserCandidates,
};
