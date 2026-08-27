'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, ParseError } = require('../../src/parser');

// Ported 1:1 from agent-policies-server's
// tests/evaluation/test_command_parser.py and test_heredoc_parsing.py, which
// exercised the Python bashlex-based BashCommandParser. These same
// assertions must hold for the tree-sitter-based JS parser, since Rego
// policies are written against the ParsedCommand input contract those tests
// pin down.

test('simple command', async () => {
  const cmd = await parseCommand('ls');
  assert.equal(cmd.executable, 'ls');
  assert.equal(cmd.subcommand, null);
  assert.deepEqual(cmd.arguments, []);
  assert.deepEqual(cmd.flags, []);
  assert.deepEqual(cmd.options, {});
});

test('command with arguments', async () => {
  const cmd = await parseCommand('cat file.txt');
  assert.equal(cmd.executable, 'cat');
  assert.deepEqual(cmd.arguments, ['file.txt']);
});

test('command with flags', async () => {
  const cmd = await parseCommand('ls -la');
  assert.equal(cmd.executable, 'ls');
  assert.ok(cmd.flags.includes('-la'));
});

test('command with separate flags', async () => {
  const cmd = await parseCommand('git add -A');
  assert.equal(cmd.executable, 'git');
  assert.equal(cmd.subcommand, 'add');
  assert.ok(cmd.flags.includes('-A'));
});

test('command with options', async () => {
  const cmd = await parseCommand('git commit -m "message"');
  assert.equal(cmd.executable, 'git');
  assert.equal(cmd.subcommand, 'commit');
  assert.equal(cmd.options['-m'], '"message"');
});

test('command with option equals', async () => {
  const cmd = await parseCommand('docker build --tag=myapp:latest .');
  assert.equal(cmd.executable, 'docker');
  assert.equal(cmd.subcommand, 'build');
  assert.equal(cmd.options['--tag'], 'myapp:latest');
  assert.ok(cmd.arguments.includes('.'));
});

test('git subcommand detection', async () => {
  const cmd = await parseCommand('git add file.txt');
  assert.equal(cmd.executable, 'git');
  assert.equal(cmd.subcommand, 'add');
  assert.deepEqual(cmd.arguments, ['file.txt']);
});

test('docker subcommand detection', async () => {
  const cmd = await parseCommand('docker build .');
  assert.equal(cmd.executable, 'docker');
  assert.equal(cmd.subcommand, 'build');
  assert.deepEqual(cmd.arguments, ['.']);
});

test('command with redirect output', async () => {
  const cmd = await parseCommand('echo hello > output.txt');
  assert.equal(cmd.executable, 'echo');
  assert.deepEqual(cmd.arguments, ['hello']);
  assert.equal(cmd.redirects.length, 1);
  assert.equal(cmd.redirects[0][1], 'output.txt');
});

test('command with redirect append', async () => {
  const cmd = await parseCommand('echo hello >> output.txt');
  assert.equal(cmd.executable, 'echo');
  assert.equal(cmd.redirects.length, 1);
  assert.equal(cmd.redirects[0][1], 'output.txt');
});

test('pipeline', async () => {
  const cmd = await parseCommand('cat file.txt | grep pattern');
  assert.equal(cmd.executable, 'cat');
  assert.deepEqual(cmd.arguments, ['file.txt']);
  assert.equal(cmd.pipes.length, 1);
  assert.equal(cmd.pipes[0].executable, 'grep');
  assert.deepEqual(cmd.pipes[0].arguments, ['pattern']);
});

test('multiple pipes', async () => {
  const cmd = await parseCommand('cat file.txt | grep pattern | wc -l');
  assert.equal(cmd.executable, 'cat');
  assert.equal(cmd.pipes.length, 2);
  assert.equal(cmd.pipes[0].executable, 'grep');
  assert.equal(cmd.pipes[1].executable, 'wc');
});

test('empty command raises error', async () => {
  await assert.rejects(() => parseCommand(''), ParseError);
});

test('process substitution simple', async () => {
  const cmd = await parseCommand('diff <(cat file1.txt) <(cat file2.txt)');
  assert.equal(cmd.executable, 'diff');
  assert.equal(cmd.process_substitutions.length, 2);
  assert.equal(cmd.process_substitutions[0].executable, 'cat');
  assert.deepEqual(cmd.process_substitutions[0].arguments, ['file1.txt']);
  assert.equal(cmd.process_substitutions[1].executable, 'cat');
  assert.deepEqual(cmd.process_substitutions[1].arguments, ['file2.txt']);
});

test('process substitution with pipeline', async () => {
  const cmd = await parseCommand('diff <(ls | grep pattern | sort)');
  assert.equal(cmd.executable, 'diff');
  assert.equal(cmd.process_substitutions.length, 1);
  const ps = cmd.process_substitutions[0];
  assert.equal(ps.executable, 'ls');
  assert.equal(ps.pipes.length, 2);
  assert.equal(ps.pipes[0].executable, 'grep');
  assert.equal(ps.pipes[1].executable, 'sort');
});

test('process substitution with chained commands', async () => {
  const cmd = await parseCommand('diff <(ls) file.txt && echo "done"');
  assert.equal(cmd.executable, 'diff');
  assert.equal(cmd.process_substitutions.length, 1);
  assert.equal(cmd.process_substitutions[0].executable, 'ls');
  assert.equal(cmd.chained.length, 1);
  assert.equal(cmd.chained[0].executable, 'echo');
});

test('command substitution blocked', async () => {
  await assert.rejects(() => parseCommand('echo $(ls)'), ParseError);
});

test('process substitution with and operator fails', async () => {
  await assert.rejects(() => parseCommand('diff <(cmd1 && cmd2)'), ParseError);
});

