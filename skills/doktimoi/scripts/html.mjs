import Turndown from 'turndown';

function listLabel(number, type) {
  if (number < 1n) return String(number);
  if (type === 'a' || type === 'A') {
    let label = '';
    while (number) { number--; label = String.fromCharCode(65 + Number(number % 26n)) + label; number /= 26n; }
    return type === 'a' ? label.toLowerCase() : label;
  }
  if ((type === 'i' || type === 'I') && number <= 3999n) {
    let label = '';
    for (const [value, symbol] of [[1000n, 'M'], [900n, 'CM'], [500n, 'D'], [400n, 'CD'], [100n, 'C'], [90n, 'XC'], [50n, 'L'], [40n, 'XL'], [10n, 'X'], [9n, 'IX'], [5n, 'V'], [4n, 'IV'], [1n, 'I']]) {
      while (number >= value) { label += symbol; number -= value; }
    }
    return type === 'i' ? label.toLowerCase() : label;
  }
  return String(number);
}

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
  converter.addRule('bare-pre', {
    filter: node => node.nodeName === 'PRE' && node.firstChild?.nodeName !== 'CODE',
    replacement: (_, node) => {
      const code = node.textContent;
      const fence = '`'.repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), match => match[0].length + 1)));
      return `\n\n${fence}\n${code.replace(/\n$/, '')}\n${fence}\n\n`;
    },
  });
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
      const prefix = `${listLabel(ordinals.get(node), node.getAttribute('type') || node.parentNode.getAttribute('type'))}. `;
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
