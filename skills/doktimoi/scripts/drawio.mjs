import { inflateRawSync } from 'node:zlib';
import Turndown from 'turndown';
import { xml, elements } from './office.mjs';

export function drawio(source, buffer) {
  const doc = xml(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  const root = doc.documentElement;
  if (!['mxfile', 'mxGraphModel'].includes(root.localName)) throw new Error('Expected draw.io mxfile or mxGraphModel');
  const pages = root.localName === 'mxGraphModel' ? [root] : elements(root, 'diagram');
  const converter = new Turndown();
  converter.addRule('label-formatting', { filter: ['b', 'strong', 'em', 'i', 'span'], replacement: content => content });
  const chunks = [], warnings = [];
  for (const [index, page] of pages.entries()) {
    let model = page.localName === 'mxGraphModel' ? page : elements(page, 'mxGraphModel')[0];
    if (!model) {
      const packed = page.textContent.trim();
      if (!packed) continue;
      const expanded = packed.startsWith('<') ? packed : decodeURIComponent(inflateRawSync(Buffer.from(packed, 'base64'), { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
      model = xml(expanded).documentElement;
      if (model.localName !== 'mxGraphModel') throw new Error('Invalid compressed draw.io page');
    }
    const label = (value, cell) => /(?:^|;)html=1(?:;|$)/.test(cell.getAttribute('style') || '') ? converter.turndown(value || '').trim() : value || '';
    const cells = elements(model, 'mxCell');
    const byId = new Map();
    const records = cells.map(cell => {
      const object = cell.parentNode.localName !== 'root' ? cell.parentNode : null;
      const id = cell.getAttribute('id') || object?.getAttribute('id');
      if (!id || byId.has(id)) throw new Error('Missing or duplicate draw.io cell ID');
      const text = label(object?.getAttribute('label') || cell.getAttribute('value'), cell);
      const record = { cell, object, id, text };
      byId.set(id, record); return record;
    });
    const pageName = page.getAttribute('name') || `Page ${index + 1}`;
    for (const { cell, object, id, text } of records) {
      const sourceId = cell.getAttribute('source'), targetId = cell.getAttribute('target');
      const edge = cell.getAttribute('edge') === '1';
      if (!text && !edge && cell.getAttribute('vertex') !== '1') continue;
      const endpoint = key => key ? `${key} ${JSON.stringify(byId.get(key)?.text ?? '[missing node]')}` : '[unconnected]';
      const properties = Array.from(object?.attributes ?? []).filter(a => !['id', 'label'].includes(a.name))
        .map(a => `${a.name}=${JSON.stringify(a.value)}`);
      const parent = cell.getAttribute('parent');
      let body = edge ? `edge ${id}: source=${endpoint(sourceId)}; target=${endpoint(targetId)}; label=${JSON.stringify(text)}` : `node ${id}: ${JSON.stringify(text)}`;
      if (parent && byId.get(parent)?.text) body += `; parent=${endpoint(parent)}`;
      const parentCell = byId.get(parent)?.cell;
      if (parentCell?.getAttribute('edge') === '1') body += `; on-edge=${parent}; source=${endpoint(parentCell.getAttribute('source'))}; target=${endpoint(parentCell.getAttribute('target'))}`;
      if (properties.length) body += '\n' + properties.join('; ');
      chunks.push({ source, location: `page:${index + 1}:cell:${encodeURIComponent(id)}`, heading: pageName, text: body });
      if (/image=|shape=image/.test(cell.getAttribute('style') || '')) warnings.push(`draw.io page ${index + 1}: image contents require visual inspection.`);
    }
  }
  warnings.push('draw.io: source/target are connector endpoints, not inferred flow direction; styles, arrows and geometry require the original diagram.');
  return { chunks, warnings: [...new Set(warnings)] };
}
