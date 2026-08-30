'use strict';
// Manual latency breakdown: how long does one client.js invocation take
// against an already-warm daemon, and where does the time actually go?
// Not part of the node:test suite (npm test only picks up *.test.js) - a
// reusable verification tool for the Phase 2 <50ms budget, which was
// specifically about daemon-query overhead, not Node process startup or
// WASM parser init. Run with: node tests/manual/measure-latency.js
//
// Prerequisites: a real bundle server reachable at the configured
// server_url, and a warm daemon under tests/manual/.agent-policies-home
// (this script will spawn one on first run via client.js itself).

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const CLIENT_PATH = path.join(__dirname, '..', '..', 'scripts', 'client.js');
const CONFIG_DIR = path.join(__dirname, '.agent-policies-home');
const N = 30;

function percentile(sorted, pct) {
  return sorted[Math.floor((sorted.length - 1) * pct)];
}

function summarize(label, timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(28)} min=${sorted[0].toFixed(1)}ms  p50=${percentile(sorted, 0.5).toFixed(1)}ms  ` +
      `p95=${percentile(sorted, 0.95).toFixed(1)}ms  max=${sorted[sorted.length - 1].toFixed(1)}ms`,
  );
}

// Phase 1: bare `node -e ""` process startup, no requires at all - the
// floor cost of spawning a Node process per hook invocation, unrelated to
// this plugin's own code.
function measureBareNodeStartup() {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    execFile(process.execPath, ['-e', ''], (err) => {
      const end = process.hrtime.bigint();
      if (err) return reject(err);
      resolve(Number(end - start) / 1e6);
    });
  });
}

// Phase 2: full client.js invocation end-to-end (Node startup + requires +
// WASM parser init + daemon round-trip) - what a real hook invocation
// actually costs, against an already-warm daemon.
function measureFullInvocation(payload) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const child = execFile(
      process.execPath,
      [CLIENT_PATH],
      { env: { ...process.env, AGENT_POLICIES_HOME: CONFIG_DIR } },
      (err, stdout, stderr) => {
        const end = process.hrtime.bigint();
        if (err && err.code !== 0) return reject(new Error(`client.js exited ${err.code}: ${stderr}`));
        resolve({ ms: Number(end - start) / 1e6, stdout });
      },
    );
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// Phase 3: WASM grammar load + parser init in isolation, via a fresh child
// process each time (so nothing is pre-warmed by a prior require in this
// same process) - isolates the one-time cost that client.js pays on every
// invocation, since the module cache doesn't survive across processes.
function measureParserInit() {
  return new Promise((resolve, reject) => {
    const parserPath = path.join(__dirname, '..', '..', 'src', 'parser').replace(/\\/g, '\\\\');
    const script =
      `const start = process.hrtime.bigint();` +
      `require('${parserPath}').parseCommand('ls -la').then(() => {` +
      `const end = process.hrtime.bigint();` +
      `process.stdout.write(String(Number(end - start) / 1e6));` +
      `}).catch((e) => { process.stderr.write(e.stack); process.exit(1); });`;
    execFile(process.execPath, ['-e', script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr));
      resolve(Number(stdout));
    });
  });
}

// Phase 3b: just `require('../src/parser')` with no call into it at all -
// isolates module-graph load cost (including require('web-tree-sitter')
// itself) from the WASM Parser.init()/grammar-load cost measured above.
function measureParserRequireOnly() {
  return new Promise((resolve, reject) => {
    const parserPath = path.join(__dirname, '..', '..', 'src', 'parser').replace(/\\/g, '\\\\');
    const script =
      `const start = process.hrtime.bigint();` +
      `require('${parserPath}');` +
      `const end = process.hrtime.bigint();` +
      `process.stdout.write(String(Number(end - start) / 1e6));`;
    execFile(process.execPath, ['-e', script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr));
      resolve(Number(stdout));
    });
  });
}

// Phase 4: the daemon round-trip in isolation - health check + one
// /v1/data query over the unix socket, no Node startup or parser involved,
// run in-process (this script's own process, not a spawned child) since
// there's nothing here that depends on module-cache-per-process state.
async function measureDaemonRoundTrip() {
  const { isHealthy, socketPathFor, requestOverSocket } = require(
    path.join(__dirname, '..', '..', 'src', 'daemon'),
  );
  const socketPath = socketPathFor(CONFIG_DIR);

  const healthStart = process.hrtime.bigint();
  await isHealthy(socketPath);
  const healthEnd = process.hrtime.bigint();

  const queryStart = process.hrtime.bigint();
  await requestOverSocket(
    socketPath,
    'POST',
    '/v1/data/universal/decisions',
    { input: { parsed: { executable: 'ls', arguments: [], options: {} } } },
    2000,
  );
  const queryEnd = process.hrtime.bigint();

  return {
    healthMs: Number(healthEnd - healthStart) / 1e6,
    queryMs: Number(queryEnd - queryStart) / 1e6,
  };
}

// Phase 5: the interaction that actually explains client.js's real-world
// cost - a WASM parse followed immediately by the daemon health check, in
// ONE process (matching client.js's real call order: parseCommand, then
// ensureDaemon). Phases 3/4 measured these in separate processes and each
// came back cheap in isolation (~20ms parser init, ~0.2ms daemon round
// trip) - this phase is what actually reproduces the ~100ms gap: the first
// async socket call issued right after a WASM parse pays a one-time tax
// that neither operation shows on its own. Root cause not fully isolated -
// looks like a web-tree-sitter/Emscripten runtime characteristic (pending
// microtask or WASM-linear-memory bookkeeping) that resolves on the next
// event-loop tick after a parse call, rather than a bug in this plugin's
// own logic.
async function measureParseThenHealthCheck() {
  return new Promise((resolve, reject) => {
    const parserPath = path.join(__dirname, '..', '..', 'src', 'parser').replace(/\\/g, '\\\\');
    const daemonPath = path.join(__dirname, '..', '..', 'src', 'daemon').replace(/\\/g, '\\\\');
    const configDir = CONFIG_DIR.replace(/\\/g, '\\\\');
    const script =
      `(async () => {` +
      `const { parseCommand } = require('${parserPath}');` +
      `await parseCommand('ls -la');` +
      `const { isHealthy, socketPathFor } = require('${daemonPath}');` +
      `const socketPath = socketPathFor('${configDir}');` +
      `const start = process.hrtime.bigint();` +
      `await isHealthy(socketPath);` +
      `const end = process.hrtime.bigint();` +
      `process.stdout.write(String(Number(end - start) / 1e6));` +
      `})().catch((e) => { process.stderr.write(e.stack); process.exit(1); });`;
    execFile(process.execPath, ['-e', script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr));
      resolve(Number(stdout));
    });
  });
}

async function repeated(fn, n) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    results.push(await fn());
  }
  return results;
}

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const configPath = path.join(CONFIG_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ server_url: 'http://localhost:8338', bundles: ['universal'] }),
    );
  }

  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    cwd: process.cwd(),
  };

  // Warm-up call, not measured (daemon may still be settling from a spawn).
  await measureFullInvocation(payload);

  console.log(`N=${N} per phase\n`);

  const bareStartups = await repeated(() => measureBareNodeStartup(), N);
  summarize('bare node startup', bareStartups);

  const parserRequires = await repeated(() => measureParserRequireOnly(), N);
  summarize('require(parser.js) only', parserRequires);

  const parserInits = await repeated(() => measureParserInit(), N);
  summarize('WASM parser init (cold)', parserInits);

  const fullInvocations = (await repeated(() => measureFullInvocation(payload), N)).map((r) => r.ms);
  summarize('full client.js invocation', fullInvocations);

  const roundTrips = await repeated(() => measureDaemonRoundTrip(), N);
  summarize('daemon health check', roundTrips.map((r) => r.healthMs));
  summarize('daemon /v1/data query', roundTrips.map((r) => r.queryMs));

  const parseThenHealth = await repeated(() => measureParseThenHealthCheck(), N);
  summarize('health check right after a parse', parseThenHealth);

  const bareP50 = [...bareStartups].sort((a, b) => a - b)[Math.floor((N - 1) * 0.5)];
  const fullP50 = [...fullInvocations].sort((a, b) => a - b)[Math.floor((N - 1) * 0.5)];
  console.log(`\nclient.js's own overhead beyond bare Node startup (p50 - p50): ${(fullP50 - bareP50).toFixed(1)}ms`);
}

main();
