// Frozen answer key. The runner copies only sources.json entries into the agent workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const log = 'paivakirjat/Kide/2025-11.txt', receipt = 'kuitit/L-50.png';
const policy = 'kiertokirjeet/K-09.docx', tariff = 'liitteet/S-10.xlsx';
const receiptsTask = process.argv[2] === '--receipts';
const decemberLog = 'paivakirjat/Kide/2025-12.txt', decemberReceipt = 'kuitit/L-51.png';
const decemberPolicy = 'kiertokirjeet/K-12.docx', decemberTariff = 'liitteet/S-12.xlsx';
const key = receiptsTask ? {
  packages: [9, ['kuitit/L-49.png', receipt, decemberReceipt]], seal: ['152512-080', [decemberReceipt]],
  bay: ['KOIVU 6', [decemberReceipt]], shipped: ['2025-12-24', [decemberLog]],
  destination: ['Taika', [decemberLog]], titles: [59, [decemberLog]],
  disposition: ['Palautus', [decemberReceipt, decemberPolicy]], hours: [48, [decemberPolicy]],
  fee: [120, [decemberReceipt, decemberTariff]],
} : {
  sinetti: ['152511-080', [log]], niteita: [37, [log]], ovi: ['PAJU 4', [receipt]],
  kolleja: [7, [receipt]], luokka: ['Suljettu odotus', [receipt, policy]],
  tunnit: [36, [policy]], lupa: ['konservaattori', [policy]],
  maksu: [78, [receipt, tariff]], toteutunut: [null, []],
};

const relevant = new Set(Object.values(key).flatMap(([, sources]) => sources));
const directories = process.argv.slice(receiptsTask ? 3 : 2);
assert.ok(directories.length, 'Provide result directories');
for (const directory of directories) {
  for (const name of (await fs.readdir(directory)).filter(file => file.endsWith('.answer.md')).sort()) {
    const raw = await fs.readFile(path.join(directory, name), 'utf8');
    let answer;
    try { answer = JSON.parse(raw); } catch { /* Non-JSON responses fail the output contract. */ }
    const wrong = [], unsupported = [];
    for (const [field, [value, sources]] of Object.entries(key)) {
      const given = answer?.[field];
      const answerSources = given?.[receiptsTask ? 'sources' : 'lahteet'];
      if (given?.[receiptsTask ? 'value' : 'arvo'] !== value) wrong.push(field);
      if (!Array.isArray(answerSources) || sources.some(source => !answerSources.includes(source)) || answerSources.some(source => !relevant.has(source))) unsupported.push(field);
    }
    const keysMatch = Object.keys(answer ?? {}).sort().join() === Object.keys(key).sort().join();
    console.log(JSON.stringify({ name, keysMatch, wrong, unsupported, exact: keysMatch && !wrong.length && !unsupported.length }));
  }
}
