import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../examples/', import.meta.url));
const sources = JSON.parse(await fs.readFile(path.join(root, 'sources.json'), 'utf8'));
for (const source of sources) {
  if (!/^[a-f0-9]{40}$/.test(source.gitBlob) || !/^[\w.-]+\/[\w.-]+$/.test(source.repository)
      || path.isAbsolute(source.local) || source.local.split(/[\\/]/).includes('..')) throw new Error('Invalid source manifest');
  const file = path.join(root, source.local);
  let data;
  if (process.argv.includes('--verify')) data = await fs.readFile(file);
  else {
    const response = await fetch(`https://api.github.com/repos/${source.repository}/git/blobs/${source.gitBlob}`);
    if (!response.ok) throw new Error(`${response.status}: ${source.local}`);
    const blob = await response.json();
    if (blob.encoding !== 'base64') throw new Error('Unexpected GitHub encoding');
    data = Buffer.from(blob.content, 'base64');
  }
  const digest = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (digest !== source.gitBlob) throw new Error(`Integrity failure: ${source.local}`);
  if (!process.argv.includes('--verify')) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  console.log(`${process.argv.includes('--verify') ? 'verified' : 'downloaded'} ${source.local}`);
}
