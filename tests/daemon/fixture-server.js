'use strict';

// Minimal stand-in for the real policy server's /bundles/composed endpoint,
// used only to give daemon.test.js something real to poll bundles from
// without depending on the sibling agent-policies-server repo.

const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FIXTURE_POLICIES = path.join(__dirname, 'fixtures', 'policies');

function buildFixtureBundle() {
  const out = path.join(__dirname, 'fixtures', '.test-bundle.tar.gz');
  execFileSync('opa', ['build', '-b', FIXTURE_POLICIES, '-o', out, '-r', 'test']);
  return out;
}

function startFixtureServer() {
  const bundlePath = buildFixtureBundle();
  const fs = require('node:fs');
  const bundleContent = fs.readFileSync(bundlePath);
  fs.rmSync(bundlePath, { force: true });

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bundles/composed')) {
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(bundleContent);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { startFixtureServer };
