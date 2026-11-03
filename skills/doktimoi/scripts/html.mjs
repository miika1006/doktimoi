import Turndown from 'turndown';

// Parse static HTML without running scripts or loading linked resources.
export function html(buffer) {
  const converter = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.remove(['script', 'style', 'template']);
  converter.addRule('title', { filter: 'title', replacement: content => `\n\n# ${content}\n\n` });
  converter.addRule('deleted', { filter: ['del', 's', 'strike'], replacement: content => `~~${content}~~` });
  converter.addRule('script-position', {
    filter: ['sup', 'sub'],
    replacement: (content, node) => `<${node.nodeName.toLowerCase()}>${content}</${node.nodeName.toLowerCase()}>`,
  });
  converter.addRule('math', { filter: 'math', replacement: (_, node) => node.outerHTML });
  const ordinals = new WeakMap();
  const integer = value => /^[+-]?\d+$/.test(value?.trim() || '') ? BigInt(value.trim()) : null;
  converter.addRule('ordered-item', {
    filter: node => node.nodeName === 'LI' && node.parentNode.nodeName === 'OL',
    replacement: (content, node) => {
      if (!ordinals.has(node)) {
        const list = node.parentNode, items = Array.from(list.children).filter(child => child.nodeName === 'LI');
        const step = list.hasAttribute('reversed') ? -1n : 1n;
        let number = integer(list.getAttribute('start')) ?? (step < 0n ? BigInt(items.length) : 1n);
        for (const item of items) {
          number = integer(item.getAttribute('value')) ?? number;
          ordinals.set(item, number); number += step;
        }
      }
      const prefix = `${ordinals.get(node)}. `;
      return prefix + content.replace(/^\n+|\n+$/g, '').replace(/\n/g, '\n' + ' '.repeat(prefix.length)) + '\n';
    },
  });
  converter.addRule('checkbox', {
    filter: node => node.nodeName === 'INPUT' && node.type === 'checkbox',
    replacement: (_, node) => node.hasAttribute('checked') ? '[x] ' : '[ ] ',
  });
  // HTML tables need not have headers; keep cell boundaries and merged-cell metadata.
  converter.addRule('cell', {
    filter: ['td', 'th'],
    replacement: (content, node) => {
      const spans = ['rowspan', 'colspan'].filter(key => node.hasAttribute(key))
        .map(key => `${key}=${node.getAttribute(key)}`).join(' ');
      return ` ${node.nodeName === 'TH' ? 'header' : 'cell'}${spans ? `(${spans})` : ''}=${JSON.stringify(content.trim())}`;
    },
  });
  converter.addRule('row', { filter: 'tr', replacement: content => `\nrow:${content}\n` });
  converter.addRule('table-section', { filter: ['thead', 'tbody', 'tfoot'], replacement: content => content });
  converter.addRule('table', { filter: 'table', replacement: content => `\n\n${content.trim().replace(/\n+/g, '\n')}\n\n` });
  converter.addRule('image', {
    filter: 'img',
    replacement: (_, node) => {
      const src = node.getAttribute('src') || '';
      return `[image: ${JSON.stringify(node.getAttribute('alt') || '')}; ${/^data:/i.test(src) ? 'embedded data' : JSON.stringify(src)}]`;
    },
  });
  return {
    text: converter.turndown(new TextDecoder('utf-8', { fatal: true }).decode(buffer)),
    warnings: ['HTML: static UTF-8 text only; scripts/styles are excluded. Linked/embedded images, frames, CSS visibility and dynamic content require original-page inspection; no resources are fetched. Citations use extracted lines, not HTML source lines.'],
  };
}
