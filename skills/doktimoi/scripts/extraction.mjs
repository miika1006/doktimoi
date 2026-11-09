import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
export const MISSING_CONVERTER = 'DOKTIMOI_MISSING_CONVERTER';
export const NO_TEXT ='[Visual content; no readable text detected. Inspect the image.]';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const utf8 = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer);
export const ifMissing = (promise, fallback) => promise.catch(error => { if (error.code !== 'ENOENT') throw error; return fallback; });

export async function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export function additionalOcrLines(ocrText, nativeText) {
  const normalize = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
  const native = new Set(nativeText.split('\n').map(normalize));
  return ocrText.split('\n').filter(line => normalize(line) && !native.has(normalize(line))).join('\n');
}
export function extractionConfig() {
  const languages = process.env.DOKTIMOI_OCR_LANGUAGES ?? 'eng+fin';
  const mode = process.env.DOKTIMOI_OCR ?? 'auto';
  if (!/^[a-z]{3}(?:\+[a-z]{3})*$/.test(languages)) throw new Error('OCR languages must be codes such as eng+fin');
  if (!['auto', 'always', 'off'].includes(mode)) throw new Error('DOKTIMOI_OCR must be auto, always or off');
  return { languages, mode };
}

export function createExtraction(assetDir) {
  const { languages, mode } = extractionConfig();
  let worker;
  let queue = Promise.resolve();
  const stats = { ocrCalls: 0, ocrCacheHits: 0 };
  const seen = new Map();
  const unlinked = async (file, cache) => {
    const stat = await ifMissing(fs.lstat(file));
    if (stat?.isSymbolicLink()) throw new Error(`Symlink in ${cache} cache`);
    return stat;
  };
  async function ocr(buffer) {
    const digest = hash(buffer);
    if (seen.has(digest)) { stats.ocrCacheHits++; return seen.get(digest); }
    let visual, cacheFile;
    if (assetDir) {
      await fs.mkdir(assetDir, { recursive: true });
      // Decode locally: normalize images for OCR and later inspection, never fetch URLs.
      const { loadImage, createCanvas } = await import('@napi-rs/canvas');
      const image = await loadImage(buffer);
      if (image.width * image.height > 40_000_000) throw new Error('Image exceeds 40 megapixels; resize it before indexing');
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      buffer = canvas.toBuffer('image/png');
      const imageHash = hash(buffer);
      visual = `.doktimoi/visuals/${imageHash}.png`;
      const dest = path.join(assetDir, `${imageHash}.png`);
      if (!await unlinked(dest, 'visual')) await fs.writeFile(dest, buffer, { flag: 'wx' });
      const cacheDir = path.join(path.dirname(assetDir), 'ocr');
      await fs.mkdir(cacheDir, { recursive: true });
      cacheFile = path.join(cacheDir, `${imageHash}-${languages}.json`);
      if (await unlinked(cacheFile, 'OCR') && mode !== 'off') {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        if (cached.version === 1 && typeof cached.text === 'string' && Number.isFinite(cached.confidence)) {
          const result = { text: cached.text, confidence: cached.confidence, visual };
          stats.ocrCacheHits++; seen.set(digest, result); return result;
        }
      }
    }
    if (mode === 'off') return { text: '', confidence: null, visual, disabled: true };
    if (!worker) {
      const { createWorker } = await import('tesseract.js');
      const cachePath = process.env.DOKTIMOI_OCR_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'doktimoi', 'ocr');
      await fs.mkdir(cachePath, { recursive: true });
      worker = await createWorker(languages, 1, { cachePath, logger: () => {}, errorHandler: () => {} });
    }
    stats.ocrCalls++;
    const { data } = await worker.recognize(buffer, {}, { text: true });
    const result = { text: data.text.trim(), confidence: data.confidence, visual };
    if (cacheFile) await atomicWrite(cacheFile, JSON.stringify({ version: 1, text: result.text, confidence: result.confidence }));
    seen.set(digest, result);
    return result;
  }
  async function pdf(buffer) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false,
      cMapUrl: path.join(base, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
      standardFontDataUrl: path.join(base, 'standard_fonts').replaceAll('\\', '/') + '/', useSystemFonts: false });
    const doc = await task.promise;
    const segments = [], warnings = [];
    try {
      for (let number = 1; number <= doc.numPages; number++) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        let text = '', y;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          if (y !== undefined && Math.abs(item.transform[5] - y) > 2 && !text.endsWith('\n')) text += '\n';
          text += item.str + (item.hasEOL ? '\n' : ' ');
          y = item.transform[5];
        }
        text = text.trim();
        if (text) segments.push({ text, location: `page:${number}:extracted-lines`, heading: `Page ${number}` });
        const operations = await page.getOperatorList();
        const hasImages = operations.fnArray.some(op => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].includes(op));
        if (mode === 'always' || (mode === 'auto' && (hasImages || !text))) {
          const viewport = page.getViewport({ scale: 2.5 });
          if (viewport.width * viewport.height > 40_000_000) throw new Error(`PDF page ${number} exceeds render size limit`);
          const surface = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          try {
            await page.render({ canvasContext: surface.context, viewport }).promise;
            const result = await ocr(surface.canvas.toBuffer('image/png'));
            // Avoid repeating the native text layer when OCR sees the same lines.
            const extra = additionalOcrLines(result.text, text);
            if (extra || !text) segments.push({ text: extra || NO_TEXT,
              location: `page:${number}:ocr-lines`, heading: `Page ${number} OCR (confidence ${Math.round(result.confidence ?? 0)})`, visual: result.visual });
            else segments.at(-1).visual = result.visual;
            if (extra || !text) warnings.push(`PDF page ${number}: OCR may misread text; check the page for critical facts.`);
          } finally { doc.canvasFactory.destroy(surface); }
        } else if (hasImages || !text) {
          warnings.push(`PDF page ${number}: visual content was not OCRed (DOKTIMOI_OCR=off).`);
        }
        page.cleanup();
      }
      warnings.push('PDF: reading order, tables and diagrams may need visual verification.');
      return { segments, warnings };
    } finally { await task.destroy(); }
  }
  return { stats, ocr: buffer => {
    const job = queue.then(() => ocr(buffer));
    queue = job.catch(() => {});
    return job;
  }, pdf, close: async () => { await queue; if (worker) await worker.terminate(); } };
}

