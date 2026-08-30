'use strict';

// Session flags: per-session state a policy decision can set and later read
// back (cooldowns, "ran tests before this commit", multi-step workflows -
// see policies/demo_flags/*.rego). Disk-persisted per session_id at
// ~/.agent-policies/state/{session_id}.json, unlike the deleted server's
// in-memory-per-process store, so state survives across separate hook
// invocations (each a fresh process) the way a single long-lived server
// process never had to.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.agent-policies', 'state');
const DEFAULT_STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function statePath(stateDir, sessionId) {
  // session_id comes from the hook payload, not user-controlled shell
  // input, but sanitize defensively before using it as a filename anyway.
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(stateDir, `${safe}.json`);
}

/**
 * A flag's expiry state. Mirrors the deleted Flag dataclass's is_expired()
 * exactly:
 *   - expires_after is null/undefined -> never expires.
 *   - expires_after === 0 -> always expired, regardless of unit.
 *   - "seconds" -> (now - created_at) >= expires_after.
 *   - "invocations" -> invocations_remaining <= 0.
 *   - any other/missing unit with a non-zero expires_after -> never expires.
 */
function isExpired(flag, now) {
  if (flag.expires_after === null || flag.expires_after === undefined) return false;
  if (flag.expires_after === 0) return true;
  if (flag.expires_unit === 'seconds') {
    return now() - flag.created_at >= flag.expires_after * 1000;
  }
  if (flag.expires_unit === 'invocations') {
    return flag.invocations_remaining !== undefined && flag.invocations_remaining <= 0;
  }
  return false;
}

function readAllFlags(stateDir, sessionId) {
  try {
    const raw = fs.readFileSync(statePath(stateDir, sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeAllFlags(stateDir, sessionId, flags) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath(stateDir, sessionId), JSON.stringify(flags));
}

/**
 * Remove every expired flag for a session. Call before decrementInvocations
 * and before evaluating policy, matching the deleted server's per-event
 * order (cleanup -> decrement -> evaluate -> apply).
 */
function cleanupExpired(sessionId, { stateDir = DEFAULT_STATE_DIR, now = Date.now } = {}) {
  const flags = readAllFlags(stateDir, sessionId);
  let changed = false;
  for (const name of Object.keys(flags)) {
    if (isExpired(flags[name], now)) {
      delete flags[name];
      changed = true;
    }
  }
  if (changed) writeAllFlags(stateDir, sessionId, flags);
}

/**
 * Decrement invocations_remaining on every invocation-based flag for a
 * session, once per event, before policy evaluation reads the result -
 * matching the deleted server's decrement_invocation_flags, which runs
 * unconditionally on every event regardless of which flags a given event
 * actually touches.
 */
function decrementInvocations(sessionId, { stateDir = DEFAULT_STATE_DIR } = {}) {
  const flags = readAllFlags(stateDir, sessionId);
  let changed = false;
  for (const flag of Object.values(flags)) {
    if (flag.expires_unit === 'invocations' && flag.invocations_remaining !== undefined) {
      flag.invocations_remaining -= 1;
      changed = true;
    }
  }
  if (changed) writeAllFlags(stateDir, sessionId, flags);
}

/**
 * {name: value} for every non-expired flag - exactly what Rego reads as
 * input.session_flags (see policies/helpers/flags/flags.rego's flag_set/equals,
 * which key off input.session_flags, not input.parsed.flags).
 */
function getAllFlags(sessionId, { stateDir = DEFAULT_STATE_DIR, now = Date.now } = {}) {
  const flags = readAllFlags(stateDir, sessionId);
  const result = {};
  for (const [name, flag] of Object.entries(flags)) {
    if (!isExpired(flag, now)) result[name] = flag.value;
  }
  return result;
}

/**
 * Mirrors the deleted get_flag(session_id, name, value=None): false if the
 * flag is missing or expired; with no `value` argument, true on mere
 * presence; with one, true only if the flag's stored value matches exactly.
 */
function getFlag(sessionId, name, value, opts = {}) {
  const all = getAllFlags(sessionId, opts);
  if (!(name in all)) return false;
  if (value === undefined) return true;
  return all[name] === value;
}

/** Mirrors the deleted clear_flags: delete every flag for a session. */
function clearFlags(sessionId, { stateDir = DEFAULT_STATE_DIR } = {}) {
  try {
    fs.rmSync(statePath(stateDir, sessionId), { force: true });
  } catch {
    // already gone
  }
}

/**
 * Apply one flag spec from a decision's `flags` array: {name, value?,
 * expires_after?, expires_unit?}. Set-or-overwrite - re-setting a flag that
 * already exists resets its created_at/invocations_remaining, matching the
 * deleted server's set_flag exactly (a fresh Flag() replaces the old one
 * wholesale, it does not merge).
 */
function applyFlagSpec(sessionId, spec, { stateDir = DEFAULT_STATE_DIR, now = Date.now } = {}) {
  const flags = readAllFlags(stateDir, sessionId);
  const flag = {
    name: spec.name,
    value: spec.value === undefined ? true : spec.value,
    expires_after: spec.expires_after === undefined ? null : spec.expires_after,
    expires_unit: spec.expires_unit === undefined ? null : spec.expires_unit,
    created_at: now(),
  };
  if (flag.expires_unit === 'invocations' && flag.expires_after !== null) {
    flag.invocations_remaining = flag.expires_after;
  }
  flags[spec.name] = flag;
  writeAllFlags(stateDir, sessionId, flags);
}

/**
 * Delete every state file older than maxAgeMs (mtime-based) - the disk
 * equivalent of the deleted server's process-lifetime cleanup, needed
 * because unlike an in-memory dict, files on disk survive across sessions
 * that never touch them again. Call once per SessionStart, not per event.
 */
function sweepStaleState({ stateDir = DEFAULT_STATE_DIR, maxAgeMs = DEFAULT_STALE_AGE_MS, now = Date.now } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(stateDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (now() - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(fullPath, { force: true });
      }
    } catch {
      // already gone, or a permissions issue - not worth failing the sweep for one entry
    }
  }
}

module.exports = {
  isExpired,
  cleanupExpired,
  decrementInvocations,
  getAllFlags,
  getFlag,
  clearFlags,
  applyFlagSpec,
  sweepStaleState,
  DEFAULT_STATE_DIR,
};
