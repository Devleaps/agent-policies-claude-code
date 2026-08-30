'use strict';

// "comment_overlap" resolver: does a comment mostly restate the code next
// to it? Checked in two forms per line - inline ("code  # comment") and
// standalone ("# comment" on its own line, compared against the next
// line's code) - matching the deleted Python implementation exactly,
// including its keyword-extraction quirks (digits/underscores act as word
// separators since the regex only matches [a-z]+, so "get_user_id" becomes
// {"get", "user"} - "id" is dropped for being length <= 2).

function extractKeywords(text) {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  return new Set(words.filter((w) => w.length > 2));
}

function overlapRatio(commentKeywords, codeKeywords) {
  if (commentKeywords.size === 0 || codeKeywords.size === 0) return null;
  let intersection = 0;
  for (const word of commentKeywords) {
    if (codeKeywords.has(word)) intersection += 1;
  }
  return intersection / commentKeywords.size;
}

/**
 * @param {{structured_patch: Array<{lines: Array<{operation: string, content: string}>}>}} input
 * @returns {{ratio: number}|null} the first offending line's ratio, or null
 *   if no line in either form produced a comparable ratio. Matches the
 *   original's "return after first yield" behavior - at most one measurement.
 */
function commentOverlap(input) {
  for (const patch of input.structured_patch || []) {
    const lines = patch.lines || [];
    for (let i = 0; i < lines.length; i += 1) {
      const content = lines[i].content;
      const stripped = content.trim();

      // Inline form: "code # comment" - split on the first '#'.
      if (stripped.includes('#') && !stripped.startsWith('#')) {
        const hashIndex = content.indexOf('#');
        const codePart = content.slice(0, hashIndex);
        const commentPart = content.slice(hashIndex + 1);
        if (commentPart.trim() !== '' && !commentPart.trim().startsWith('!')) {
          const commentKeywords = extractKeywords(commentPart);
          const codeKeywords = extractKeywords(codePart);
          const ratio = overlapRatio(commentKeywords, codeKeywords);
          if (ratio !== null) return { ratio };
        }
        continue;
      }

      // Standalone form: "# comment" on its own line, compared against the
      // next line's code (must be non-empty and not itself a comment).
      if (stripped.startsWith('#') && !stripped.startsWith('#!')) {
        const next = lines[i + 1];
        if (!next) continue;
        const nextStripped = next.content.trim();
        if (nextStripped === '' || nextStripped.startsWith('#')) continue;

        const commentKeywords = extractKeywords(stripped.slice(1));
        const codeKeywords = extractKeywords(next.content);
        const ratio = overlapRatio(commentKeywords, codeKeywords);
        if (ratio !== null) return { ratio };
      }
    }
  }
  return null;
}

module.exports = { commentOverlap, extractKeywords };
