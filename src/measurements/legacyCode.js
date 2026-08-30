'use strict';

// "legacy_code" resolver: does any ADDED line mention legacy/deprecated/
// backwards compatibility? Matched case-insensitively against the regex
// list, but unlike the deleted Python implementation, only added lines are
// considered - it matched any patch line regardless of operation, so
// removing a legacy/deprecated mention (or just having one nearby as
// unchanged context) could itself trigger this guidance.

const LEGACY_PATTERNS = [/\blegacy\b/, /\bbackwards\s+compatibility\b/, /\bbackward\s+compatibility\b/, /\bdeprecated\b/];

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{matched: boolean}}
 */
function legacyCode(input) {
  for (const patch of input.structured_patch || []) {
    for (const line of patch.lines || []) {
      if (line.operation !== 'added') continue;
      const lower = line.content.toLowerCase();
      if (LEGACY_PATTERNS.some((re) => re.test(lower))) {
        return { matched: true };
      }
    }
  }
  return { matched: false };
}

module.exports = { legacyCode };
