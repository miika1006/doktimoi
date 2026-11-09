import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, splitCommand } from '../hooks/pretooluse.mjs';
import { targetRoot } from '../hooks/sync.mjs';
import { openProject } from '../skills/doktimoi/scripts/doktimoi.mjs';

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

test('approves a single lexical search, read or status against an indexed folder', async t => {
  const { indexed } = await folders(t);
  assert.ok(allowed(decide(bash(`node "${script}" search "${indexed}" --query "XTX Identity" --query 'Entra vieras' --budget 1600`, indexed), pluginRoot)));
  assert.ok(allowed(decide(bash(`node "${script}" search . --query Entra --mode lexical --verify`, indexed), pluginRoot)));
  assert.ok(allowed(decide(bash(`node "${script}" read "${indexed}" "a.md:1-5" --from 1 --lines 40`, indexed), pluginRoot)));
  assert.ok(allowed(decide({ tool_name: 'PowerShell', tool_input: { command: `node "${script}" search "${indexed}" --query "ä ö"` }, cwd: indexed }, pluginRoot)));
  assert.ok(allowed(decide(bash(`node "${script}" search "${indexed}" --query "how is access granted" --mode hybrid`, indexed), pluginRoot)));
  assert.ok(allowed(decide(bash(`node "${script}" status "${indexed}"`, indexed), pluginRoot)));
  assert.ok(allowed(decide({ tool_name: 'PowerShell', tool_input: { command: `node "${script}" status .` }, cwd: indexed }, pluginRoot)));
});

test('approves the usage text without a folder and nothing more on the line', async t => {
  const { indexed } = await folders(t);
  for (const args of ['help', '--help', '-h', 'search --help', 'read -h', 'disable-semantic --help']) {
    assert.ok(allowed(decide(bash(`node "${script}" ${args}`, indexed), pluginRoot)), args);
  }
  assert.ok(allowed(decide({ tool_name: 'PowerShell', tool_input: { command: `node "${script}" help` }, cwd: indexed }, pluginRoot)));
  for (const args of ['help extra', 'help; rm -rf /', '--help && echo hi', 'serve --help', `search "${indexed}" --help`, 'help --unknown', '--help -h']) {
    assert.equal(decide(bash(`node "${script}" ${args}`, indexed), pluginRoot), null, args);
  }
  assert.equal(decide(bash(`node "${path.join(indexed, 'doktimoi.mjs')}" help`, indexed), pluginRoot), null);
});

test('accepts a literal ~ inside an unquoted word but not tilde expansion', async t => {
  const { indexed } = await folders(t);
  const short = path.join(indexed, 'RUNNER~1');
  await fs.mkdir(path.join(short, '.doktimoi'), { recursive: true });
  assert.ok(allowed(decide(bash(`node "${script}" search ${short.replaceAll('\\', '/')} --query x`, indexed), pluginRoot)));
  assert.equal(decide(bash(`node "${script}" search ~/docs --query x`, indexed), pluginRoot), null);
});

