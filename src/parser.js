'use strict';

const path = require('node:path');
const { Parser, Language } = require('web-tree-sitter');

class ParseError extends Error {}

// Commands known to take subcommands (git add, docker build, uv add, ...).
const SUBCOMMAND_EXECUTABLES = new Set([
  'git', 'docker', 'podman', 'kubectl', 'terraform', 'terragrunt', 'gh',
  'az', 'gcloud', 'aws', 'npm', 'pip', 'uv', 'cargo', 'ruff', 'mypy',
  'black', 'pytest', 'vale',
]);

// Top-level shell constructs the policy engine does not understand and must
// therefore deny outright, matching bashlex's behavior for compound commands.
const REJECTED_NODE_TYPES = new Set([
  'if_statement', 'for_statement', 'c_style_for_statement', 'while_statement',
  'case_statement', 'function_definition', 'subshell', 'compound_statement',
]);

let bashLanguage = null;

async function getParser() {
  await Parser.init();
  if (!bashLanguage) {
    bashLanguage = await Language.load(
      path.join(__dirname, '..', 'vendor', 'tree-sitter-bash.wasm'),
    );
  }
  const parser = new Parser();
  parser.setLanguage(bashLanguage);
  return parser;
}

function text(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}

function isLikelySubcommand(executable, word) {
  if (!SUBCOMMAND_EXECUTABLES.has(executable)) return false;
  return !word.includes('/') && !word.includes('.');
}

/**
 * Split a flat list of word tokens (after the executable) into
 * subcommand / arguments / flags / options.
 */
function classifyWords(executable, words) {
  let subcommand = null;
  const arguments_ = [];
  const flags = [];
  const options = {};

  let i = 0;
  while (i < words.length) {
    const word = words[i];

    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      if (eq !== -1) {
        options[word.slice(0, eq)] = word.slice(eq + 1);
      } else if (i + 1 < words.length && !words[i + 1].startsWith('-')) {
        options[word] = words[i + 1];
        i += 1;
      } else {
        flags.push(word);
      }
    } else if (!subcommand && arguments_.length === 0 && isLikelySubcommand(executable, word)) {
      subcommand = word;
    } else {
      arguments_.push(word);
    }

    i += 1;
  }

  return { subcommand, arguments: arguments_, flags, options };
}

/**
 * Collect the flat word/redirect/process-substitution content of a single
 * `command` node - tree-sitter gives us `command_name` plus `argument`
 * fields; redirects and heredocs are separate `redirected_statement`
 * wrapper nodes handled in extractCommand.
 */
function collectCommandWords(commandNode, src) {
  const words = [];
  const processSubstitutions = [];

  // Only `argument`-labeled children belong in the word list (redirects
  // aren't children of `command` at all - they wrap it via
  // `redirected_statement`, handled separately in extractCommand).
  for (let i = 0; i < commandNode.childCount; i++) {
    const child = commandNode.child(i);
    const fieldName = commandNode.fieldNameForChild(i);
    if (fieldName !== 'argument') continue;

    if (child.type === 'command_substitution') {
      throw new ParseError('Command substitution not supported');
    }
    if (child.type === 'process_substitution') {
      processSubstitutions.push(extractProcessSubstitution(child, src));
      continue;
    }

    words.push(text(child, src));
  }

  return { words, processSubstitutions };
}

function extractProcessSubstitution(node, src) {
  // process_substitution children: '<(' or '>(', then either a single
  // `list`/`pipeline` node (for a `&&`/`||`-joined or piped body), or a flat
  // `;`-separated sequence of `command` nodes directly, then ')'.
  const statementLikeTypes = new Set(['command', 'redirected_statement', 'pipeline']);
  const statements = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === '&&' || child.type === '||') {
      throw new ParseError('&& / || not supported inside process substitution');
    }
    if (child.type === 'list') {
      throw new ParseError('&& / || not supported inside process substitution');
    }
    if (statementLikeTypes.has(child.type)) {
      statements.push(child);
    }
  }

  if (statements.length === 0) throw new ParseError('Empty process substitution');

  const parsed = statements.map((n) => extractStatement(n, src));
  const result = parsed[0];
  result.chained = [...result.chained, ...parsed.slice(1)];
  return result;
}

