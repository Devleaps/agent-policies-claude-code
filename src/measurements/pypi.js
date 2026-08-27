'use strict';

// Ports the deleted RegoEvaluator._fetch_pypi_metadata (agent-policies-server,
// src/evaluation/rego.py, removed in the server-side-evaluation cutover) as a
// client-side "pypi_metadata" resolver for the incomplete/require multi-pass
// protocol (see policies/python_pip/pip_install.rego and
// policies/python_uv/uv_commands.rego).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.agent-policies', 'pypi-cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/**
 * GET https://pypi.org/pypi/{package}/json and return the raw parsed body,
 * or null on any failure (package not found, network error, timeout,
 * malformed JSON) - mirrors the Python original's blanket except-and-return-
 * None behavior; the caller can't distinguish failure reasons and isn't
 * meant to (the Rego side only needs "attempted, got nothing" vs "got data").
 */
function fetchPypiJson(packageName) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
      { timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Extract {name, age_days, first_version, first_upload_date} from a PyPI
 * JSON API response, using the OLDEST upload across every release (not just
 * the first key in `releases`, which is not guaranteed to be chronological) -
 * exactly mirrors the deleted Python implementation's loop.
 */
function extractMetadata(packageName, pypiJson) {
  if (!pypiJson || typeof pypiJson !== 'object') return null;
  const releases = pypiJson.releases || {};

  let firstVersion = null;
  let oldestDate = null;

  for (const [version, files] of Object.entries(releases)) {
    if (!Array.isArray(files) || files.length === 0) continue;
    const uploadDateStr = files[0].upload_time_iso_8601;
    if (!uploadDateStr) continue;
    const uploadDate = new Date(uploadDateStr);
    if (Number.isNaN(uploadDate.getTime())) continue;
    if (oldestDate === null || uploadDate < oldestDate) {
      oldestDate = uploadDate;
      firstVersion = version;
    }
  }

  if (oldestDate === null) return null;

  const ageDays = Math.floor((Date.now() - oldestDate.getTime()) / (24 * 60 * 60 * 1000));
  return {
    name: packageName,
    age_days: ageDays,
    first_version: firstVersion,
    first_upload_date: oldestDate.toISOString(),
  };
}

function cachePath(cacheDir, packageName) {
  // Package names are already validated by the parser/policy layer (they're
  // shell-safe tokens), but sanitize defensively before using one as a
  // filename component.
  const safe = packageName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(cacheDir, `${safe}.json`);
}

function readCache(cacheDir, packageName) {
  try {
    const raw = fs.readFileSync(cachePath(cacheDir, packageName), 'utf8');
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return undefined;
    return entry.metadata; // may be null (a cached "not found" result)
  } catch {
    return undefined;
  }
}

function writeCache(cacheDir, packageName, metadata) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(cacheDir, packageName), JSON.stringify({ cachedAt: Date.now(), metadata }));
  } catch {
    // Cache is a pure optimization; a write failure must not block the lookup.
  }
}

/**
 * Resolve a `{kind: "pypi_metadata", package: "<name>"}` require entry.
 * Returns the metadata object on success, or null if the package doesn't
 * exist on PyPI / the lookup failed - both cases the caller treats as
 * "attempted, nothing found" (see the Rego not-found-after-lookup rule).
 *
 * cacheDir defaults to ~/.agent-policies/pypi-cache; tests pass an isolated
 * scratch directory so they never touch a developer's real cache, and
 * fetchJson defaults to the real PyPI call so tests can substitute a fixture
 * instead of hitting the live network.
 */
async function resolvePypiMetadata(packageName, { cacheDir = DEFAULT_CACHE_DIR, fetchJson = fetchPypiJson } = {}) {
  const cached = readCache(cacheDir, packageName);
  if (cached !== undefined) return cached;

  const json = await fetchJson(packageName);
  const metadata = extractMetadata(packageName, json);
  writeCache(cacheDir, packageName, metadata);
  return metadata;
}

module.exports = { resolvePypiMetadata, extractMetadata, fetchPypiJson, DEFAULT_CACHE_DIR };
