// Frozen answer key. The runner copies only sources.json entries into the agent workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const log = 'paivakirjat/Kide/2025-11.txt', receipt = 'kuitit/L-50.png';
const policy = 'kiertokirjeet/K-09.docx', tariff = 'liitteet/S-10.xlsx';
const relevant = new Set([log, receipt, policy, tariff]);
const key = {
  sinetti: ['152511-080', [log]], niteita: [37, [log]], ovi: ['PAJU 4', [receipt]],
  kolleja: [7, [receipt]], luokka: ['Suljettu odotus', [receipt, policy]],
  tunnit: [36, [policy]], lupa: ['konservaattori', [policy]],
  maksu: [78, [receipt, tariff]], toteutunut: [null, []],
};

assert.ok(process.argv.length > 2, 'Provide result directories');
for (const directory of process.argv.slice(2)) {
  for (const name of (await fs.readdir(directory)).filter(file => file.endsWith('.answer.md')).sort()) {
    const raw = await fs.readFile(path.join(directory, name), 'utf8');
    let answer;
    try { answer = JSON.parse(raw); } catch { /* Non-JSON responses fail the output contract. */ }
    const wrong = [], unsupported = [];
    for (const [field, [value, sources]] of Object.entries(key)) {
      const given = answer?.[field];
      if (given?.arvo !== value) wrong.push(field);
      if (!Array.isArray(given?.lahteet) || sources.some(source => !given.lahteet.includes(source)) || given.lahteet.some(source => !relevant.has(source))) unsupported.push(field);
    }
    const keysMatch = Object.keys(answer ?? {}).sort().join() === Object.keys(key).sort().join();
    console.log(JSON.stringify({ name, keysMatch, wrong, unsupported, exact: keysMatch && !wrong.length && !unsupported.length }));
  }
}
