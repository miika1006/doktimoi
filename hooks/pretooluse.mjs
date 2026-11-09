#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for doktimoi.
 *
 * Auto-approves doktimoi's own `search` and `read` commands against an already
 * indexed folder, so retrieval never stalls on a permission prompt and silently
 * falls back to Grep. Hybrid mode is included: it only updates existing
 * embeddings and refuses to run when no semantic index was enabled. Adds a
 * reminder to Grep calls that sweep an indexed folder. Everything else passes
 * through untouched.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { indexedRoot, isFile, resolvePath, runHook } from './common.mjs';

export function decide(input, pluginRoot) {
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') return approveDoktimoiCommand(input, pluginRoot);
  if (input.tool_name === 'Grep') return remindOnFolderGrep(input, pluginRoot);
  return null;
}

/** Returns an allow decision when the command is a single safe doktimoi search/read. */
function approveDoktimoiCommand(input, pluginRoot) {
  const words = splitCommand(String(input.tool_input?.command ?? '').trim());
  if (!words || words.length < 4 || !/^node(\.exe)?$/i.test(words[0])) return null;
  if (!samePath(words[1], scriptPath(pluginRoot), input.cwd)) return null;
  const [, , command, root, ...rest] = words;
  if (!['search', 'read'].includes(command)) return null;
  const options = parseOptions(rest);
  if (!options || !['lexical', 'hybrid'].includes(options.values.mode)) return null;
  if (options.positionals.length !== (command === 'read' ? 1 : 0)) return null;
  if (!indexedRoot(resolvePath(root, input.cwd), true)) return null;
  return output({ permissionDecision: 'allow', permissionDecisionReason: `doktimoi read-only ${command} in an indexed folder` });
}

/** Returns a reminder when Grep searches a folder (not a single file) inside a doktimoi index. */
function remindOnFolderGrep(input, pluginRoot) {
  const target = resolvePath(input.tool_input?.path ?? input.cwd ?? '.', input.cwd);
  if (isFile(target)) return null;
  const root = indexedRoot(target);
  if (!root) return null;
  return output({ additionalContext: `${root} is indexed by doktimoi. For content lookups and fact checks here use the doktimoi skill instead of Grep, as one command without cd or chaining so it runs without a permission prompt: node "${scriptPath(pluginRoot)}" search "${root}" --query "terms" (add --mode hybrid if semantic search is enabled). Use Grep only for file names or exact edit locations in a file doktimoi returned.` });
}

/**
 * Splits a command into words with single/double quotes, or returns null when it
 * contains anything a shell could expand, chain or redirect.
 * @example splitCommand('node "C:\\x\\d.mjs" search . --query "a b"') // ['node', 'C:\\x\\d.mjs', 'search', '.', '--query', 'a b']
 */
export function splitCommand(command) {
  if (!command || /[\r\n$`;&|<>]/.test(command) || command.includes('\\"')) return null;
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|([A-Za-z0-9_\-.\/:\\=,+~]+)|(\s+)|(.)/g;
  let word = null;
  for (const match of command.matchAll(pattern)) {
    if (match[5] !== undefined) return null;
    if (match[4] !== undefined) { if (word !== null) words.push(word); word = null; continue; }
    // A leading unquoted ~ is tilde expansion in Bash; inside a word (RUNNER~1) it is literal.
    if (match[3] !== undefined && word === null && match[3].startsWith('~')) return null;
    word = (word ?? '') + (match[1] ?? match[2] ?? match[3]);
  }
  if (word !== null) words.push(word);
  return words;
}

/** Parses doktimoi CLI options strictly; unknown options make the command ineligible. */
function parseOptions(args) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: {
      query: { type: 'string', multiple: true }, mode: { type: 'string', default: 'lexical' },
      budget: { type: 'string' }, limit: { type: 'string' }, from: { type: 'string' }, lines: { type: 'string' },
      verify: { type: 'boolean' },
    } });
  } catch { return null; }
}

function samePath(value, expected, cwd) {
  const normalize = p => { const r = path.normalize(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return normalize(resolvePath(value, cwd)) === normalize(resolvePath(expected));
}

function scriptPath(pluginRoot) { return path.join(pluginRoot, 'skills', 'doktimoi', 'scripts', 'doktimoi.mjs'); }

function output(fields) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }; }

runHook(import.meta.url, 'doktimoi hook', (input, pluginRoot) => {
  const result = decide(input, pluginRoot);
  if (result) process.stdout.write(JSON.stringify(result));
});
