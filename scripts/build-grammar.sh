#!/usr/bin/env bash
# Build vendor/tree-sitter-bash.wasm from the official tree-sitter-bash grammar.
#
# We deliberately do NOT depend on tree-sitter-wasms (a third-party, single-
# maintainer repackaging of prebuilt grammar .wasm files) - its bundled bash
# grammar was built against an older tree-sitter ABI than the current
# web-tree-sitter runtime, which fails at load time with a dylink-metadata
# error. Building from the official tree-sitter-bash package with a matching
# tree-sitter-cli version guarantees ABI compatibility.
#
# tree-sitter-bash and tree-sitter-cli are dev-only: they're used here to
# produce vendor/tree-sitter-bash.wasm, then removed. Nothing from them ships
# to end users; the plugin's only runtime dependency is web-tree-sitter.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Installing tree-sitter-bash + tree-sitter-cli (dev-only, removed after build)..."
npm install --no-save tree-sitter-bash tree-sitter-cli
npm approve-scripts tree-sitter-bash tree-sitter-cli 2>&1 || true
npm rebuild tree-sitter-bash tree-sitter-cli

CLI_VERSION=$(node_modules/tree-sitter-cli/tree-sitter --version | awk '{print $2}')
RUNTIME_VERSION=$(node -p "require('./node_modules/web-tree-sitter/package.json').version" 2>/dev/null || echo "not installed")

echo "tree-sitter-cli version: ${CLI_VERSION}"
echo "web-tree-sitter version: ${RUNTIME_VERSION}"
if [ "$RUNTIME_VERSION" != "not installed" ] && [ "$CLI_VERSION" != "$RUNTIME_VERSION" ]; then
  echo "WARNING: tree-sitter-cli (${CLI_VERSION}) and web-tree-sitter (${RUNTIME_VERSION}) versions differ." >&2
  echo "         The built grammar may not load if their WASM ABI has changed." >&2
fi

mkdir -p vendor
node_modules/tree-sitter-cli/tree-sitter build --wasm node_modules/tree-sitter-bash -o vendor/tree-sitter-bash.wasm

echo "Removing dev-only grammar/CLI packages (web-tree-sitter is the only runtime dep)..."
npm uninstall tree-sitter-bash tree-sitter-cli

echo "Built vendor/tree-sitter-bash.wasm:"
ls -lh vendor/tree-sitter-bash.wasm
