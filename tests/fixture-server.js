'use strict';

// Stand-in for the real policy server's GET /bundles and
// GET /bundles/composed?names=... endpoints, so hooks.test.js can exercise
// the real hooks.json command (this plugin -> a real agent-policies-adapter
// -> a real opa daemon) end to end without depending on a live server or
// the adapter repo's own test fixtures.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FIXTURE_POLICIES = path.join(__dirname, 'fixtures', 'policies', 'universal');

function buildFixtureBundle() {
  const out = path.join(__dirname, 'fixtures', '.test-bundle.tar.gz');
  execFileSync('opa', ['build', '-b', FIXTURE_POLICIES, '-o', out, '-r', 'test']);
  const content = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return content;
}

function startFixtureServer() {
  const bundleContent = buildFixtureBundle();

  const server = http.createServer((req, res) => {
    if (req.url === '/bundles') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bundles: ['universal'] }));
      return;
    }
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
