'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Parser, Language } = require('web-tree-sitter');

test('freshly built grammar loads and parses correctly', async () => {
  await Parser.init();
  const Bash = await Language.load(path.join(__dirname, '..', '..', 'vendor', 'tree-sitter-bash.wasm'));
  const parser = new Parser();
  parser.setLanguage(Bash);

  const src = 'git add -A file.txt';
  const tree = parser.parse(src);
  assert.equal(tree.rootNode.hasError, false);
  const cmd = tree.rootNode.child(0);
  const nameNode = cmd.childForFieldName('name');
  assert.equal(src.slice(nameNode.startIndex, nameNode.endIndex), 'git');
});
