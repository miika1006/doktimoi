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
    const text = await fs.readFile(path.join(directory, file), 'utf8');
    const sections = [...text.matchAll(/^\s*(?:#{1,3}\s*|\*\*)?(\d+)\.\s/gm)].map(match => Number(match[1]));
    const citations = [];
    for (const match of text.matchAll(/((?:concepts|tasks|reference)\/[^\s`:)]+\.md)(?::|#L)(\d+(?:[-–](?:L)?\d+)?(?:,\s*\d+(?:[-–](?:L)?\d+)?)*)/g)) {
      const source = path.resolve(corpus, match[1]);
      assert.ok(source.startsWith(corpus), 'Citation must stay inside corpus');
      const lines = (await fs.readFile(source, 'utf8')).split('\n').length;
      for (const range of match[2].split(/,\s*/)) {
        const [first, last = first] = range.split(/[-–]L?/).map(Number);
        assert.ok(first >= 1 && last >= first && last <= lines, `${file}: invalid range ${match[0]}`);
        citations.push({ source: match[1], first, last });
      }
    }
    const words = text.trim().split(/\s+/).length;
    const complete = Array.from({ length: 10 }, (_, i) => i + 1).every(number => sections.includes(number));
    reports.push({ file: path.join(directory, file), words, tenSections: complete,
      withinWordTarget: words >= 900 && words <= 1400, checkedCitationRanges: citations.length, allRangesValid: true });
    assert.ok(complete && citations.length >= 10, `${file}: missing numbered sections or source ranges`);
  }
}
console.log(JSON.stringify({ method: 'Whitespace word count; named colon/#L citation ranges; range existence is not claim support.', answers: reports }, null, 2));
