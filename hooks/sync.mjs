#!/usr/bin/env node
/**
 * Claude Code SessionStart and PostToolUse hook for doktimoi.
 *
 * Refreshes an existing index in the background (async hook) when a session
 * starts in an indexed folder or Claude edits a file inside one, so searches
 * find the index already current. Never creates an index and never enables
 * semantic search; existing embeddings are updated incrementally.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { indexedRoot, insideIndexData, isDirectory, readHookInput, resolvePath } from './common.mjs';

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
  try { await project.refresh(); } finally { await project.close(); }
}

async function main() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = targetRoot(await readHookInput());
  if (root) await refresh(root, pluginRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`doktimoi sync hook: ${error.message}`); process.exitCode = 1; });
}
