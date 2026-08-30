'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.agent-policies');

const HEALTH_TIMEOUT_MS = 500;
const READY_POLL_INTERVAL_MS = 200;
const READY_TIMEOUT_MS = 10_000;

// Must match agent-policies-server's src/server/bundles.py KNOWN_BUNDLES
// exactly - kept manually in sync since there's no shared source of truth
// across the two repos. Without this, a malformed or malicious
// config.json's `bundles` list would be string-interpolated straight into
// the daemon's bundle-service resource path unvalidated. Exported (rather
// than enforced inside ensureDaemon itself) so this module's own tests can
// keep exercising daemon lifecycle mechanics with synthetic bundle names
// that don't correspond to any real server bundle - validation is the
// caller's concern (see client.js), not this module's.
const KNOWN_BUNDLES = new Set(['universal', 'python_uv', 'python_pip', 'demo_bundles', 'demo_flags']);

function allBundlesKnown(bundleNames) {
  return Array.isArray(bundleNames) && bundleNames.every((name) => KNOWN_BUNDLES.has(name));
}

function paths(configDir) {
  return {
    configDir,
    socketPath: path.join(configDir, 'opa.sock'),
    lockPath: path.join(configDir, 'opa.lock'),
    statePath: path.join(configDir, 'opa.state.json'),
    configPath: path.join(configDir, 'opa-config.yaml'),
  };
}

function requestOverSocket(socketPath, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function isHealthy(socketPath) {
  try {
    const { status } = await requestOverSocket(socketPath, 'GET', '/health?bundles=true', null, HEALTH_TIMEOUT_MS);
    return status === 200;
  } catch {
    return false;
  }
}

function readState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeState(statePath, pid, bundles) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ pid, bundles }));
}

/**
 * Send SIGTERM to a tracked daemon PID. OPA has no HTTP shutdown endpoint
 * (verified: DELETE / returns 405 Method Not Allowed) - a process signal is
 * the only way to stop it, so the PID recorded at spawn time is load-bearing
 * for the restart-on-bundle-change path.
 */
function terminateTrackedDaemon(state) {
  if (!state || !state.pid) return;
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    // already dead
  }
}

function sameBundleSet(a, b) {
  if (!a || !b) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.length === sortedB.length && sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Acquire an exclusive lock so concurrent hook invocations racing to spawn
 * the daemon don't start two instances competing for the same socket path.
 * Uses `wx` (exclusive create) as the atomic primitive; a lock older than
 * READY_TIMEOUT_MS is assumed orphaned (its owning process died mid-startup)
 * and is reclaimed rather than blocking forever.
 */
function tryAcquireSpawnLock(lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > READY_TIMEOUT_MS) {
        fs.rmSync(lockPath, { force: true });
        return tryAcquireSpawnLock(lockPath);
      }
    } catch {
      // lock disappeared between the failed create and the stat; fall through
    }
    return false;
  }
}

function releaseSpawnLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // already gone
  }
}

function removeStaleSocket(socketPath) {
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // nothing to remove
  }
}

function writeOpaConfig(configPath, serverUrl, bundleNames) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const resource = `/bundles/composed?names=${[...bundleNames].sort().join(',')}`;
  const yaml = [
    'services:',
    '  devleaps:',
    `    url: ${serverUrl}`,
    'bundles:',
    '  policies:',
    '    service: devleaps',
    `    resource: ${resource}`,
    '    polling:',
    '      min_delay_seconds: 60',
    '      max_delay_seconds: 120',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, yaml);
}

function spawnDaemon(socketPath, configPath) {
  removeStaleSocket(socketPath);
  const child = spawn(
    'opa',
    [
      'run', '--server',
      '-a', `unix://${socketPath}`,
      '-c', configPath,
      '--disable-telemetry',
      '--log-level=error',
      '--ready-timeout=10',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  return child.pid;
}

async function waitUntilHealthy(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

async function waitUntilSocketGone(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  removeStaleSocket(socketPath);
  return true;
}

/**
 * Ensure a local OPA daemon is running with exactly the requested bundle set
 * active, spawning or restarting it as needed. Returns true if the daemon is
 * confirmed healthy and serving the requested bundles, false if it could not
 * be brought up (callers should fall back to default_policy_behavior).
 *
 * configDir defaults to ~/.agent-policies; tests pass an isolated scratch
 * directory so they never touch a developer's real daemon state.
 */
async function ensureDaemon(serverUrl, bundleNames, configDir = DEFAULT_CONFIG_DIR) {
  const { socketPath, lockPath, statePath, configPath } = paths(configDir);

  const alreadyHealthy = await isHealthy(socketPath);
  const state = readState(statePath);

  if (alreadyHealthy && sameBundleSet(state && state.bundles, bundleNames)) {
    return true;
  }

  if (!tryAcquireSpawnLock(lockPath)) {
    // Another hook invocation is already spawning/restarting; wait for it
    // instead of racing to start a second daemon on the same socket.
    const healthy = await waitUntilHealthy(socketPath, READY_TIMEOUT_MS);
    return healthy && sameBundleSet(readState(statePath)?.bundles, bundleNames);
  }

  try {
    if (alreadyHealthy) {
      // Bundle selection changed since the daemon was started - it must be
      // killed and respawned with the new config, since OPA has no HTTP
      // shutdown/reconfigure endpoint (DELETE / is 405 Method Not Allowed).
      terminateTrackedDaemon(state);
      await waitUntilSocketGone(socketPath, READY_TIMEOUT_MS);
    }

    writeOpaConfig(configPath, serverUrl, bundleNames);
    const pid = spawnDaemon(socketPath, configPath);
    writeState(statePath, pid, bundleNames);
    return await waitUntilHealthy(socketPath, READY_TIMEOUT_MS);
  } finally {
    releaseSpawnLock(lockPath);
  }
}

function socketPathFor(configDir = DEFAULT_CONFIG_DIR) {
  return paths(configDir).socketPath;
}

module.exports = {
  ensureDaemon,
  requestOverSocket,
  isHealthy,
  socketPathFor,
  DEFAULT_CONFIG_DIR,
  KNOWN_BUNDLES,
  allBundlesKnown,
};