// Use a private profile with macros disabled, so an open LibreOffice cannot intercept conversion.
export async function legacyOffice(buffer, extension) {
  const conversion = { ".doc": ["docx:Office Open XML Text", ".docx"], ".xls": ["xlsx:Calc MS Excel 2007 XML", ".xlsx"] }[extension];
  if (!conversion) throw new Error("Unsupported legacy Office conversion");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'doktimoi-doc-'));
  try {
    const profile = path.join(temp, 'profile');
    await fs.mkdir(path.join(profile, 'user'), { recursive: true });
    await fs.writeFile(path.join(profile, 'user/registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item></oor:items>');
    const input = path.join(temp, `input${extension}`);
    await fs.writeFile(input, buffer);
    const executable = await findSoffice();
    try {
      await run(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore',
        '--convert-to', conversion[0], '--outdir', temp, input], { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch (e) {
      if (e.code === 'ENOENT') throw Object.assign(new Error(`Legacy ${extension} requires LibreOffice; install it or set DOKTIMOI_SOFFICE to its executable`), { code: MISSING_CONVERTER });
      throw e;
    }
    return await fs.readFile(path.join(temp, `input${conversion[1]}`)).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`LibreOffice produced no ${conversion[1]} output; check the document and install LibreOffice ${extension === '.xls' ? 'Calc' : 'Writer'}`);
      throw error;
    });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export function officeCandidates(platform = process.platform, env = process.env) {
  if (env.DOKTIMOI_SOFFICE) return [env.DOKTIMOI_SOFFICE];
  if (platform === 'win32') return [...new Set([env.ProgramFiles, env.PROGRAMFILES, env['ProgramFiles(x86)'], env['PROGRAMFILES(X86)']].filter(Boolean))]
    .map(root => path.win32.join(root, 'LibreOffice', 'program', 'soffice.exe')).concat('soffice.exe');
  return platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice'] : ['soffice'];
}

async function findSoffice() {
  const candidates = officeCandidates();
  for (const candidate of candidates.slice(0, -1)) if (await fs.stat(candidate).catch(() => null)) return candidate;
  return candidates.at(-1);
}
