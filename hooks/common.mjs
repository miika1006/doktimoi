/**
 * Shared path helpers for doktimoi's Claude Code hooks.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Walks up from a folder to the nearest one holding a `.doktimoi` index; `exact` checks only the folder itself. */
export function indexedRoot(folder, exact = false) {
  for (let current = folder; ; current = path.dirname(current)) {
    if (isDirectory(path.join(current, INDEX_DIR))) return current;
    if (exact || path.dirname(current) === current) return null;
  }
}

/**
 * Resolves a path given in Git Bash (`/c/...`) or Windows form against a working
 * directory and expands Windows 8.3 short names when the path exists.
 * @example resolvePath('/c/Users/RUNNER~1/docs', 'D:/a') // 'C:\\Users\\runneradmin\\docs'
 */
export function resolvePath(value, cwd) {
  const native = process.platform === 'win32' ? String(value).replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : String(value);
  const resolved = path.resolve(cwd ?? process.cwd(), native);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/** Tells whether the path is inside the index's own machine data. */
export function insideIndexData(file, root) {
  const relative = path.relative(path.join(root, INDEX_DIR), file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Reads and parses the hook's JSON input from stdin. */
export async function readHookInput() {
  let raw = '';
  for await (const part of process.stdin) raw += part;
  return JSON.parse(raw);
}

export function isDirectory(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

const INDEX_DIR = '.doktimoi';
