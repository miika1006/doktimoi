#!/usr/bin/env node
/**
 * Claude Code SessionStart and PostToolUse hook for doktimoi.
 *
 * Refreshes an existing index in the background (async hook) when a session
 * starts in an indexed folder or Claude edits a file inside one, so searches
 * find the index already current. Never creates an index. Embeddings are left
 * to hybrid search: computing them here would hold the lock and stall lexical
 * searches for minutes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { indexedRoot, insideIndexData, isDirectory, resolvePath, runHook } from './common.mjs';

export function targetRoot(input) {
  if (input.hook_event_name === 'SessionStart') return input.cwd ? indexedRoot(resolvePath(input.cwd)) : null;
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return null;
  const resolved = resolvePath(file, input.cwd);
  const root = indexedRoot(path.dirname(resolved));
  return root && !insideIndexData(resolved, root) ? root : null;
}

/** Runs the incremental refresh, or does nothing until the skill's dependencies are installed. */
async function refresh(root, pluginRoot) {
  const skill = path.join(pluginRoot, 'skills', 'doktimoi');
  if (!isDirectory(path.join(skill, 'node_modules'))) return;
  const { openProject } = await import(pathToFileURL(path.join(skill, 'scripts', 'doktimoi.mjs')).href);
  const project = await openProject(root);
  try { await project.sync(); } finally { await project.close(); }
}

/**
 * Starts the folder's search server if none runs and asks it to load the embedding model in the
 * background, so the session's first hybrid search is fast. Failures are ignored: searches then
 * start the server or run in-process themselves.
 */
export async function warmServer(root, pluginRoot) {
  const scripts = path.join(pluginRoot, 'skills', 'doktimoi', 'scripts');
  if (!isDirectory(path.join(scripts, '..', 'node_modules'))) return;
  try {
    const { viaServer } = await import(pathToFileURL(path.join(scripts, 'server.mjs')).href);
    await viaServer(fs.realpathSync(root), fs.realpathSync(path.join(scripts, 'doktimoi.mjs')), { command: 'warm' });
  } catch { /* optional: the first search starts the server instead */ }
}

runHook(import.meta.url, 'doktimoi sync hook', async (input, pluginRoot) => {
  const root = targetRoot(input);
  if (!root) return;
  try { await refresh(root, pluginRoot); }
  finally { if (input.hook_event_name === 'SessionStart') await warmServer(root, pluginRoot); }
});
