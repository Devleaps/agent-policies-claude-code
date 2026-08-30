'use strict';

// "legacy_code" resolver: does any line mention legacy/deprecated/backwards
// compatibility? Matched case-insensitively against the whole patch,
// exactly like the deleted Python implementation's regex list.

const LEGACY_PATTERNS = [/\blegacy\b/, /\bbackwards\s+compatibility\b/, /\bbackward\s+compatibility\b/, /\bdeprecated\b/];

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{matched: boolean}}
 */
function legacyCode(input) {
  for (const patch of input.structured_patch || []) {
    for (const line of patch.lines || []) {
      const lower = line.content.toLowerCase();
      if (LEGACY_PATTERNS.some((re) => re.test(lower))) {
        return { matched: true };
      }
    }
  }
  return { matched: false };
}

module.exports = { legacyCode };
