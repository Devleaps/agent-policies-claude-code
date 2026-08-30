'use strict';

// "mid_code_import" resolver: is there an import statement nested below
// module level (indented, not at column 0)? Blank/comment lines are
// skipped first, matching the deleted Python implementation exactly - a
// module-level import (no leading whitespace) does not match.

const IMPORT_PATTERN = /^\s+(import\s+\S+|from\s+\S+\s+import\s+)/;

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{matched: boolean}}
 */
function midCodeImport(input) {
  for (const patch of input.structured_patch || []) {
    for (const line of patch.lines || []) {
      const stripped = line.content.trim();
      if (stripped === '' || stripped.startsWith('#')) continue;
      if (IMPORT_PATTERN.test(line.content)) {
        return { matched: true };
      }
    }
  }
  return { matched: false };
}

module.exports = { midCodeImport };
