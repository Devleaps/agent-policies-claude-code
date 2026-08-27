'use strict';

const path = require('node:path');

/**
 * Resolve a path to its workspace-relative form when it can be proven to
 * fall inside workspace_root, or return it unchanged so Rego's is_safe_path
 * denies it (an absolute/tilde/dotdot path that can't be shown safe is
 * treated as unsafe, not silently allowed).
 *
 * Tilde paths are resolved only against a client-supplied home (never the
 * evaluating machine's own $HOME - that has no relation to the workspace).
 */
function normalizePath(rawPath, workspaceRoot, cwd, home) {
  if (!rawPath || !workspaceRoot) return rawPath;

  let candidate = rawPath;

  if (candidate.startsWith('~')) {
    if (!home) return rawPath;
    if (candidate === '~' || candidate.startsWith('~/')) {
      candidate = home + candidate.slice(1);
    } else {
      // "~otheruser/..." - no client-side info to resolve this
      return rawPath;
    }
  }

  const isAbsolute = path.isAbsolute(candidate);
  const hasDotDot = candidate.split('/').includes('..');
  if (!isAbsolute && !hasDotDot) return rawPath;

  let resolved;
  try {
    if (path.isAbsolute(candidate)) {
      resolved = path.normalize(candidate);
    } else if (cwd) {
      resolved = path.normalize(path.join(cwd, candidate));
    } else {
      return rawPath;
    }
  } catch {
    return rawPath;
  }

  const root = workspaceRoot.replace(/\/+$/, '');
  if (resolved === root || resolved.startsWith(root + '/')) {
    return path.relative(root, resolved);
  }

  return rawPath;
}

/**
 * Build the resolved_paths map: every argument, redirect target, and option
 * value that normalizePath actually changed (i.e. proved workspace-relative)
 * - unchanged entries are omitted.
 */
function buildResolvedPaths(parsed, workspaceRoot, cwd, home) {
  const candidates = [
    ...parsed.arguments,
    ...parsed.redirects.map(([, target]) => target),
    ...Object.values(parsed.options),
  ];

  const resolvedPaths = {};
  for (const candidate of candidates) {
    const resolved = normalizePath(candidate, workspaceRoot, cwd, home);
    if (resolved !== candidate) {
      resolvedPaths[candidate] = resolved;
    }
  }
  return resolvedPaths;
}

module.exports = { normalizePath, buildResolvedPaths };
