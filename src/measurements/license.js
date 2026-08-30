'use strict';

// "license" resolver: was a line mentioning "license" ADDED (not just
// present in unchanged context)? Only checks added lines, matching the
// deleted Python implementation - editing a file that already mentions
// licensing elsewhere should not trigger this.

const LICENSE_PATTERN = /\blicense\b/i;

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{matched: boolean}}
 */
function license(input) {
  for (const patch of input.structured_patch || []) {
    for (const line of patch.lines || []) {
      if (line.operation !== 'added') continue;
      if (LICENSE_PATTERN.test(line.content)) {
        return { matched: true };
      }
    }
  }
  return { matched: false };
}

module.exports = { license };
