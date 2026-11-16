import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('answer checker accepts prose citations and still rejects missing sources and invalid ranges', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-answer-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../benchmarks/check-answers.mjs', import.meta.url));
  const source = 'concepts/workloads/pods/disruptions.md';
  const citations = [`\`docs/${source}\`, lines 99–136, 140–145`, `\`docs/${source}\`, line 99`, `${source}:99-136`, `${source}#L99-L136`];
  const answer = citation => Array.from({ length: 10 }, (_, i) => `${i + 1}. Evidence: ${citation(i)}`).join('\n');
  const check = async text => {
    await fs.writeFile(path.join(root, '1.answer.md'), text);
    return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  };
  const valid = await check(answer(i => citations[i % citations.length]));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).answers[0].checkedCitationRanges, 13);
  const qmd = await check(answer(() => `\`${source}\`, L99–136, L140–145`));
  assert.equal(qmd.status, 0, qmd.stderr);
  assert.equal(JSON.parse(qmd.stdout).answers[0].checkedCitationRanges, 20);
  const linked = await check(answer(() => `[source](docs/${source}), lines 99–136, 140–145`));
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(JSON.parse(linked.stdout).answers[0].checkedCitationRanges, 20);
  const invalidRange = await check(answer(() => `\`docs/${source}\`, lines 99–99999`));
  assert.notEqual(invalidRange.status, 0);
  assert.match(invalidRange.stderr, /invalid range/);
  const missing = await check(answer(() => '`docs/concepts/absent.md`, lines 1–2'));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT/);
  const noRanges = await check(answer(() => `\`docs/${source}\``));
  assert.notEqual(noRanges.status, 0);
  assert.match(noRanges.stderr, /missing numbered sections or source ranges/);
  // A file name or bare lines refer back to the latest matching full path.
  const short = await check(`Sources: \`${source}\`.\n` + answer(i => i % 2 ? '(`disruptions.md:99-136`)' : '(`:140-145`)'));
  assert.equal(short.status, 0, short.stderr);
  assert.equal(JSON.parse(short.stdout).answers[0].abbreviatedCitationRanges, 10);
  const shortInvalid = await check(`Sources: \`${source}\`.\n` + answer(() => '(`disruptions.md:99-99999`)'));
  assert.match(shortInvalid.stderr, /invalid range/);
});