test('process substitution with or operator fails', async () => {
  await assert.rejects(() => parseCommand('diff <(cmd1 || cmd2)'), ParseError);
});

test('process substitution with semicolon works', async () => {
  const cmd = await parseCommand('diff <(cmd1 ; cmd2)');
  assert.equal(cmd.process_substitutions.length, 1);
  const ps = cmd.process_substitutions[0];
  assert.equal(ps.executable, 'cmd1');
  assert.equal(ps.chained.length, 1);
  assert.equal(ps.chained[0].executable, 'cmd2');
});

test('process substitution multiple works', async () => {
  const cmd = await parseCommand('diff <(cat file1) <(cat file2) <(cat file3)');
  assert.equal(cmd.process_substitutions.length, 3);
});

test('process substitution nested pipes works', async () => {
  const cmd = await parseCommand('diff <(cat file | grep a | sort | uniq)');
  assert.equal(cmd.process_substitutions.length, 1);
  assert.equal(cmd.process_substitutions[0].pipes.length, 3);
});

test('compound command blocked', async () => {
  await assert.rejects(
    () => parseCommand('if [ -f file.txt ]; then cat file.txt; fi'),
    ParseError,
  );
});

test('mixed flags and options', async () => {
  const cmd = await parseCommand('pytest -v --maxfail=2 tests/');
  assert.equal(cmd.executable, 'pytest');
  assert.ok(cmd.flags.includes('-v'));
  assert.equal(cmd.options['--maxfail'], '2');
  assert.ok(cmd.arguments.includes('tests/'));
});

test('git commit with multiple options', async () => {
  const cmd = await parseCommand('git commit -m "msg" --amend');
  assert.equal(cmd.executable, 'git');
  assert.equal(cmd.subcommand, 'commit');
  assert.equal(cmd.options['-m'], '"msg"');
  assert.ok(cmd.flags.includes('--amend'));
});

test('terraform with subcommand', async () => {
  const cmd = await parseCommand('terraform plan -out=tfplan');
  assert.equal(cmd.executable, 'terraform');
  assert.equal(cmd.subcommand, 'plan');
  assert.equal(cmd.options['-out'], 'tfplan');
});

test('uv add packages', async () => {
  const cmd = await parseCommand('uv add requests httpx');
  assert.equal(cmd.executable, 'uv');
  assert.equal(cmd.subcommand, 'add');
  assert.deepEqual(cmd.arguments, ['requests', 'httpx']);
});

test('original command preserved', async () => {
  const original = 'git commit -m "test message"';
  const cmd = await parseCommand(original);
  assert.equal(cmd.original, original);
});

test('main command options', async () => {
  const cmd = await parseCommand('git -C /path/to/repo add file.txt');
  assert.equal(cmd.executable, 'git');
  assert.equal(cmd.options['-C'], '/path/to/repo');
  assert.equal(cmd.subcommand, 'add');
  assert.deepEqual(cmd.arguments, ['file.txt']);
});

test('main command options with flags', async () => {
  const cmd = await parseCommand('git -C src -c core.editor=vim commit -m "msg"');
  assert.equal(cmd.executable, 'git');
  assert.equal(cmd.options['-C'], 'src');
  assert.equal(cmd.options['-c'], 'core.editor=vim');
  assert.equal(cmd.subcommand, 'commit');
  assert.equal(cmd.options['-m'], '"msg"');
});

test('podman machine subcommand', async () => {
  const cmd = await parseCommand('podman machine list');
  assert.equal(cmd.executable, 'podman');
  assert.equal(cmd.subcommand, 'machine');
  assert.deepEqual(cmd.arguments, ['list']);
});

test('podman ps subcommand', async () => {
  const cmd = await parseCommand('podman ps');
  assert.equal(cmd.executable, 'podman');
  assert.equal(cmd.subcommand, 'ps');
  assert.deepEqual(cmd.arguments, []);
});

test('podman volume ls subcommand', async () => {
  const cmd = await parseCommand('podman volume ls');
  assert.equal(cmd.executable, 'podman');
  assert.equal(cmd.subcommand, 'volume');
  assert.deepEqual(cmd.arguments, ['ls']);
});

test('ls tilde home argument', async () => {
  const cmd = await parseCommand('ls ~/');
  assert.equal(cmd.executable, 'ls');
  assert.deepEqual(cmd.arguments, ['~/']);
});

test('ls tilde subdir argument', async () => {
  const cmd = await parseCommand('ls ~/.ssh/');
  assert.equal(cmd.executable, 'ls');
  assert.deepEqual(cmd.arguments, ['~/.ssh/']);
});

test('ls tilde flags and subdir', async () => {
  // Same as bashlex: -la is treated as an option key with ~/.ssh/ as its
  // value, since neither parser knows -la doesn't take an argument.
  const cmd = await parseCommand('ls -la ~/.ssh/');
  assert.equal(cmd.executable, 'ls');
  assert.deepEqual(cmd.options, { '-la': '~/.ssh/' });
});

// Heredoc-specific tests, ported from test_heredoc_parsing.py.

test('heredoc incomplete raises error', async () => {
  await assert.rejects(() => parseCommand("cat > /tmp/test.py << 'EOF'"), ParseError);
});

test('heredoc variants unparseable', async () => {
  const cases = ['cat > output.txt <<EOF', "cat > /tmp/test.py <<'EOF'", 'cat >> log.txt <<EOF'];
  for (const cmd of cases) {
    await assert.rejects(() => parseCommand(cmd), ParseError);
  }
});

test('multiple redirects with heredoc', async () => {
  const cmd = await parseCommand('sort < input.txt > output.txt');
  assert.equal(cmd.executable, 'sort');
  assert.equal(cmd.redirects.length, 2);
});