test('accepts the Git Bash form of Windows paths', { skip: process.platform !== 'win32' }, async t => {
  const { indexed } = await folders(t);
  const gitBash = p => p.replace(/^([a-zA-Z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replaceAll('\\', '/');
  assert.ok(allowed(decide(bash(`node ${gitBash(script)} search ${gitBash(indexed)} --query x`, indexed), pluginRoot)));
});

test('rewrites unquoted backslash paths that Git Bash would strip', { skip: process.platform !== 'win32' }, async t => {
  const { indexed } = await folders(t);
  const result = decide(bash(`node ${script} search ${indexed} --query "ä\\ö"`, indexed), pluginRoot);
  assert.ok(allowed(result));
  assert.equal(result.hookSpecificOutput.updatedInput.command, `node ${script.replaceAll('\\', '/')} search ${indexed.replaceAll('\\', '/')} --query "ä\\ö"`);
  assert.equal(decide(bash(`node "${script}" search "${indexed}" --query x`, indexed), pluginRoot).hookSpecificOutput.updatedInput, undefined);
  assert.equal(decide({ tool_name: 'PowerShell', tool_input: { command: `node ${script} search ${indexed} --query x` }, cwd: indexed }, pluginRoot).hookSpecificOutput.updatedInput, undefined);
});

test('leaves everything else to the normal permission flow', async t => {
  const { indexed, plain } = await folders(t);
  const rejected = [
    `node "${script}" search "${plain}" --query x`,
    `node "${script}" search "${path.join(indexed, 'sub')}" --query x`,
    `node "${script}" build "${indexed}"`,
    `node "${script}" embed "${indexed}"`,
    `node "${script}" search "${indexed}" --query x --mode semantic`,
    `node "${script}" sync "${indexed}"`,
    `node "${script}" disable-semantic "${indexed}"`,
    `node "${script}" stop "${indexed}"`,
    `node "${script}" status "${plain}"`,
    `node "${script}" status "${indexed}" extra`,
    `node "${script}" status "${indexed}" --mode lexical`,
    `node "${script}" status "${indexed}"; rm -rf /`,
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

test('reminds about doktimoi for recursive shell searches and whole reads of big or Office files', async t => {
  const { indexed, plain } = await folders(t);
  const reminded = output => /indexed by doktimoi/.test(output?.hookSpecificOutput?.additionalContext ?? '');
  for (const command of ['grep -rn "XTX" .', 'rg -i entra', 'git grep -n Identity', 'grep --recursive x docs', 'find . -name "*.md" | xargs grep x', 'findstr /s /i entra *.md', 'Get-ChildItem -Recurse *.md | Select-String XTX']) {
    assert.ok(reminded(decide(bash(command, path.join(indexed, 'sub')), pluginRoot)), command);
    assert.equal(decide(bash(command, plain), pluginRoot), null, command);
  }
  for (const command of ['grep -n "^#" a.md', 'git status', 'ls -la']) assert.equal(decide(bash(command, indexed), pluginRoot), null, command);
  const big = path.join(indexed, 'big.md');
  await fs.writeFile(big, 'x'.repeat(60_000));
  await fs.writeFile(path.join(indexed, 'guide.docx'), 'stub');
  const read = input => decide({ tool_name: 'Read', tool_input: input, cwd: plain }, pluginRoot);
  assert.ok(reminded(read({ file_path: big })));
  assert.ok(reminded(read({ file_path: path.join(indexed, 'guide.docx') })));
  assert.equal(read({ file_path: big, offset: 100, limit: 40 }), null);
  assert.equal(read({ file_path: path.join(indexed, '.doktimoi', 'manifest.json') }), null);
});

test('splitCommand keeps quoted words and refuses shell syntax', () => {
  assert.deepEqual(splitCommand(`node "C:\\x y\\d.mjs" search . --query 'a b'`), ['node', 'C:\\x y\\d.mjs', 'search', '.', '--query', 'a b']);
  for (const bad of ['a | b', 'a $HOME', 'a (b)', 'a *', '@args', 'a "unterminated']) assert.equal(splitCommand(bad), null, bad);
});

test('sync hook targets indexed folders only, outside the index data', async t => {
  const { indexed, plain } = await folders(t);
  const edit = (file, cwd = plain) => targetRoot({ hook_event_name: 'PostToolUse', tool_input: { file_path: file }, cwd });
  assert.equal(edit(path.join(indexed, 'sub', 'new.md')), await fs.realpath(indexed));
  assert.equal(edit('a.md', indexed), await fs.realpath(indexed));
  assert.equal(edit(path.join(indexed, '.doktimoi', 'manifest.json')), null);
  assert.equal(edit(path.join(plain, 'x.md')), null);
  assert.equal(targetRoot({ hook_event_name: 'PostToolUse', tool_input: { notebook_path: path.join(indexed, 'n.ipynb') }, cwd: plain }), await fs.realpath(indexed));
  assert.equal(targetRoot({ hook_event_name: 'SessionStart', cwd: path.join(indexed, 'sub') }), await fs.realpath(indexed));
  assert.equal(targetRoot({ hook_event_name: 'SessionStart', cwd: plain }), null);
});

test('sync hook refreshes an edited index so the next search has nothing to update', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rules.md');
  await fs.writeFile(file, '# Access\n\nProduction requires TLS.');
  let project = await openProject(root);
  await project.search(['TLS']);
  await project.close();
  await fs.writeFile(file, '# Access\n\nProduction requires mutual TLS and audited ROTATION.');
  execFileSync(process.execPath, [path.join(pluginRoot, 'hooks', 'sync.mjs')], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: root }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: 'utf8',
  });
  project = await openProject(root);
  try {
    assert.equal((await project.sync()).changed, 0);
    assert.match((await project.search(['ROTATION'])).payload.results[0].text, /audited ROTATION/);
  } finally { await project.close(); }
});

test('hook process prints the decision as JSON and nothing for other tools', async t => {
  const { indexed } = await folders(t);
  const run = input => execFileSync(process.execPath, [path.join(pluginRoot, 'hooks', 'pretooluse.mjs')], {
    input: JSON.stringify(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: 'utf8',
  });
  assert.ok(allowed(JSON.parse(run(bash(`node "${script}" search "${indexed}" --query x`, indexed)))));
  assert.equal(run({ tool_name: 'Edit', tool_input: {}, cwd: indexed }), '');
});
