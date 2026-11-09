import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, splitCommand } from '../hooks/pretooluse.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(pluginRoot, 'skills', 'doktimoi', 'scripts', 'doktimoi.mjs');

async function folders(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-hook-'));
  const indexed = path.join(base, 'docs');
  const plain = path.join(base, 'plain');
  await fs.mkdir(path.join(indexed, '.doktimoi'), { recursive: true });
  await fs.mkdir(path.join(indexed, 'sub'), { recursive: true });
  await fs.mkdir(plain);
  await fs.writeFile(path.join(indexed, 'a.md'), '# A');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { indexed, plain };
}

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const allowed = output => output?.hookSpecificOutput?.permissionDecision === 'allow';

test('approves a single lexical search or read against an indexed folder', async t => {
  const { indexed } = await folders(t);
  assert.ok(allowed(decide(bash(`node "${script}" search "${indexed}" --query "XTX Identity" --query 'Entra vieras' --budget 1600`, indexed), pluginRoot)));
  assert.ok(allowed(decide(bash(`node "${script}" search . --query Entra --mode lexical --verify`, indexed), pluginRoot)));
  assert.ok(allowed(decide(bash(`node "${script}" read "${indexed}" "a.md:1-5" --from 1 --lines 40`, indexed), pluginRoot)));
  assert.ok(allowed(decide({ tool_name: 'PowerShell', tool_input: { command: `node "${script}" search "${indexed}" --query "ä ö"` }, cwd: indexed }, pluginRoot)));
});

test('accepts the Git Bash form of Windows paths', { skip: process.platform !== 'win32' }, async t => {
  const { indexed } = await folders(t);
  const gitBash = p => p.replace(/^([a-zA-Z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replaceAll('\\', '/');
  assert.ok(allowed(decide(bash(`node ${gitBash(script)} search ${gitBash(indexed)} --query x`, indexed), pluginRoot)));
});

test('leaves everything else to the normal permission flow', async t => {
  const { indexed, plain } = await folders(t);
  const rejected = [
    `node "${script}" search "${plain}" --query x`,
    `node "${script}" search "${path.join(indexed, 'sub')}" --query x`,
    `node "${script}" build "${indexed}"`,
    `node "${script}" embed "${indexed}"`,
    `node "${script}" search "${indexed}" --query x --mode hybrid`,
    `node "${script}" search "${indexed}" --query x --unknown`,
    `node "${script}" search "${indexed}" --query x; rm -rf /`,
    `node "${script}" search "${indexed}" --query "$(whoami)"`,
    `node "${script}" search "${indexed}" --query x && echo hi`,
    `node "${script}" search "${indexed}" --query x > out.txt`,
    `node "${script}" search "${indexed}" --query \`id\``,
    `node "${script}" search "${indexed}" --query "a\\" b"`,
    `cd "${indexed}"; node "${script}" search . --query x`,
    `node "${path.join(indexed, 'doktimoi.mjs')}" search "${indexed}" --query x`,
    `node "${script}" search "${indexed}" --query x\nrm a`,
  ];
  for (const command of rejected) assert.equal(decide(bash(command, indexed), pluginRoot), null, command);
});

test('reminds about doktimoi when Grep sweeps an indexed folder, not a single file', async t => {
  const { indexed, plain } = await folders(t);
  const grep = (p, cwd) => decide({ tool_name: 'Grep', tool_input: { pattern: 'x', ...(p ? { path: p } : {}) }, cwd }, pluginRoot);
  assert.match(grep(indexed, plain).hookSpecificOutput.additionalContext, /indexed by doktimoi/);
  assert.match(grep(undefined, path.join(indexed, 'sub')).hookSpecificOutput.additionalContext, /search/);
  assert.equal(grep(path.join(indexed, 'a.md'), indexed), null);
  assert.equal(grep(plain, plain), null);
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: path.join(indexed, 'a.md') }, cwd: indexed }, pluginRoot), null);
});

test('splitCommand keeps quoted words and refuses shell syntax', () => {
  assert.deepEqual(splitCommand(`node "C:\\x y\\d.mjs" search . --query 'a b'`), ['node', 'C:\\x y\\d.mjs', 'search', '.', '--query', 'a b']);
  for (const bad of ['a | b', 'a $HOME', 'a (b)', 'a *', '@args', 'a "unterminated']) assert.equal(splitCommand(bad), null, bad);
});

test('hook process prints the decision as JSON and nothing for other tools', async t => {
  const { indexed } = await folders(t);
  const run = input => execFileSync(process.execPath, [path.join(pluginRoot, 'hooks', 'pretooluse.mjs')], {
    input: JSON.stringify(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: 'utf8',
  });
  assert.ok(allowed(JSON.parse(run(bash(`node "${script}" search "${indexed}" --query x`, indexed)))));
  assert.equal(run({ tool_name: 'Edit', tool_input: {}, cwd: indexed }), '');
});
