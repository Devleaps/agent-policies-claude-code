'use strict';

// "comment_ratio" resolver: over every non-blank patch line, what fraction
// are comments? A line counts as a comment if it starts with "#" and is not
// a shebang ("#!"). Ratio is comments as a fraction of ALL non-blank lines
// (comments + code), not comments-to-code - matching the deleted Python
// implementation's naming despite that naming being slightly misleading.

function isCommentLine(content) {
  const stripped = content.trim();
  return stripped.startsWith('#') && !stripped.startsWith('#!');
}

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{ratio: number}|null} null when there is no code to compare
 *   against (guards the original Python's `if code_count > 0` - an
 *   all-comment or all-blank patch produces no measurement at all, rather
 *   than a nonsensical 100% ratio).
 */
function commentRatio(input) {
  let commentCount = 0;
  let codeCount = 0;

  for (const patch of input.structured_patch || []) {
    for (const line of patch.lines || []) {
      const stripped = line.content.trim();
      if (stripped === '') continue;
      if (isCommentLine(line.content)) {
        commentCount += 1;
      } else {
        codeCount += 1;
      }
    }
  }

  if (codeCount === 0) return null;
  return { ratio: commentCount / (codeCount + commentCount) };
}

module.exports = { commentRatio };