function extractRedirects(node, src) {
  // Only meaningful on a `redirected_statement` node - `file_redirect`
  // children carry the operator token and a `destination` field; heredocs
  // (`heredoc_redirect`) are intentionally not extracted here (see below).
  const redirects = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const fieldName = node.fieldNameForChild(i);
    if (fieldName !== 'redirect') continue;
    if (child.type !== 'file_redirect') continue;

    const opToken = child.child(0);
    const destNode = child.childForFieldName('destination');
    if (!destNode) continue;
    redirects.push([text(opToken, src), text(destNode, src)]);
  }
  return redirects;
}

function extractCommand(node, src) {
  let commandNode = node;
  let redirects = [];

  if (node.type === 'redirected_statement') {
    commandNode = node.childForFieldName('body');
    redirects = extractRedirects(node, src);
  }

  if (!commandNode || commandNode.type !== 'command') {
    throw new ParseError(`Unsupported node kind: ${node.type}`);
  }

  const nameNode = commandNode.childForFieldName('name');
  if (!nameNode) throw new ParseError('No executable found in command');
  const executable = text(nameNode, src);

  const { words, processSubstitutions } = collectCommandWords(commandNode, src);
  const { subcommand, arguments: arguments_, flags, options } = classifyWords(executable, words);

  return {
    executable,
    subcommand,
    arguments: arguments_,
    flags,
    options,
    redirects,
    pipes: [],
    chained: [],
    process_substitutions: processSubstitutions,
    original: src,
  };
}

function extractStatement(node, src) {
  if (REJECTED_NODE_TYPES.has(node.type)) {
    throw new ParseError(`Compound commands (if/for/while) not supported: ${node.type}`);
  }

  if (node.type === 'pipeline') {
    const commands = [];
    for (const child of node.namedChildren) {
      if (child.type === 'command' || child.type === 'redirected_statement') {
        commands.push(extractCommand(child, src));
      }
    }
    if (commands.length === 0) throw new ParseError('Empty pipeline');
    const result = commands[0];
    result.pipes = commands.slice(1);
    return result;
  }

  if (node.type === 'list') {
    const commands = [];
    for (const child of node.namedChildren) {
      if (child.type === 'command' || child.type === 'redirected_statement' || child.type === 'pipeline') {
        commands.push(extractStatement(child, src));
      }
    }
    if (commands.length === 0) throw new ParseError('Empty list');
    const result = commands[0];
    result.chained = commands.slice(1);
    return result;
  }

  return extractCommand(node, src);
}

/**
 * Parse a bash command string into the ParsedCommand shape that Rego
 * policies expect as `input.parsed`.
 *
 * Per the "not understood by the parser = not allowed" principle, any
 * command tree-sitter cannot fully parse (a syntax error, or a top-level
 * statement outside `program`'s direct children) raises ParseError rather
 * than silently passing through.
 */
async function parseCommand(command) {
  if (!command || !command.trim()) {
    throw new ParseError('Empty command');
  }

  const parser = await getParser();
  const tree = parser.parse(command);
  const root = tree.rootNode;

  if (root.hasError) {
    throw new ParseError('Syntax error - command could not be fully parsed');
  }

  if (root.childCount === 0) {
    throw new ParseError('No parseable command found');
  }

  // Top-level `;` is NOT wrapped in a `list` node by this grammar (only
  // `&&`/`||` are) - `program`'s direct named children are the individual
  // statements, chained left-to-right exactly like a bashlex "list".
  const statements = root.namedChildren.filter((n) => n.type !== 'comment');
  if (statements.length === 0) {
    throw new ParseError('No parseable command found');
  }

  const parsed = statements.map((n) => extractStatement(n, command));
  const result = parsed[0];
  result.chained = [...result.chained, ...parsed.slice(1)];
  return result;
}

module.exports = { parseCommand, ParseError };
