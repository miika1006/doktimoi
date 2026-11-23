// Fixed paraphrases. Score the visible passage, including the applicable document edition.
import assert from 'node:assert/strict';
import path from 'node:path';
import { openProject, reference } from '../../skills/doktimoi/scripts/doktimoi.mjs';

const [root, mode] = process.argv.slice(2);
assert.ok(root && ['lexical', 'auto', 'hybrid'].includes(mode), 'Pass an indexed corpus root and lexical, auto or hybrid');
const queries = [
  ['fi', 'Montako tallennetta Harmaahaikara-erään pakattiin?', 'paivakirjat/Kide/2025-11.txt', 'Niteitä 37'],
  ['fi', '152511-080', 'kuitit/L-50.png', 'PAJU 4'],
  ['fi', 'Kuka saa antaa märälle erälle luovutusluvan marraskuussa?', 'kiertokirjeet/K-09.docx', '36 tunnin'],
  ['fi', 'Mikä on marraskuun enimmäisveloitus yhdestä lähetyksestä?', 'liitteet/S-10.xlsx', '78'],
  ['en', 'How many recordings were in the Harmaahaikara delivery?', 'paivakirjat/Kide/2025-11.txt', 'Niteitä 37'],
  ['en', 'Which unloading door was used for seal 152511-080?', 'kuitit/L-50.png', 'PAJU 4'],
  ['en', 'Who can authorize release of moisture-exposed goods in November?', 'kiertokirjeet/K-09.docx', '36 tunnin'],
  ['en', 'What is the maximum handling charge for one affected shipment in November?', 'liitteet/S-10.xlsx', '78'],
];
const project = await openProject(path.resolve(root));
try {
  const rows = [];
  for (const [language, query, source, expected] of queries) {
    const { payload, metrics } = await project.search([query], { mode, limit: 4, budget: 1600 });
    const hit = payload.results.findIndex(item => item.source === source && item.text.includes(expected));
    rows.push({ language, query, source, expected, rank: hit < 0 ? null : hit + 1,
      returned: payload.results.map(reference), tokens: metrics.resultTokens, ms: metrics.searchMs });
  }
  console.log(JSON.stringify({ mode, rows }, null, 2));
} finally { await project.close(); }
