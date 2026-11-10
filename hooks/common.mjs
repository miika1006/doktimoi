/**
 * Shared path helpers for doktimoi's Claude Code hooks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from a folder to the nearest one holding a `.doktimoi` index; `exact` checks only the folder itself. */
export function indexedRoot(folder, exact = false) {
  for (let current = folder; ; current = path.dirname(current)) {
    if (isDirectory(path.join(current, INDEX_DIR))) return current;
    if (exact || path.dirname(current) === current) return null;
  }
}

/**
 * Resolves a path given in Git Bash (`/c/...`) or Windows form against a working
 * directory into canonical form. The nearest existing ancestor is resolved, so a
 * not-yet-existing file under a Windows 8.3 short name (RUNNER~1) still compares
 * equal to its canonical folder.
 * @example resolvePath('/c/Users/RUNNER~1/docs/new.md', 'D:/a') // 'C:\Users\runneradmin\docs\new.md'
 */
export function resolvePath(value, cwd) {
  const native = process.platform === 'win32' ? String(value).replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : String(value);
  const resolved = path.resolve(cwd ?? process.cwd(), native);
  for (let existing = resolved; ; existing = path.dirname(existing)) {
    try { return path.join(fs.realpathSync.native(existing), path.relative(existing, resolved)); }
    catch { if (path.dirname(existing) === existing) return resolved; }
  }
}

/** Tells whether the path is inside the index's own machine data. */
export function insideIndexData(file, root) {
  const relative = path.relative(path.join(root, INDEX_DIR), file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** When `url` is the entry script, calls `handler(input, pluginRoot)` with the hook's JSON stdin. */
export async function runHook(url, name, handler) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(url)) return;
  try {
    let raw = '';
    for await (const part of process.stdin) raw += part;
    await handler(JSON.parse(raw), process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (error) { console.error(`${name}: ${error.message}`); process.exitCode = 1; }
}

export function isDirectory(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

const INDEX_DIR = '.doktimoi';
