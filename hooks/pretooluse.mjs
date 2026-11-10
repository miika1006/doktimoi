#!/usr/bin/env node
/**
 * Shared Claude Code / Codex retrieval and session reminder hook.
 *
 * Auto-approves doktimoi's usage text (`help`, `--help`) and its own `search`/inline `batch` (also exact mode and
 * several questions with --next), `read` (1-20 references) and `status` commands on an already
 * indexed folder or a path inside one, so retrieval never stalls on a permission prompt and silently falls back to Grep. Hybrid mode is included: it only updates existing
 * embeddings and refuses to run when no semantic index was enabled. Adds a
 * doktimoi reminder to content lookups that bypass it inside an indexed folder:
 * folder-wide Grep, recursive shell searches and whole reads of large or Office/PDF
 * files. Everything else passes through untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { indexedRoot, insideIndexData, isFile, resolvePath, runHook } from './common.mjs';

export function decide(input, pluginRoot) {
  if (['SessionStart', 'SubagentStart'].includes(input.hook_event_name)) {
    const reminder = input.cwd && remind(indexedRoot(resolvePath(input.cwd)), pluginRoot, 'folder-wide searches');
    return reminder ? { hookSpecificOutput: { ...reminder.hookSpecificOutput, hookEventName: input.hook_event_name } } : null;
  }
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') {
    return approveDoktimoiCommand(input, pluginRoot) ?? remindOnShellSearch(input, pluginRoot);
  }
  if (input.tool_name === 'Grep') return remindOnFolderGrep(input, pluginRoot);
  if (input.tool_name === 'Read') return remindOnWholeRead(input, pluginRoot);
  return null;
}

/**
 * Returns an allow decision when the command is a single safe doktimoi help, search, read or status.
 * In Git Bash it also rewrites unquoted Windows paths, whose backslashes Bash would
 * strip (C:\Users -> C:Users), so the approved command does not fail with MODULE_NOT_FOUND.
 */
function approveDoktimoiCommand(input, pluginRoot) {
  const original = String(input.tool_input?.command ?? '').trim();
  const line = input.tool_name === 'Bash' && process.platform === 'win32' ? slashUnquotedPaths(original) : original;
  const words = splitCommand(line);
  if (!words || words.length < 3) return null;
  if (!/^node(\.exe)?$/i.test(words[0]) && !(path.isAbsolute(words[0]) && samePath(words[0], process.execPath, input.cwd))) return null;
  if (!samePath(words[1], scriptPath(pluginRoot), input.cwd)) return null;
  const updated = line === original ? {} : { updatedInput: { ...input.tool_input, command: line } };
  if (isHelp(words.slice(2))) return output({ permissionDecision: 'allow', permissionDecisionReason: 'doktimoi usage text', ...updated });
  if (words.length < 4) return null;
  const [, , command, root, ...rest] = words;
  if (!['search', 'batch', 'read', 'status'].includes(command)) return null;
  if (command === 'status' && rest.length) return null;
  const options = parseOptions(rest);
  if (!options || !['lexical', 'hybrid', 'exact'].includes(options.values.mode)) return null;
  const references = options.positionals.length;
  if (command === 'read' ? references < 1 || references > MAX_REFS : references) return null;
  if (options.values.requests !== undefined) {
    if (command !== 'batch') return null;
    try {
      const requests = JSON.parse(options.values.requests);
      if (!Array.isArray(requests) || !requests.length || requests.length > 20 || requests.some(request =>
        !request || typeof request !== 'object' || !Array.isArray(request.queries) ||
        Object.keys(request).some(key => !['queries', 'paths', 'exclude', 'mode', 'limit', 'brief', 'budget', 'verify'].includes(key)) ||
        !['lexical', 'hybrid', 'exact'].includes(request.mode ?? 'lexical'))) return null;
    } catch { return null; }
  } else if (command === 'batch') return null;
  // A path inside an indexed folder uses that folder's index; the CLI never creates one outside build.
  if (!indexedRoot(resolvePath(root, input.cwd))) return null;
  return output({ permissionDecision: 'allow', permissionDecisionReason: `doktimoi read-only ${command} in an indexed folder`, ...updated });
}

/**
 * Replaces backslashes in unquoted words with forward slashes; quoted parts stay as written.
 * @example slashUnquotedPaths('node C:\\a\\d.mjs search "C:\\b"') // 'node C:/a/d.mjs search "C:\\b"'
 */
