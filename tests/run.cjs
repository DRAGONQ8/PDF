'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const suites = [
  { id: 'baseline', script: 'browser.test.cjs', result: 'results.json' },
  { id: 'v2', script: 'v2.test.cjs', result: 'v2-results.json' },
];
let failedProcess = false;
const suiteResults = [];
for (const suite of suites) {
  const resultPath = path.join(__dirname, 'artifacts', suite.result);
  fs.rmSync(resultPath, { force: true });
  const execution = spawnSync(process.execPath, [path.join(__dirname, suite.script)], { cwd: root, env: process.env, stdio: 'inherit' });
  if (execution.status !== 0) failedProcess = true;
  if (fs.existsSync(resultPath)) suiteResults.push({ id: suite.id, ...JSON.parse(fs.readFileSync(resultPath, 'utf8')) });
  else suiteResults.push({ id: suite.id, passed: 0, failed: 1, results: [{ name: `${suite.id} runner completed and wrote results`, status: 'failed', error: String(execution.error || `Runner exited ${execution.status}`) }] });
}
const filename = process.env.HUB_TEST_HTML || path.join(root, 'index.html');
const baseline = suiteResults.find(s => s.id === 'baseline');
const summary = {
  timestamp: new Date().toISOString(), mode: 'AI Transform Hub V2: full preserved baseline and extension regression suites',
  passed: suiteResults.reduce((n, s) => n + s.passed, 0), failed: suiteResults.reduce((n, s) => n + s.failed, 0),
  chromium: baseline?.chromium, playwright: require('playwright/package.json').version, cdn: baseline?.cdn, bootMs: baseline?.bootMs,
  physicalDeviceTesting: false,
  environment: { platform: process.platform, release: require('node:os').release(), architecture: process.arch, node: process.version, browserExecutable: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, serving: 'Local HTTP static server at 127.0.0.1', physicalAndroidDevice: false, touchHardwareEmulation: true, viewports: [[360, 800], [412, 915], [915, 412], [800, 1280], [1280, 800]] },
  measurementNotes: 'Headless Chromium on a Linux workstation; V2 suite enables touch API emulation. No CPU throttling, peak-memory measurement or physical Samsung/Android testing. Boot duration is navigation through ready tool registry from the preserved baseline suite.',
  fileProtocolVerification: { status: 'not-verified-in-this-run', note: 'Core interface tests run over local HTTP. Native tools are designed for file://, but dependency/CDN and secure-context restrictions vary by browser. No offline service worker is included.' },
  testedArtifact: { filename: 'index.html', bytes: fs.statSync(filename).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') },
  suites: suiteResults,
};
fs.writeFileSync(path.join(root, 'TEST_RESULTS.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ totalPassed: summary.passed, totalFailed: summary.failed, suites: suiteResults.map(s => ({ id: s.id, passed: s.passed, failed: s.failed })) }, null, 2));
if (failedProcess || summary.failed) process.exitCode = 1;
