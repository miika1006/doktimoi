#!/usr/bin/env node
// Mechanical citation/structure checks complement, but cannot replace, claim review.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const corpus = fileURLToPath(new URL('../examples/kubernetes/docs/', import.meta.url));
const directories = process.argv.slice(2);
assert.ok(directories.length, 'Provide result directories containing *.answer.md');
const reports = [];
for (const directory of directories) {
  for (const file of (await fs.readdir(directory)).filter(name => name.endsWith('.answer.md')).sort()) {
    try {
      reports.push(await check(directory, file));
    } catch (error) {
      reports.push({ file: path.join(directory, file), error: error.message });
      console.error(`${file}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
console.log(JSON.stringify({ method: 'Whitespace word count; named colon/#L/prose citation ranges, plus abbreviated file-name or bare-line ranges resolved to earlier full paths; range existence is not claim support.', answers: reports }, null, 2));

async function check(directory, file) {
  const text = await fs.readFile(path.join(directory, file), 'utf8');
  const sections = [...text.matchAll(/^\s*(?:#{1,3}\s*|\*\*)?(\d+)\.\s/gm)].map(match => Number(match[1]));
  const citations = [], abbreviated = [];
  /** Checks that every range of a citation exists in its corpus source and records it. */
  const record = async (list, source, ranges, quoted) => {
    const resolved = path.resolve(corpus, source);
    assert.ok(resolved.startsWith(corpus), 'Citation must stay inside corpus');
    const lines = (await fs.readFile(resolved, 'utf8')).split('\n').length;
    for (const range of ranges.split(/,\s*/)) {
      const [first, last = first] = range.replace(/^L/, '').split(/[-–]L?/).map(Number);
      assert.ok(first >= 1 && last >= first && last <= lines, `${file}: invalid range ${quoted}`);
      list.push({ source, first, last });
    }
  };
  for (const match of text.matchAll(/((?:concepts|tasks|reference|tutorials|setup)\/[\w./-]+\.md)(?::|#L|[`)]?,\s+(?:lines?\s+|L))(\d+(?:[-–](?:L)?\d+)?(?:,\s*L?\d+(?:[-–](?:L)?\d+)?)*)/g)) {
    await record(citations, match[1], match[2], match[0]);
  }
  const definitions = new Map([...text.matchAll(/^\[([^\]]+)\]:\s+(?:.*?\/docs\/|docs\/)?((?:concepts|tasks|reference|tutorials|setup)\/[^\s#]+\.md)\s*$/gm)]
    .map(match => [match[1].toLowerCase(), match[2]]));
  for (const match of text.matchAll(/\[[^\]\n]*?:(\d+(?:[-–]\d+)?(?:,\s*\d+(?:[-–]\d+)?)*)\]\[([^\]]+)\]/g)) {
    const source = definitions.get(match[2].toLowerCase());
    assert.ok(source, `Missing citation definition: ${match[2]}`);
    await record(citations, source, match[1], match[0]);
  }
  // Abbreviated references name only a file (`deployment.md:12-20`) or only lines (`:12-20`). A file
  // name resolves to the latest full corpus path with that name; bare lines, which are ambiguous,
  // to the latest file mentioned before them in which every range exists.
  const mentioned = [];
  const RANGES = '(\\d+(?:[-–]\\d+)?(?:,\\s*:?\\d+(?:[-–]\\d+)?)*)';
  const fits = async (source, ranges) => {
    const lines = (await fs.readFile(path.resolve(corpus, source), 'utf8')).split('\n').length;
    return ranges.split(/,\s*/).every(range => Math.max(...range.split(/[-–]/).map(Number)) <= lines);
  };
  for (const match of text.matchAll(new RegExp(`((?:concepts|tasks|reference)\\/[\\w./-]+\\.md)|(?<![\\w/.-])([\\w.-]+\\.md):${RANGES}|[\`(]:${RANGES}`, 'g'))) {
    if (match[1]) { mentioned.push(match[1]); continue; }
    const ranges = (match[3] ?? match[4]).replace(/:/g, '');
    let source = match[2] && mentioned.findLast(name => path.posix.basename(name) === match[2]);
    if (!match[2]) {
      for (const name of [...new Set(mentioned)].reverse()) if (!source && await fits(name, ranges)) source = name;
      source ??= mentioned.at(-1);
    }
    if (!source) continue;
    await record(abbreviated, source, ranges, match[0]);
    mentioned.push(source);
  }
  const words = text.trim().split(/\s+/).length;
  const complete = Array.from({ length: 10 }, (_, i) => i + 1).every(number => sections.includes(number));
  assert.ok(complete && citations.length + abbreviated.length >= 10, `${file}: missing numbered sections or source ranges`);
  return { file: path.join(directory, file), words, tenSections: complete,
    withinWordTarget: words >= 900 && words <= 1400, checkedCitationRanges: citations.length,
    abbreviatedCitationRanges: abbreviated.length, allRangesValid: true };
}