export function slashUnquotedPaths(command) {
  return command.replace(/"[^"]*"|'[^']*'|[^"']+/g, part => /^["']/.test(part) ? part : part.replace(/\\/g, '/'));
}

/** Returns a reminder when Grep searches a folder (not a single file) inside a doktimoi index. */
function remindOnFolderGrep(input, pluginRoot) {
  const target = resolvePath(input.tool_input?.path ?? input.cwd ?? '.', input.cwd);
  if (isFile(target)) return null;
  return remind(indexedRoot(target), pluginRoot, 'Grep');
}

/** Returns a reminder when a shell command searches file contents recursively from inside an indexed folder. */
function remindOnShellSearch(input, pluginRoot) {
  if (!SHELL_SEARCH.test(String(input.tool_input?.command ?? ''))) return null;
  return remind(input.cwd ? indexedRoot(resolvePath(input.cwd)) : null, pluginRoot, 'shell searches');
}

/** Returns a reminder when Read loads a whole large or Office/PDF source file of an indexed folder. */
function remindOnWholeRead(input, pluginRoot) {
  const { file_path: file, offset, limit } = input.tool_input ?? {};
  if (!file || offset !== undefined || limit !== undefined) return null;
  const resolved = resolvePath(file, input.cwd);
  const root = indexedRoot(path.dirname(resolved));
  if (!root || insideIndexData(resolved, root)) return null;
  const size = (() => { try { return fs.statSync(resolved).size; } catch { return 0; } })();
  return size > LARGE_FILE_BYTES || DOCUMENT_FILE.test(resolved) ? remind(root, pluginRoot, 'whole-file reads') : null;
}

function remind(root, pluginRoot, bypass) {
  if (!root) return null;
  return output({ additionalContext: `${root} is indexed by doktimoi. For content lookups, fact checks and verification while editing here use the doktimoi skill instead of ${bypass}: node "${scriptPath(pluginRoot)}" search "${root}" --query "terms" for cited passages. Batch independent questions with --next; read only unresolved evidence, several references per call. Use --brief to locate sections and --mode exact for literal phrases. Run each call as one command without cd or chaining. Use Grep only for file names or exact edit locations in a file doktimoi returned.` });
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

/**
 * Tells whether the script arguments only ask for the usage text, which touches no folder.
 * @example isHelp(['search', '--help']) // true
 */
function isHelp(args) {
  const [first, second] = args;
  if (args.length === 1) return ['help', '--help', '-h'].includes(first);
  return args.length === 2 && CLI_COMMANDS.includes(first) && ['--help', '-h'].includes(second);
}

/** Parses doktimoi CLI options strictly; unknown options make the command ineligible. */
function parseOptions(args) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: {
      query: { type: 'string', multiple: true }, mode: { type: 'string', default: 'lexical' }, next: { type: 'boolean', multiple: true },
      requests: { type: 'string' },
      path: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
      budget: { type: 'string' }, limit: { type: 'string' }, from: { type: 'string' }, lines: { type: 'string' },
      verify: { type: 'boolean' }, brief: { type: 'boolean' },
    } });
  } catch { return null; }
}

function samePath(value, expected, cwd) {
  const normalize = p => { const r = path.normalize(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return normalize(resolvePath(value, cwd)) === normalize(resolvePath(expected));
}

function scriptPath(pluginRoot) { return path.join(pluginRoot, 'skills', 'doktimoi', 'scripts', 'doktimoi.mjs'); }

function output(fields) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }; }

const SHELL_SEARCH = /\b(rg|ag|ack)\s|\bgit\s+grep\b|\bgrep\b[^|;&\n]*\s(-\w*[rR]\w*|--recursive)\b|\b(xargs\s+|-exec\s+)grep\b|\bfindstr\b[^|;&\n]*\/s\b|\b(Get-ChildItem|gci|dir|ls)\b[^;\n]*\|\s*(Select-String|sls)\b/i;
const CLI_COMMANDS = ['search', 'read', 'batch', 'status', 'build', 'sync', 'embed', 'stop', 'disable-semantic'];
const MAX_REFS = 20;
const DOCUMENT_FILE = /\.(pdf|docx?|xlsx?|pptx?)$/i;
const LARGE_FILE_BYTES = 50_000;

runHook(import.meta.url, 'doktimoi hook', (input, pluginRoot) => {
  const result = decide(input, pluginRoot);
  if (result) process.stdout.write(JSON.stringify(result));
});
