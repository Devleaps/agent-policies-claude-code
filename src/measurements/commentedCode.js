'use strict';

// "commented_code" resolver: detects a run of 2+ consecutive lines that
// look like commented-out code - an indented comment, or a comment whose
// content itself looks indented (2+ spaces after the '#'). Matched against
// raw (unstripped) content, exactly like the deleted Python implementation.

const INDENTED_COMMENT = /^\s+#/;
const COMMENTED_INDENTED_CODE = /^#\s{2,}/;

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{max_run: number}} the longest run of consecutive matching
 *   lines found anywhere in the patch (0 if none).
 */
function commentedCode(input) {
  let maxRun = 0;
  let currentRun = 0;

  for (const patch of input.structured_patch || []) {
    for (const line of patch.lines || []) {
      if (INDENTED_COMMENT.test(line.content) || COMMENTED_INDENTED_CODE.test(line.content)) {
        currentRun += 1;
        if (currentRun > maxRun) maxRun = currentRun;
      } else {
        currentRun = 0;
      }
    }
    currentRun = 0; // a run doesn't span across separate patch hunks
  }

  return { max_run: maxRun };
}

module.exports = { commentedCode };
