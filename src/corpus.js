'use strict';

// Minimal reader for the declarative test corpus produced by
// agent-policies-server's scripts/extract_corpus.py. Matches that script's
// exact (narrow, hand-rolled) YAML output shape - not a general YAML parser.

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function parseCorpus(yamlText) {
  const cases = [];
  let current = null;

  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith('- name:')) {
      if (current) cases.push(current);
      current = { name: unquote(line.slice('- name:'.length)), bundles: ['universal'], steps: [] };
    } else if (line.trim().startsWith('bundles:')) {
      const inner = line.trim().slice('bundles:'.length).trim().replace(/^\[|\]$/g, '');
      current.bundles = inner
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
    } else if (line.trim().startsWith('- bash:')) {
      current.steps.push({ bash: unquote(line.trim().slice('- bash:'.length)) });
    } else if (line.trim().startsWith('expect:')) {
      current.steps[current.steps.length - 1].expect = unquote(line.trim().slice('expect:'.length));
    }
  }
  if (current) cases.push(current);

  return cases;
}

module.exports = { parseCorpus };
