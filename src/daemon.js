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

function isProcessAlive(pid) {
  try {
    // Signal 0 sends nothing - it only tests whether the process exists
    // and is signalable, which is exactly what's needed here.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a terminated daemon's process to actually exit. Does not wait
 * for its socket *file* to disappear - a killed (as opposed to gracefully
 * exited) process can leave that file behind indefinitely, and spawnDaemon
 * already unconditionally removes any stale socket right before binding a
 * fresh one, so waiting on the file here would only ever pay the full
 * timeout for no benefit in exactly the case (an already-dead daemon) this
 * is meant to handle quickly.
 */
async function waitUntilProcessGone(pid, timeoutMs) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Ensure a local OPA daemon is running with exactly the requested bundle set
 * active, spawning or restarting it as needed. Returns true if a daemon
 * matching bundleNames is now running (freshly confirmed healthy if just
 * spawned/respawned), false if it could not be brought up (callers should
 * fall back to default_policy_behavior).
 *
 * Deliberately does NOT probe a live socket to decide whether an
 * already-tracked daemon is reusable - a dedicated /health round trip here
 * and the real query moments later in the caller are two separate socket
 * requests that can disagree under load (the actual daemon is fine, but the
 * probe times out on a busy machine, so this used to tear down and replace
 * a perfectly healthy daemon). Instead this trusts the state file: if its
 * recorded bundle set already matches, assume the daemon is reachable and
 * let the caller's own query be the real liveness test - see
 * DaemonUnreachableError in twopass.js and its retry-with-forceRespawn use
 * in client.js. Only forceRespawn or an actual bundle-set mismatch pays for
 * a fresh spawn-and-wait-until-healthy cycle here.
 *
 * configDir defaults to ~/.agent-policies; tests pass an isolated scratch
 * directory so they never touch a developer's real daemon state.
 */
async function ensureDaemon(serverUrl, bundleNames, configDir = DEFAULT_CONFIG_DIR, { forceRespawn = false } = {}) {
  const { socketPath, lockPath, statePath, configPath } = paths(configDir);
  const state = readState(statePath);
  const bundlesMatch = sameBundleSet(state && state.bundles, bundleNames);

  if (!forceRespawn && bundlesMatch) {
    return true;
  }

  if (!tryAcquireSpawnLock(lockPath)) {
    // Another hook invocation is already spawning/restarting; wait for it
    // instead of racing to start a second daemon on the same socket.
    const healthy = await waitUntilHealthy(socketPath, READY_TIMEOUT_MS);
    return healthy && sameBundleSet(readState(statePath)?.bundles, bundleNames);
  }

  try {
    if (state) {
      // Either the bundle set changed (must respawn with new config - OPA
      // has no HTTP shutdown/reconfigure endpoint, DELETE / is 405 Method
      // Not Allowed) or the caller already tried this daemon and it did
      // not respond (forceRespawn) - either way the existing process is no
      // longer trustworthy and must go before starting a replacement.
      terminateTrackedDaemon(state);
      await waitUntilProcessGone(state.pid, READY_TIMEOUT_MS);
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
