#!/usr/bin/env node
'use strict';

// Corpus runner: drives the real client.js (parser + local opa daemon)
// against every case in agent-policies-server's declarative test corpus,
// pointed at a real instance of that server's actual policies, and reports
// a pass rate.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { parseCorpus } = require('../src/corpus');

const SERVER_REPO = path.resolve(__dirname, '..', '..', 'agent-policies-server');
const CORPUS_PATH = path.join(SERVER_REPO, 'tests', 'corpus', 'extracted_bash.yaml');
const CLIENT_PATH = path.join(__dirname, '..', 'scripts', 'client.js');
const SERVER_PORT = 18341;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('server did not become ready in time'));
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function runClient(hookPayload, configDir) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLIENT_PATH],
      {
        env: {
          ...process.env,
          AGENT_POLICIES_HOME: configDir,
          // Matches agent-policies-server's tests/http/conftest.py
          // base_event fixture (workspace_root/cwd both "/workspace"),
          // since the corpus was extracted from assertions made under
          // exactly that fixture.
          CLAUDE_PROJECT_DIR: '/workspace',
        },
      },
      (err, stdout, stderr) => {
        if (err && err.code !== 0) return reject(new Error(`client.js exited ${err.code}: ${stderr}`));
        resolve(stdout);
      },
    );
    child.stdin.write(JSON.stringify(hookPayload));
    child.stdin.end();
  });
}

function bundlesKey(bundles) {
  return [...bundles].sort().join(',');
}

async function main() {
  console.log(`Starting real policy server (repo: ${SERVER_REPO})...`);
  const server = spawn('uv', ['run', 'python', '-m', 'src.main'], {
    cwd: SERVER_REPO,
    env: { ...process.env, POLICY_SERVER_PORT: String(SERVER_PORT) },
    stdio: 'ignore',
  });

  const cleanupServer = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      try {
        server.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  };
  process.on('exit', cleanupServer);

  await waitForServer(`${SERVER_URL}/`, 20_000);
  console.log('Server ready.');

  const yamlText = fs.readFileSync(CORPUS_PATH, 'utf8');
  const cases = parseCorpus(yamlText);
  console.log(`Loaded ${cases.length} corpus cases.`);

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-corpus-run-'));
  const results = { pass: 0, fail: 0, failures: [] };

  // Group by bundle set so the daemon only restarts when the set actually
  // changes between consecutive cases, not on every single case.
  const byBundles = new Map();
  for (const c of cases) {
    const key = bundlesKey(c.bundles);
    if (!byBundles.has(key)) byBundles.set(key, { bundles: c.bundles, cases: [] });
    byBundles.get(key).cases.push(c);
  }

  for (const { bundles, cases: group } of byBundles.values()) {
    fs.writeFileSync(
      path.join(scratchDir, 'config.json'),
      JSON.stringify({ server_url: SERVER_URL, bundles }),
    );

    for (const testCase of group) {
      const step = testCase.steps[0];
      const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: step.bash },
        cwd: '/workspace',
      };

      let actual;
      try {
        const stdout = await runClient(payload, scratchDir);
        const output = JSON.parse(stdout);
        actual = output.hookSpecificOutput?.permissionDecision || 'pass';
      } catch (err) {
        actual = `ERROR: ${err.message}`;
      }

      const expected = step.expect;
      if (actual === expected) {
        results.pass += 1;
      } else {
        results.fail += 1;
        results.failures.push({ name: testCase.name, command: step.bash, expected, actual });
      }
    }
  }

  fs.rmSync(scratchDir, { recursive: true, force: true });
  cleanupServer();

  const total = results.pass + results.fail;
  const rate = ((results.pass / total) * 100).toFixed(1);
  console.log(`\n${results.pass}/${total} passed (${rate}%)\n`);

  if (results.failures.length > 0) {
    console.log('Failures:');
    for (const f of results.failures) {
      console.log(`  ${JSON.stringify(f.command)} -> expected ${f.expected}, got ${f.actual}  [${f.name}]`);
    }
  }

  process.exit(rate >= 95 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
