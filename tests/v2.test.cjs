'use strict';
// Development-only integration tests. Run against the final, deployable HTML.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const htmlPath = process.env.HUB_TEST_HTML || path.join(root, 'index.html');
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const results = [], browserErrors = [], requests = [];
let browser, context, page, server;
const useCachedCDN = process.env.HUB_TEST_CACHE_CDN === '1';
const dependencyPaths = [
  ['pdf-lib@1.17.1/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['pdfjs-dist@5.7.284/legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist@5.7.284/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['fflate@0.8.2/umd/index.js', 'fflate.min.js'],
  ['qrcode-generator@1.4.4/qrcode.js', 'qrcode.js'],
];
async function installRoutes(target) {
  if (!useCachedCDN) return;
  await target.route('https://cdn.jsdelivr.net/**', async route => {
    const match = dependencyPaths.find(([fragment]) => route.request().url().includes(fragment));
    const filename = match && path.join(__dirname, '.cache', match[1]);
    if (!filename || !fs.existsSync(filename)) return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(filename), headers: { 'access-control-allow-origin': '*' } });
  });
}
async function test(name, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started), detail });
    console.log(`PASS ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Math.round(performance.now() - started), error: error.message });
    console.error(`FAIL ${name}\n${error.stack}`);
    // Recover dialogs so one failed interaction cannot cascade through the suite.
    await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }).catch(() => {});
  }
}
const evaluate = (fn, arg) => page.evaluate(fn, arg);
async function freshPage() {
  const p = await context.newPage();
  p.on('pageerror', error => browserErrors.push(error.message));
  await p.goto(origin, { waitUntil: 'load' });
  await p.waitForFunction(() => window.Hub?.tools?.length >= 27);
  return p;
}
let origin;
async function main() {
  server = http.createServer((req, res) => {
    if (!['/', '/index.html'].includes(req.url.split('?')[0])) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(htmlPath).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 412, height: 915 }, acceptDownloads: true, locale: 'ar-KW', reducedMotion: 'reduce', hasTouch: true });
  await installRoutes(context);
  page = await freshPage();
  page.on('request', req => requests.push({ url: req.url(), method: req.method() }));
  await evaluate(() => {
    window.Q = {
      files: {}, outputs: {},
      ctx(signal) { return { signal: signal || new AbortController().signal, settings: { ...Hub.state.settings, maxFileMB: 100, maxArchiveMB: 200, maxEntries: 1000, concurrency: 1 }, records: [], progress() {}, stage() {} }; },
      async run(id, files, options = {}, ctx) {
        const tool = Hub.tools.find(t => t.id === id);
        if (!tool) throw new Error(`Missing tool ${id}`);
        return tool.run(files, options, ctx || this.ctx());
      },
      async image(name = 'صورة اختبار.png', width = 120, height = 80) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const c = canvas.getContext('2d'); c.fillStyle = '#804020'; c.fillRect(0, 0, width, height);
        c.fillStyle = '#fff'; c.fillRect(width / 2, 0, width / 2, height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        canvas.width = canvas.height = 1;
        return this.files[name] = new File([blob], name, { type: 'image/png' });
      },
      async pixels(blob) {
        const b = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = b.width; c.height = b.height;
        c.getContext('2d').drawImage(b, 0, 0); b.close();
        const result = { width: c.width, height: c.height, pixels: [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data] };
        c.width = c.height = 1; return result;
      },
      async dimensions(blob) { const b = await createImageBitmap(blob); const r = { width: b.width, height: b.height }; b.close(); return r; },
      async pdf(name = 'صفحات.pdf', widths = [310, 320, 330]) {
        const lib = await Hub.deps.load('pdfLib'), doc = await lib.PDFDocument.create();
        for (const width of widths) { const p = doc.addPage([width, 600]); p.drawText('Page ' + width, { x: 30, y: 400 }); }
        return this.files[name] = new File([await doc.save()], name, { type: 'application/pdf' });
      },
      wav(name = 'صوت عربي.wav', seconds = 2, sampleRate = 8000) {
        const n = seconds * sampleRate, a = new ArrayBuffer(44 + n * 4), v = new DataView(a);
        const put = (at, text) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
        put(0, 'RIFF'); v.setUint32(4, a.byteLength - 8, true); put(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, 2, true); v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); put(36, 'data'); v.setUint32(40, n * 4, true);
        for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.round(Math.sin(i * 2 * Math.PI * 220 / sampleRate) * 4000), true); v.setInt16(46 + i * 4, Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 8000), true); }
        return this.files[name] = new File([a], name, { type: 'audio/wav' });
      }
    };
  });

  await test('V2 preserves every existing functional tool and Arabic RTL', async () => {
    const expected = ['image-transform', 'images-pdf', 'pdf-merge', 'pdf-split', 'pdf-extract', 'pdf-delete', 'pdf-reorder', 'pdf-rotate', 'pdf-text', 'zip-create', 'zip-inspect', 'zip-extract', 'csv-json', 'json-csv', 'json-format', 'xml-format', 'text-stats', 'text-merge', 'text-split', 'text-encoding', 'html-text', 'sha256', 'duplicates', 'base64-encode', 'base64-decode', 'audio-edit', 'video-frame'];
    const r = await evaluate(() => ({ ids: Hub.tools.map(t => t.id), lang: document.documentElement.lang, dir: document.documentElement.dir, secrets: /(?:sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20})/.test(document.documentElement.outerHTML) }));
    for (const id of expected) assert.ok(r.ids.includes(id), `Existing tool ${id} was lost`);
    assert.equal(new Set(r.ids).size, r.ids.length); assert.equal(r.lang, 'ar'); assert.equal(r.dir, 'rtl'); assert.equal(r.secrets, false);
    return { preserved: expected.length, total: r.ids.length };
  });
  await test('V2 malformed saved activity cannot break startup or retain arbitrary stored fields', async () => {
    const c = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const p = await c.newPage(); p.on('pageerror', error => browserErrors.push(error.message));
    try {
      await p.addInitScript(() => { if (!localStorage.getItem('qa-activity-seeded')) { localStorage.setItem('transform-hub-activity', '{"filter":1}'); localStorage.setItem('qa-activity-seeded', 'true'); } });
      await p.goto(origin, { waitUntil: 'load' }); await p.waitForFunction(() => window.Hub?.tools?.length >= 27);
      assert.equal(await p.evaluate(() => Hub.state.activity.length), 0);
      await p.evaluate(() => localStorage.setItem('transform-hub-activity', JSON.stringify([null, {}, { toolId: 'json-format', status: 'completed', types: ['json', {}], durationMs: 'invalid', outputBytes: -50, at: 1, filename: 'private-name.json', text: 'private-contents' }, { toolId: 'json-format', status: 'nonsense' }])));
      await p.reload({ waitUntil: 'load' }); await p.waitForFunction(() => window.Hub?.tools?.length >= 27);
      const r = await p.evaluate(() => Hub.state.activity);
      assert.equal(r.length, 1); assert.equal(r[0].durationMs, 0); assert.equal(r[0].outputBytes, 0); assert.deepEqual(r[0].types, ['json']); assert.ok(!JSON.stringify(r).includes('private-')); return { startupRecovered: true, validEntries: r.length, arbitraryFieldsRemoved: true };
    } finally { await c.close(); }
  });
  await test('V2 content recognition distinguishes bracketed CSV headers from actual mislabeled JSON', async () => {
    const r = await evaluate(async () => {
      const csv = new File(['[phase],n\nعربي,1'], 'مراحل.csv', { type: 'text/csv' }), json = new File(['{"x":1}'], 'ليس جدولا.csv', { type: 'text/csv' });
      const a = await Hub.inspect(csv), b = await Hub.inspect(json), tool = Hub.tools.find(t => t.id === 'csv-studio');
      const out = (await Q.run('csv-json', [csv], { header: true }))[0];
      return { csvKind: a.kind, jsonKind: b.kind, csvCompatible: Hub.compatible(tool, a), jsonCompatible: Hub.compatible(tool, b), data: JSON.parse(await out.blob.text()) };
    });
    assert.equal(r.csvKind, 'csv'); assert.equal(r.jsonKind, 'json'); assert.equal(r.csvCompatible, true); assert.equal(r.jsonCompatible, false); assert.deepEqual(r.data, [{ '[phase]': 'عربي', n: '1' }]); return r;
  });

  await test('V2 PDF organizer: selected order, rotation and invalid duplicate rejection', async () => {
    const r = await evaluate(async () => {
      const f = await Q.pdf(), lib = await Hub.deps.load('pdfLib');
      const out = (await Q.run('pdf-organize', [f], { pageOrder: [{ index: 2, rotation: 90 }, { index: 0, rotation: 180 }] }))[0];
      const doc = await lib.PDFDocument.load(await out.blob.arrayBuffer());
      let duplicateRejected = false;
      try { await Q.run('pdf-organize', [f], { pageOrder: [{ index: 0, rotation: 0 }, { index: 0, rotation: 0 }] }); } catch (e) { duplicateRejected = /[\u0600-\u06ff]/.test(e.message); }
      const ac = new AbortController(); ac.abort(); let cancelled = false;
      try { await Q.run('pdf-organize', [f], { pages: '1' }, Q.ctx(ac.signal)); } catch (e) { cancelled = e.name === 'AbortError'; }
      return { pages: doc.getPages().map(p => ({ width: p.getWidth(), rotation: p.getRotation().angle })), duplicateRejected, cancelled };
    });
    assert.deepEqual(r.pages, [{ width: 330, rotation: 90 }, { width: 310, rotation: 180 }]); assert.equal(r.duplicateRejected, true); assert.equal(r.cancelled, true); return r;
  });
  await test('V2 PDF to images: every encoded image reopens and keeps selected page order', async () => {
    const r = await evaluate(async () => {
      const outs = await Q.run('pdf-images', [Q.files['صفحات.pdf']], { pages: '3,1', format: 'image/png', maxWidth: 330 });
      const images = []; for (const o of outs) images.push({ ...await Q.dimensions(o.blob), type: o.blob.type, name: o.name });
      const jpeg = (await Q.run('pdf-images', [Q.files['صفحات.pdf']], { pages: '2', format: 'image/jpeg', maxWidth: 320, quality: 0.8 }))[0];
      return { images, jpeg: { ...await Q.dimensions(jpeg.blob), type: jpeg.blob.type } };
    });
    assert.equal(r.images.length, 2); for (const image of r.images) { assert.equal(image.type, 'image/png'); assert.ok(image.width > 0 && image.width <= 331); assert.ok(image.height > 0); }
    assert.equal(r.jpeg.type, 'image/jpeg'); assert.ok(r.jpeg.width > 0); assert.notEqual(r.images[0].name, r.images[1].name); return r;
  });
  await test('V2 PDF information and editable metadata preserve real document structure', async () => {
    const r = await evaluate(async () => {
      const f = Q.files['صفحات.pdf'];
      const report = (await Q.run('pdf-info', [f]))[0];
      const out = (await Q.run('pdf-metadata', [f], { title: 'وثيقة عربية', author: 'مؤلف الاختبار', subject: 'تجربة', keywords: 'عربي، اختبار' }))[0];
      const lib = await Hub.deps.load('pdfLib'), doc = await lib.PDFDocument.load(await out.blob.arrayBuffer());
      const preserved = (await Q.run('pdf-metadata', [new File([out.blob], 'معدّل.pdf')], { title: '', author: '' }))[0];
      const preservedDoc = await lib.PDFDocument.load(await preserved.blob.arrayBuffer());
      return { report: await report.blob.text(), pages: doc.getPageCount(), title: doc.getTitle(), author: doc.getAuthor(), subject: doc.getSubject(), preservedTitle: preservedDoc.getTitle() };
    });
    assert.match(r.report, /3/); assert.match(r.report, /[\u0600-\u06ff]/); assert.equal(r.pages, 3); assert.equal(r.title, 'وثيقة عربية'); assert.equal(r.author, 'مؤلف الاختبار'); assert.equal(r.subject, 'تجربة'); assert.equal(r.preservedTitle, r.title); return { pages: r.pages, title: r.title, author: r.author };
  });
  await test('V2 PDF page numbers and Arabic watermark change the output content', async () => {
    const r = await evaluate(async () => {
      const f = Q.files['صفحات.pdf'];
      const numbered = (await Q.run('pdf-number', [f], { pages: '1-3', start: 7, fontSize: 14, position: 'bottom' }))[0];
      const text = (await Q.run('pdf-text', [new File([numbered.blob], 'مرقم.pdf')]))[0];
      const watermarked = (await Q.run('pdf-watermark', [f], { pages: '1', text: 'نسخة شخصية', opacity: 0.8, color: '#6d5ce7', widthPercent: 65 }))[0];
      const before = await Hub.PDF.renderPage(f, 1, { signal: Q.ctx().signal, maxWidth: 330 });
      const after = await Hub.PDF.renderPage(new File([watermarked.blob], 'علامة.pdf'), 1, { signal: Q.ctx().signal, maxWidth: 330 });
      const a = await Q.pixels(before.blob), b = await Q.pixels(after.blob); let changed = 0;
      for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i] !== b.pixels[i] || a.pixels[i + 1] !== b.pixels[i + 1] || a.pixels[i + 2] !== b.pixels[i + 2]) changed++;
      return { text: await text.blob.text(), changed, dimensions: { width: b.width, height: b.height } };
    });
    for (const digit of ['7', '8', '9']) assert.match(r.text, new RegExp(digit)); assert.ok(r.changed > 100, 'Watermark must alter rendered pixels'); return { numberedPages: 3, changedPixels: r.changed, dimensions: r.dimensions };
  });

  await test('V2 Arabic text cleaning is opt-in and applies selected transformations exactly', async () => {
    const r = await evaluate(async () => {
      const input = 'أَهْـلاً، إختبار ١٢٣ ى';
      const f = new File([input], 'نص عربي.txt');
      const keep = (await Q.run('arabic-clean', [f], {}))[0];
      const clean = (await Q.run('arabic-clean', [f], { tatweel: true, diacritics: true, alef: true, ya: true, digits: 'western' }))[0];
      return { input, keep: await keep.blob.text(), clean: await clean.blob.text() };
    });
    assert.equal(r.keep, r.input); assert.ok(!/[\u0640\u064b-\u065f\u0660-\u0669أإآى]/.test(r.clean)); assert.match(r.clean, /123/); return r;
  });
  await test('V2 text cleanup and literal replacement preserve Arabic and avoid regex interpretation', async () => {
    const r = await evaluate(async () => {
      const clean = (await Q.run('text-clean', [new File(['  z  \n\nA\nA\n ب  '], 'تنظيف.txt')], { whitespace: true, emptyLines: true, deduplicate: true, sort: 'ascending', caseMode: 'lower' }))[0];
      const replace = (await Q.run('text-replace', [new File(['a.* a.* A.* عربي'], 'استبدال.txt')], { find: 'a.*', replacement: '$& جديد', matchCase: true }))[0];
      return { clean: await clean.blob.text(), replaced: await replace.blob.text() };
    });
    assert.equal((r.clean.match(/a/g) || []).length, 1); assert.match(r.clean, /ب/); assert.ok(!/\n\n/.test(r.clean)); assert.equal(r.replaced, '$& جديد $& جديد A.* عربي'); return r;
  });
  await test('V2 safe Markdown export creates real HTML without active uploaded content', async () => {
    const r = await evaluate(async () => {
      const markdown = '# عنوان عربي\n\n**نص مهم**\n\n<script>window.evil=1</script>\n\n![private](https://invalid.example/private)';
      const o = (await Q.run('markdown-html', [new File([markdown], 'ملاحظات.md')]))[0];
      const html = await o.blob.text(), doc = new DOMParser().parseFromString(html, 'text/html');
      return { name: o.name, title: doc.querySelector('h1')?.textContent, strong: doc.querySelector('strong')?.textContent, scripts: doc.querySelectorAll('script').length, remoteElements: doc.querySelectorAll('[src],[href]').length, csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content };
    });
    assert.match(r.name, /\.html$/); assert.equal(r.title, 'عنوان عربي'); assert.equal(r.strong, 'نص مهم'); assert.equal(r.scripts, 0); assert.equal(r.remoteElements, 0); assert.match(r.csp, /default-src 'none'/); return r;
  });
  await test('V2 Arabic text to PDF creates valid pages with visible rasterized text', async () => {
    const r = await evaluate(async () => {
      const out = (await Q.run('text-pdf', [new File(['مرحبا بالعالم\nنص عربي لاختبار المستندات'], 'عربي.txt')], { pageSize: 'a4', orientation: 'portrait', direction: 'rtl', fontSize: 18, margin: 18 }))[0];
      Q.outputs.arabicPdf = out;
      const doc = await (await Hub.deps.load('pdfLib')).PDFDocument.load(await out.blob.arrayBuffer());
      const rendered = await Hub.PDF.renderPage(new File([out.blob], out.name), 1, { signal: Q.ctx().signal, maxWidth: 600 });
      const p = await Q.pixels(rendered.blob); let dark = 0;
      for (let i = 0; i < p.pixels.length; i += 4) if (p.pixels[i] < 160 && p.pixels[i + 1] < 160 && p.pixels[i + 2] < 160) dark++;
      return { pages: doc.getPageCount(), name: out.name, width: doc.getPages()[0].getWidth(), darkPixels: dark };
    });
    assert.equal(r.pages, 1); assert.match(r.name, /\.pdf$/); assert.ok(r.width > 590 && r.width < 600); assert.ok(r.darkPixels > 100); return r;
  });
  await test('V2 DOCX generation and extraction round trip Arabic text through real OOXML', async () => {
    const r = await evaluate(async () => {
      const text = 'عنوان عربي\nسطر ثان & <قيم>\nEnglish 123';
      const o = (await Q.run('text-docx', [new File([text], 'وثيقة عربية.txt')], { direction: 'rtl' }))[0];
      const archive = new File([o.blob], o.name), meta = await Hub.Archives.inspect(archive, Q.ctx());
      const extracted = (await Q.run('docx-text', [archive]))[0];
      const lib = await Hub.deps.load('zip'), zip = lib.unzipSync(new Uint8Array(await o.blob.arrayBuffer()));
      const xml = new TextDecoder().decode(zip['word/document.xml']);
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      return { text, extracted: await extracted.blob.text(), names: meta.entries.map(e => e.name), validXML: !doc.querySelector('parsererror'), bidi: /w:bidi/.test(xml), name: o.name };
    });
    assert.match(r.name, /\.docx$/); assert.ok(r.names.includes('word/document.xml')); assert.ok(r.names.includes('[Content_Types].xml')); assert.equal(r.validXML, true); assert.equal(r.bidi, true); assert.equal(r.extracted.trim(), r.text); return { entries: r.names.length, bidi: r.bidi, extracted: r.extracted };
  });

  await test('V2 audio edits: fades, normalization, mono conversion and requested sample rate', async () => {
    const r = await evaluate(async () => {
      const f = Q.wav();
      const out = (await Q.run('audio-edit', [f], { start: 0.25, end: 1.25, volume: 100, fadeIn: 0.2, fadeOut: 0.2, normalize: true, channels: 'mono', sampleRate: '16000' }))[0];
      const bytes = await out.blob.arrayBuffer(), v = new DataView(bytes), samples = (bytes.byteLength - 44) / 2;
      let peak = 0, early = 0, middle = 0, tail = 0;
      for (let i = 0; i < samples; i++) { const s = Math.abs(v.getInt16(44 + i * 2, true)); peak = Math.max(peak, s); if (i < 160) early += s; if (i >= 6400 && i < 6560) middle += s; if (i >= samples - 160) tail += s; }
      const info = await Hub.Media.inspect(new File([out.blob], out.name), 'audio', Q.ctx().signal);
      const ac = new AbortController(); ac.abort(); let cancelled = false;
      try { await Q.run('audio-edit', [f], {}, Q.ctx(ac.signal)); } catch (e) { cancelled = e.name === 'AbortError'; }
      return { format: new TextDecoder().decode(bytes.slice(0, 4)), duration: info.duration, sampleRate: v.getUint32(24, true), channels: v.getUint16(22, true), samples, peak, early, middle, tail, cancelled };
    });
    assert.equal(r.format, 'RIFF'); assert.equal(r.channels, 1); assert.equal(r.sampleRate, 16000); assert.equal(r.samples, 16000); assert.ok(Math.abs(r.duration - 1) < 0.01); assert.ok(r.peak > 28000 && r.peak <= 32767); assert.ok(r.early < r.middle / 3); assert.ok(r.tail < r.middle / 3); assert.equal(r.cancelled, true); return r;
  });
  await test('V2 video thumbnails: individual frames and contact sheet reopen with exact layout', async () => {
    const bytes = [...fs.readFileSync(path.join(__dirname, 'fixtures', 'test-pattern.webm'))];
    const r = await evaluate(async bytes => {
      const f = Q.files.video = new File([new Uint8Array(bytes)], 'فيديو عربي.webm', { type: 'video/webm' });
      const outputs = await Q.run('video-thumbnails', [f], { count: 4, width: 160, columns: 2, start: 0, end: 1.5, mode: 'both' });
      const images = []; for (const o of outputs) images.push({ ...await Q.dimensions(o.blob), type: o.blob.type, name: o.name });
      return images;
    }, bytes);
    assert.equal(r.length, 5); assert.equal(r.filter(o => o.width === 160 && o.height === 90).length, 4); assert.equal(r.filter(o => o.width === 356 && o.height === 272).length, 1); assert.equal(new Set(r.map(o => o.name)).size, 5); return r;
  });
  await test('V2 audio merge preserves ordered source samples in one valid WAV', async () => {
    const r = await evaluate(async () => {
      const tone = Q.wav(), silentBytes = new Uint8Array(await tone.arrayBuffer()); silentBytes.fill(0, 44);
      const silence = new File([silentBytes], 'صمت.wav', { type: 'audio/wav' });
      const out = (await Q.run('audio-merge', [tone, silence], { channels: 'mono', sampleRate: '16000', volume: 100 }))[0];
      const buffer = await out.blob.arrayBuffer(), v = new DataView(buffer), frames = (buffer.byteLength - 44) / 2;
      let firstPeak = 0, secondPeak = 0;
      for (let i = 0; i < frames; i++) { const sample = Math.abs(v.getInt16(44 + i * 2, true)); if (i < frames / 2) firstPeak = Math.max(firstPeak, sample); else secondPeak = Math.max(secondPeak, sample); }
      const info = await Hub.Media.inspect(new File([out.blob], out.name), 'audio', Q.ctx().signal);
      return { channels: v.getUint16(22, true), sampleRate: v.getUint32(24, true), frames, duration: info.duration, firstPeak, secondPeak };
    });
    assert.equal(r.channels, 1); assert.equal(r.sampleRate, 16000); assert.equal(r.frames, 64000); assert.equal(r.duration, 4); assert.ok(r.firstPeak > 1000); assert.equal(r.secondPeak, 0); return r;
  });
  await test('V2 QR generation round trips Arabic through an independent PNG decoder', async () => {
    // jsQR is a development-only independent decoder; the app uses qrcode-generator.
    await page.addScriptTag({ path: require.resolve('jsqr') });
    const r = await evaluate(async () => {
      const inputs = ['مرحبا بالعالم English 123', 'https://example.com/?اسم=علي', 'ص'.repeat(600)], decoded = [];
      for (let i = 0; i < inputs.length; i++) {
        const size = i === 2 ? 1024 : 512;
        const out = (await Q.run('qr-generate', [], { text: inputs[i], size, name: 'رمز عربي' }))[0];
        const p = await Q.pixels(out.blob), code = jsQR(new Uint8ClampedArray(p.pixels), p.width, p.height);
        decoded.push({ expected: inputs[i], actual: code?.data, width: p.width, height: p.height, name: out.name });
      }
      let limitRejected = false; try { await Q.run('qr-generate', [], { text: 'ص'.repeat(601), size: 1024 }); } catch (e) { limitRejected = /1200/.test(e.message); }
      const ac = new AbortController(); ac.abort(); let cancelled = false; try { await Q.run('qr-generate', [], { text: 'عربي' }, Q.ctx(ac.signal)); } catch (e) { cancelled = e.name === 'AbortError'; }
      const scanning = Hub.tools.find(t => t.id === 'qr-scan');
      return { decoded, limitRejected, cancelled, scannerAvailable: scanning.available, nativeScanner: typeof BarcodeDetector === 'function' };
    });
    for (const d of r.decoded) { assert.equal(d.actual, d.expected); assert.equal(d.width, d.height); assert.match(d.name, /\.png$/); }
    assert.equal(r.limitRejected, true); assert.equal(r.cancelled, true); if (!r.nativeScanner) assert.equal(r.scannerAvailable, false);
    return { roundTrips: r.decoded.length, arabicMaxUTF8Bytes: 1200, limitRejected: true, cancelled: true, scannerAvailable: r.scannerAvailable };
  });

  await test('V2 every available tool has a direct file picker inside its dialog', async () => {
    const r = await evaluate(() => {
      Hub.state.files = []; Hub.emit();
      const failures = [];
      for (const tool of Hub.tools.filter(t => t.available !== false)) {
        Hub.openTool(tool);
        const picker = document.querySelector('#tool-file-input'), add = document.querySelector('#tool-add-files');
        if (!picker || picker.type !== 'file' || !add || add.disabled || add.closest('[hidden]')) failures.push(tool.id);
        document.querySelector('#tool-dialog').close();
      }
      return { count: Hub.tools.filter(t => t.available !== false).length, failures };
    });
    assert.deepEqual(r.failures, []); assert.ok(r.count >= 27); return r;
  });
  await test('V2 incompatible dialog input recovers locally and preserves unrelated workspace files', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([new File(['{"قيمة":1}'], 'بيانات خاصة.json', { type: 'application/json' })]); Hub.openTool(Hub.tools.find(t => t.id === 'image-transform')); });
    assert.equal(await page.locator('#run-tool').isDisabled(), true);
    assert.equal(await page.locator('#tool-add-files').isVisible(), true);
    const file = await evaluate(async () => [...new Uint8Array(await (await Q.image()).arrayBuffer())]);
    await page.locator('#option-format').selectOption('image/jpeg');
    await page.locator('#tool-file-input').setInputFiles([{ name: 'صورة من داخل الأداة.png', mimeType: 'image/png', buffer: Buffer.from(file) }]);
    await page.waitForFunction(() => !document.querySelector('#run-tool').disabled);
    assert.equal(await page.locator('#option-format').inputValue(), 'image/jpeg');
    const r = await evaluate(() => ({ names: Hub.state.files.map(r => r.file.name), rows: document.querySelectorAll('[data-tool-file-id]').length, open: document.querySelector('#tool-dialog').open }));
    assert.ok(r.names.includes('بيانات خاصة.json')); assert.ok(r.names.includes('صورة من داخل الأداة.png')); assert.equal(r.rows, 1); assert.equal(r.open, true);
    await page.keyboard.press('Escape'); return r;
  });
  await test('V2 tool input ordering, replacement and removal work without leaving the dialog', async () => {
    const file = await evaluate(async () => [...new Uint8Array(await (await Q.image('الأولى.png')).arrayBuffer())]);
    await evaluate(async () => { await Hub.addFiles([await Q.image('الثانية.png')]); Hub.openTool(Hub.tools.find(t => t.id === 'images-pdf')); });
    await page.waitForFunction(() => document.querySelectorAll('[data-tool-file-id]').length === 2);
    const ids = await page.locator('[data-tool-file-id]').evaluateAll(rows => rows.map(r => r.dataset.toolFileId));
    await page.locator('[data-tool-down="' + ids[0] + '"]').click();
    const moved = await page.locator('[data-tool-file-id]').evaluateAll(rows => rows.map(r => r.dataset.toolFileId));
    assert.deepEqual(moved, [ids[1], ids[0]]);
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-tool-replace="' + ids[1] + '"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles([{ name: 'صورة بديلة.png', mimeType: 'image/png', buffer: Buffer.from(file) }]);
    await page.waitForFunction(() => document.querySelector('#tool-files').textContent.includes('صورة بديلة.png'));
    const first = await page.locator('[data-tool-file-id]').first().getAttribute('data-tool-file-id');
    await page.locator('[data-tool-remove="' + first + '"]').click();
    assert.equal(await page.locator('[data-tool-file-id]').count(), 1);
    assert.equal(await evaluate(() => Hub.state.files.some(r => r.file.name === 'بيانات خاصة.json')), true);
    await page.locator('#tool-clear-inputs').click(); assert.equal(await page.locator('[data-tool-file-id]').count(), 0); assert.equal(await page.locator('#run-tool').isDisabled(), true);
    await page.keyboard.press('Escape'); return { reordered: true, replaced: true, removed: true, unrelatedPreserved: true };
  });
  await test('V2 incompatible in-dialog replacement keeps the original compatible file available', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([await Q.image('صورة محفوظة.png')]); Hub.openTool(Hub.tools.find(t => t.id === 'image-transform')); });
    const id = await page.locator('[data-tool-file-id]').getAttribute('data-tool-file-id');
    const chooserPromise = page.waitForEvent('filechooser'); await page.locator('[data-tool-replace="' + id + '"]').click();
    await (await chooserPromise).setFiles([{ name: 'بديل غير مناسب.json', mimeType: 'application/json', buffer: Buffer.from('{"x":1}') }]);
    await page.waitForFunction(() => Hub.state.files.some(r => r.file.name === 'بديل غير مناسب.json'));
    await page.waitForFunction(() => document.querySelector('#tool-error')?.hidden === false);
    // A safe thumbnail remount temporarily disables submission while its options load.
    await page.waitForFunction(() => !document.querySelector('#run-tool').disabled);
    const r = await evaluate(() => ({ originalPresent: Hub.state.files.some(r => r.file.name === 'صورة محفوظة.png'), chosen: [...document.querySelectorAll('[data-tool-file-id]')].map(row => row.dataset.toolFileId), canRun: !document.querySelector('#run-tool').disabled, error: document.querySelector('#tool-error').textContent, stillOpen: document.querySelector('#tool-dialog').open }));
    assert.equal(r.originalPresent, true); assert.deepEqual(r.chosen, [id]); assert.equal(r.canRun, true); assert.equal(r.stillOpen, true); assert.match(r.error, /غير متوافقة/); await page.keyboard.press('Escape'); return { originalPreserved: true, rejectedCandidateExplained: true, dialogUsable: true };
  });

  await test('V2 ZIP compression, integrity verification and high-ratio fallback preserve bytes', async () => {
    const r = await evaluate(async () => {
      const text = Array.from({ length: 1500 }, (_, i) => `سطر ${i % 173}: بيانات متكررة للاختبار ${i}\n`).join('');
      const f = new File([text], 'ملف مضغوط.txt');
      const stored = (await Q.run('zip-create', [f], { level: 0 }))[0], compressed = (await Q.run('zip-create', [f], { level: 6 }))[0];
      const zipped = new File([compressed.blob], 'مضغوط.zip'); Q.files.zip = zipped;
      const meta = await Hub.Archives.inspect(zipped, Q.ctx());
      const report = (await Q.run('zip-inspect', [zipped], { integrity: true }))[0];
      const back = (await Q.run('zip-extract', [zipped], {}))[0];
      const zeros = new File([new Uint8Array(512 * 1024)], 'صفري.bin');
      const safe = (await Q.run('zip-create', [zeros], { level: 9 }))[0];
      const safeMeta = await Hub.Archives.inspect(new File([safe.blob], 'آمن.zip'), Q.ctx());
      const safeBack = (await Q.run('zip-extract', [new File([safe.blob], 'آمن.zip')]))[0];
      return { stored: stored.blob.size, compressed: compressed.blob.size, method: meta.entries[0].method, text, back: await back.blob.text(), report: await report.blob.text(), safeMethod: safeMeta.entries[0].method, safeBytes: safeBack.blob.size };
    });
    assert.ok(r.compressed < r.stored / 2); assert.equal(r.method, 8); assert.equal(r.back, r.text); assert.match(r.report, /CRC32/); assert.equal(r.safeMethod, 0); assert.equal(r.safeBytes, 512 * 1024); return { stored: r.stored, compressed: r.compressed, method: r.method, safeMethod: r.safeMethod, safeBytes: r.safeBytes };
  });
  await test('V2 ZIP selected entry rename preserves folders and rejects traversal', async () => {
    const r = await evaluate(async () => {
      const out = (await Q.run('zip-extract', [Q.files.zip], { selectionIndices: [0], entryNames: { 0: 'مجلد/اسم جديد.txt' }, asZip: true }))[0];
      const entries = (await Hub.Archives.inspect(new File([out.blob], 'معدّل.zip'), Q.ctx())).entries;
      let rejected = false;
      try { await Q.run('zip-extract', [Q.files.zip], { selectionIndices: [0], entryNames: { 0: '../unsafe.txt' } }); } catch (e) { rejected = /[\u0600-\u06ff]/.test(e.message); }
      return { names: entries.map(e => e.name), rejected };
    });
    assert.deepEqual(r.names, ['مجلد/اسم جديد.txt']); assert.equal(r.rejected, true); return r;
  });
  await test('V2 SHA-512 matches independent known vectors including empty input', async () => {
    const reports = await evaluate(async () => {
      const results = [];
      for (const text of ['', 'abc', 'مرحبا']) results.push(await (await Q.run('sha512', [new File([text], 'بصمة.txt')]))[0].blob.text());
      return results;
    });
    ['', 'abc', 'مرحبا'].forEach((text, i) => assert.ok(reports[i].includes(crypto.createHash('sha512').update(text).digest('hex')))); return { knownVectors: reports.length };
  });
  await test('V2 batch rename keeps binary contents, extensions and unique Arabic names in ZIP', async () => {
    const r = await evaluate(async () => {
      const files = [new File(['first'], 'أول.TXT'), new File(['second'], 'ثان.TXT'), new File([], 'فارغ.TXT')];
      const options = { base: 'ملف عربي', prefix: 'مشروع-', suffix: '-نسخة', numbering: true, start: 7, padding: 2, lowerExtension: true, sort: 'original' };
      const separate = await Q.run('batch-rename', files, options), contents = []; for (const o of separate) contents.push(await o.blob.text());
      const zip = (await Q.run('batch-rename', files, { ...options, asZip: true }))[0];
      const meta = await Hub.Archives.inspect(new File([zip.blob], 'أسماء.zip'), Q.ctx());
      return { names: separate.map(o => o.name), contents, archiveNames: meta.entries.map(e => e.name), emptyAllowed: separate[2].allowEmpty };
    });
    assert.deepEqual(r.contents, ['first', 'second', '']); assert.equal(r.names.length, new Set(r.names).size); assert.match(r.names[0], /مشروع-07_ملف عربي-نسخة\.txt$/); assert.deepEqual(r.archiveNames, r.names); assert.equal(r.emptyAllowed, true); return r;
  });
  await test('V2 file inspector reports real binary signature and detected type despite misleading extension', async () => {
    const r = await evaluate(async () => {
      const image = await Q.image(), f = new File([image], 'مضلّل.txt', { type: 'text/plain' });
      const o = (await Q.run('file-inspect', [f, new File([], 'فارغ.bin')]))[0]; return await o.blob.text();
    });
    assert.match(r, /89 50 4e 47/); assert.match(r, /image\/png/); assert.match(r, /مضلّل\.txt/); assert.match(r, /عدد الملفات: 2/); return { signaturePresent: true, files: 2 };
  });
  await test('V2 URL and HTML entity codecs round trip Arabic without navigating or interpreting HTML', async () => {
    const r = await evaluate(async () => {
      const input = 'نص عربي & <script> 123\n"quoted" /?#';
      const f = new File([input], 'نص.txt'), result = {};
      for (const id of ['url-codec', 'html-entities']) { const encoded = (await Q.run(id, [f], { mode: 'encode' }))[0]; const decoded = (await Q.run(id, [new File([encoded.blob], 'encoded.txt')], { mode: 'decode' }))[0]; result[id] = { encoded: await encoded.blob.text(), decoded: await decoded.blob.text() }; }
      let invalid = false; try { await Q.run('url-codec', [new File(['%E0%A4'], 'تالف.txt')], { mode: 'decode' }); } catch (e) { invalid = /[\u0600-\u06ff]/.test(e.message); }
      return { input, ...result, invalid };
    });
    assert.equal(r['url-codec'].decoded, r.input); assert.match(r['url-codec'].encoded, /%D9/); assert.equal(r['html-entities'].decoded, r.input); assert.match(r['html-entities'].encoded, /&lt;script&gt;/); assert.equal(r.invalid, true); return { codecs: 2, arabicRoundTrips: true, invalidRejected: true };
  });

  await test('V2 Data Lab applies edits, filtering, numeric sorting, column mapping and deduplication', async () => {
    const r = await evaluate(async () => {
      const csv = '\uFEFFname;score;note\r\nعلي;2;موافق\r\nنور;10;موافق\r\nعلي;2;موافق\r\nسارة;5;آخر\r\n';
      Q.files.table = new File([csv], 'جدول عربي.csv', { type: 'text/csv' });
      const out = (await Q.run('csv-studio', [Q.files.table], { delimiter: 'auto', header: true, columns: '2,1', rename: '1=الاسم\n2=النتيجة', filterColumn: 3, filterText: 'موافق', sortColumn: 2, sortDirection: 'descending', sortMode: 'numeric', deduplicate: true, output: 'json', cellEdits: [{ row: 1, column: 1, value: '12' }] }))[0];
      const csvOut = (await Q.run('csv-studio', [new File(['name,note\nعلي,=SUM(A1:A2)'], 'صيغ.csv')], { output: 'csv', header: true }))[0];
      return { data: JSON.parse(await out.blob.text()), keys: Object.keys(JSON.parse(await out.blob.text())[0]), info: out.info, safeCSV: await csvOut.blob.text() };
    });
    assert.deepEqual(r.keys, ['النتيجة', 'الاسم']); assert.deepEqual(r.data, [{ النتيجة: '12', الاسم: 'نور' }, { النتيجة: '2', الاسم: 'علي' }]); assert.match(r.info, /1 صف مكرر/); assert.match(r.safeCSV, /'=SUM/); return { rows: r.data.length, columns: r.keys, duplicateRemoved: 1, formulaProtected: true };
  });
  await test('V2 NDJSON interchange keeps nested values and reports malformed source line', async () => {
    const r = await evaluate(async () => {
      const source = [{ اسم: 'علي', nested: [1, true] }, null, 5, 'نص'];
      const lines = (await Q.run('json-ndjson', [new File([JSON.stringify(source)], 'قيم.json')]))[0];
      const back = (await Q.run('ndjson-json', [new File([lines.blob], 'قيم.ndjson')]))[0];
      let error = ''; try { await Q.run('ndjson-json', [new File(['{"a":1}\n{"b":}'], 'تالف.ndjson')]); } catch (e) { error = e.message; }
      let duplicateError = ''; try { await Q.run('json-format', [new File(['{"a":1,"a":2}'], 'مكرر.json')]); } catch (e) { duplicateError = e.message; }
      return { source, back: JSON.parse(await back.blob.text()), lines: (await lines.blob.text()).trim().split('\n').length, error, duplicateError };
    });
    assert.deepEqual(r.back, r.source); assert.equal(r.lines, 4); assert.match(r.error, /2/); assert.match(r.error, /[\u0600-\u06ff]/); assert.match(r.duplicateError, /[\u0600-\u06ff]/); return { lines: r.lines, invalidLineReported: true, duplicateKeysRejected: true };
  });
  await test('V2 data batch isolates corrupt member while preserving valid outputs', async () => {
    const r = await evaluate(async () => {
      const outputs = await Q.run('json-format', [new File(['{"صحيح":1}'], 'صحيح.json'), new File(['{bad'], 'تالف.json'), new File(['[2,3]'], 'آخر.json')]);
      const values = []; for (const out of outputs) values.push(JSON.parse(await out.blob.text()));
      return { count: outputs.length, errors: outputs.errors, values };
    });
    assert.equal(r.count, 2); assert.deepEqual(r.values, [{ صحيح: 1 }, [2, 3]]); assert.equal(r.errors.length, 1); return { outputs: r.count, isolatedErrors: r.errors.length };
  });
  await test('V2 structured-data guards reject depth, precision loss and excessive formatted output', async () => {
    const r = await evaluate(async () => {
      const inputs = [
        '['.repeat(151) + '0' + ']'.repeat(151),
        '{"n":0.1000000000000000001}',
        '{"x":1,"\\u0078":2}',
        '['.repeat(100) + '[' + Array(150000).fill('0').join(',') + ']' + ']'.repeat(100),
      ], messages = [];
      for (const source of inputs) { try { await Q.run('json-format', [new File([source], 'بيانات.json')], { mode: 'pretty' }); messages.push('UNEXPECTED SUCCESS'); } catch (e) { messages.push(e.message); } }
      const safe = (await Q.run('csv-json', [new File(['__proto__,value\nآمن,1'], 'مفاتيح.csv')], { header: true }))[0];
      return { messages, ownKey: Object.hasOwn(JSON.parse(await safe.blob.text())[0], '__proto__'), polluted: Object.prototype.polluted === true };
    });
    for (const message of r.messages) assert.match(message, /[\u0600-\u06ff]/); assert.equal(r.ownKey, true); assert.equal(r.polluted, false); return { rejectedCases: r.messages.length, prototypePreservedAsData: true };
  });
  await test('V2 cancelled pending jobs release source references and never expose outputs', async () => {
    const r = await evaluate(async () => {
      const file = new File(['private source'], 'خاص.txt'), record = await Hub.inspect(file);
      const job = Hub.enqueue('sha256', [file], {}, [record]);
      Hub.cancelJob(job.id);
      await Hub.tick();
      return { state: job.state, files: job.files.length, records: job.records.length, outputs: job.outputs.length, aborted: job.controller.signal.aborted };
    });
    assert.deepEqual(r, { state: 'cancelled', files: 0, records: 0, outputs: 0, aborted: true }); return r;
  });
  await test('V2 partial batches track exact source indices and retry only the failed duplicate filename', async () => {
    const id = await evaluate(() => Hub.enqueue('csv-json', [new File(['a,b\nx,1'], 'اسم متكرر.csv'), new File(['a,b\n"broken'], 'اسم متكرر.csv'), new File(['a,b\ny,2'], 'اسم متكرر.csv')], { header: true }).id);
    await page.waitForFunction(id => ['completed', 'failed'].includes(Hub.state.jobs.find(j => j.id === id)?.state), id);
    const original = await evaluate(id => { const j = Hub.state.jobs.find(j => j.id === id); return { state: j.state, outputs: j.outputs.length, errors: j.errors, fileStates: j.fileResults.map(f => f.state) }; }, id);
    assert.equal(original.state, 'completed'); assert.equal(original.outputs, 2); assert.equal(original.errors.length, 1); assert.equal(original.errors[0].index, 1); assert.deepEqual(original.fileStates, ['completed', 'failed', 'completed']);
    await evaluate(() => Hub.navigate('activity'));
    const previous = await evaluate(() => Hub.state.jobs.map(j => j.id));
    const failedPanel = page.locator('[data-job-id="' + id + '"] .job-errors'); await failedPanel.locator('summary').click();
    await failedPanel.locator('button').filter({ hasText: 'إعادة محاولة الملفات المتعذرة' }).click();
    await page.waitForFunction(ids => Hub.state.jobs.some(j => !ids.includes(j.id) && j.toolId === 'csv-json' && j.state === 'failed'), previous);
    const retried = await evaluate(async ids => { const j = Hub.state.jobs.find(j => !ids.includes(j.id) && j.toolId === 'csv-json'); return { state: j.state, count: j.files.length, content: await j.files[0].text(), outputs: j.outputs.length }; }, previous);
    assert.equal(retried.count, 1); assert.equal(retried.content, 'a,b\n"broken'); assert.equal(retried.outputs, 0); return { successfulOutputs: original.outputs, failedIndex: original.errors[0].index, perFileStates: original.fileStates, retryInputs: retried.count, retryState: retried.state };
  });

  await test('V2 BMP encoder writes a valid BMP with correct geometry and pixel content', async () => {
    const r = await evaluate(async () => {
      const out = (await Q.run('image-transform', [await Q.image('بي إم بي.png', 12, 8)], { format: 'image/bmp', background: '#ffffff' }))[0];
      const v = new DataView(await out.blob.arrayBuffer());
      const p = await Q.pixels(out.blob);
      return { signature: v.getUint16(0, true), recordedSize: v.getUint32(2, true), bytes: out.blob.size, width: v.getInt32(18, true), height: Math.abs(v.getInt32(22, true)), decodedWidth: p.width, pixel: p.pixels.slice(0, 4), type: out.blob.type };
    });
    assert.equal(r.signature, 0x4d42); assert.equal(r.recordedSize, r.bytes); assert.equal(r.width, 12); assert.equal(r.height, 8); assert.equal(r.decodedWidth, 12); assert.deepEqual(r.pixel, [128, 64, 32, 255]); assert.equal(r.type, 'image/bmp'); return r;
  });
  await test('V2 advanced image controls change real pixels, alpha and aspect ratio', async () => {
    const r = await evaluate(async () => {
      const f = await Q.image('تأثيرات.png', 120, 80), read = async opts => Q.pixels((await Q.run('image-transform', [f], { format: 'image/png', ...opts }))[0].blob);
      const original = await read({}), bright = await read({ brightness: 150 }), exposure = await read({ exposure: 1 }), gray = await read({ grayscale: 100 }), sepia = await read({ sepia: 100 }), saturation = await read({ saturation: 0 }), contrast = await read({ contrast: 200 }), rounded = await read({ corners: 20 }), border = await read({ border: 6, borderColor: '#ff0000' }), aspect = await read({ aspect: '1:1' }), sharpened = await read({ sharpen: 1 }), watermark = await read({ watermark: 'نص عربي', watermarkSize: 24, watermarkColor: '#ff0000', watermarkOpacity: 1, watermarkPosition: 'center' });
      const diff = p => p.pixels.reduce((count, value, i) => count + (value !== original.pixels[i] ? 1 : 0), 0);
      return { original: original.pixels.slice(0, 4), bright: bright.pixels.slice(0, 4), exposure: exposure.pixels.slice(0, 4), gray: gray.pixels.slice(0, 4), saturation: saturation.pixels.slice(0, 4), sepiaChanged: diff(sepia), contrastChanged: diff(contrast), alpha: rounded.pixels[3], border: border.pixels.slice(0, 4), aspect: { width: aspect.width, height: aspect.height }, sharpenChanged: diff(sharpened), watermarkChanged: diff(watermark) };
    });
    assert.ok(r.bright[0] > r.original[0]); assert.ok(r.exposure[1] > r.original[1]); assert.ok(Math.abs(r.gray[0] - r.gray[1]) <= 1 && Math.abs(r.gray[1] - r.gray[2]) <= 1); assert.ok(Math.abs(r.saturation[0] - r.saturation[1]) <= 1); assert.ok(r.sepiaChanged > 0 && r.contrastChanged > 0 && r.sharpenChanged > 0 && r.watermarkChanged > 0); assert.equal(r.alpha, 0); assert.deepEqual(r.border, [255, 0, 0, 255]); assert.deepEqual(r.aspect, { width: 80, height: 80 }); return r;
  });
  await test('V2 image batches isolate damaged images and retain valid encoded outputs', async () => {
    const r = await evaluate(async () => {
      const f = await Q.image(), outputs = await Q.run('image-transform', [f, new File(['not an image'], 'تالف.png'), f], { format: 'image/webp', quality: 0.7 });
      const dimensions = []; for (const o of outputs) dimensions.push(await Q.dimensions(o.blob));
      return { count: outputs.length, errors: outputs.errors, dimensions };
    });
    assert.equal(r.count, 2); assert.equal(r.errors.length, 1); for (const d of r.dimensions) assert.deepEqual(d, { width: 120, height: 80 }); return { successes: r.count, isolatedFailures: r.errors.length };
  });
  await test('V2 images to PDF keeps custom page sizes, selected rotations and source resolution', async () => {
    const r = await evaluate(async () => {
      const inputs = [await Q.image('عريضة.png', 120, 80), await Q.image('طويلة.png', 40, 60)];
      const out = (await Q.run('images-pdf', inputs, { paper: 'custom', pageWidth: 100, pageHeight: 150, orientation: 'portrait', margin: 10, fitting: 'cover', imageFormat: 'image/png', maxDimension: 0, rotations: { 0: 90 }, name: 'صور مرتبة' }))[0];
      const lib = await Hub.deps.load('pdfLib'), pdf = await lib.PDFDocument.load(await out.blob.arrayBuffer()), images = [];
      for (const [, object] of pdf.context.enumerateIndirectObjects()) if (object.dict?.get(lib.PDFName.of('Subtype'))?.toString() === '/Image') images.push({ width: object.dict.get(lib.PDFName.of('Width')).asNumber(), height: object.dict.get(lib.PDFName.of('Height')).asNumber() });
      return { pages: pdf.getPages().map(p => ({ width: p.getWidth(), height: p.getHeight() })), images, name: out.name };
    });
    assert.equal(r.pages.length, 2); for (const p of r.pages) { assert.ok(Math.abs(p.width - 100 * 72 / 25.4) < 0.01); assert.ok(Math.abs(p.height - 150 * 72 / 25.4) < 0.01); }
    assert.ok(r.images.some(i => i.width === 80 && i.height === 120)); assert.ok(r.images.some(i => i.width === 40 && i.height === 60)); assert.match(r.name, /صور مرتبة/); return r;
  });
  await test('V2 functional image and data workflows produce valid final archives and honour cancellation', async () => {
    const r = await evaluate(async () => {
      const f = await Q.image(), out = (await Q.run('workflow-images', [f, f], { width: 60, height: 60, quality: 0.8 }))[0];
      const entries = await Q.run('zip-extract', [new File([out.blob], 'مسار صور.zip')]), dims = []; for (const e of entries) dims.push(await Q.dimensions(e.blob));
      const data = (await Q.run('workflow-data', [new File(['الاسم,القيمة\nعلي,2'], 'جدول.csv')], { delimiter: 'auto', header: true, asZip: true }))[0];
      const dataEntries = await Q.run('zip-extract', [new File([data.blob], 'مسار بيانات.zip')]);
      const ac = new AbortController(); ac.abort(); let cancelled = false; try { await Q.run('workflow-images', [f], {}, Q.ctx(ac.signal)); } catch (e) { cancelled = e.name === 'AbortError'; }
      return { dims, names: entries.map(e => e.name), data: JSON.parse(await dataEntries[0].blob.text()), cancelled };
    });
    assert.deepEqual(r.dims, [{ width: 60, height: 40 }, { width: 60, height: 40 }]); assert.equal(new Set(r.names).size, 2); assert.deepEqual(r.data, [{ الاسم: 'علي', القيمة: '2' }]); assert.equal(r.cancelled, true); return r;
  });

  await test('V2 smart search finds Arabic synonyms, English formats and categories immediately', async () => {
    await page.locator('[data-view="tools"]:visible').first().click();
    const searches = [['ضغط', 'image-transform'], ['PDF', 'pdf-merge'], ['صورة', 'image-transform'], ['waveform', 'audio-edit'], ['تشكيل', 'arabic-clean']];
    for (const [query, id] of searches) { await page.locator('#tool-search').fill(query); await page.waitForFunction(id => !!document.querySelector('#tool-grid [data-tool="' + id + '"]'), id); }
    await page.locator('#tool-search').fill(''); return { searches: searches.length };
  });
  await test('V2 compact cards, favorites and recent tool identifiers persist without source content', async () => {
    const before = await page.locator('#tool-grid').getAttribute('class'); await page.locator('#card-mode').click(); const after = await page.locator('#tool-grid').getAttribute('class'); assert.notEqual(before, after);
    const card = page.locator('#tool-grid article').filter({ has: page.locator('[data-tool="arabic-clean"]') });
    const favorite = card.locator('.favorite'); await favorite.click();
    await page.waitForFunction(() => Hub.state.favorites.includes('arabic-clean') && document.querySelector('#tool-grid .tool-card:has([data-tool="arabic-clean"]) .favorite')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true');
    const r = await evaluate(async () => {
      const job = Hub.enqueue('json-format', [new File(['{"private":"never persist me"}'], 'private-source.json')], {}); return { id: job.id, favorite: Hub.state.favorites.includes('arabic-clean') };
    });
    await page.waitForFunction(id => Hub.state.jobs.find(j => j.id === id)?.state === 'completed', r.id);
    const check = await freshPage();
    const persisted = await check.evaluate(() => ({ favorites: Hub.state.favorites, recent: Hub.state.recent, files: Hub.state.files.length, outputs: Hub.state.outputs.length, storage: JSON.stringify(localStorage) }));
    await check.close(); assert.ok(persisted.favorites.includes('arabic-clean')); assert.ok(persisted.recent.includes('json-format')); assert.equal(persisted.files, 0); assert.equal(persisted.outputs, 0); assert.ok(!persisted.storage.includes('private-source.json') && !persisted.storage.includes('never persist me')); return { favoritePersisted: true, recentPersisted: true, sourcePersisted: false };
  });
  await test('V2 live image comparison encodes an output and exposes an accessible working slider', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([await Q.image('مقارنة.png')]); Hub.openTool(Hub.tools.find(t => t.id === 'image-transform')); });
    await page.locator('#tool-panel button').filter({ hasText: 'إنشاء مقارنة فعلية' }).click();
    await page.waitForFunction(() => !document.querySelector('.image-compare-control input')?.disabled);
    const slider = page.locator('.image-compare-control input'); await slider.fill('80'); await slider.dispatchEvent('input');
    const r = await evaluate(() => ({ images: [...document.querySelectorAll('.image-compare img')].filter(i => i.complete && i.naturalWidth > 0).length, clip: document.querySelector('.image-compare img[alt="معاينة الصورة بعد تطبيق الإعدادات"]').style.clipPath, sizeReported: document.querySelector('.image-editor').textContent.includes('الناتج الفعلي') }));
    assert.equal(r.images, 2); assert.match(r.clip, /20%/); assert.equal(r.sizeReported, true); await page.keyboard.press('Escape'); return r;
  });
  await test('V2 quality controls retain the saved value and update exact percentage readouts', async () => {
    await evaluate(() => Hub.openTool(Hub.tools.find(t => t.id === 'image-transform')));
    const saved = await evaluate(() => Hub.state.settings.quality);
    assert.equal(Number(await page.locator('#option-quality').inputValue()), saved);
    await page.locator('#option-quality').fill('0.73'); await page.locator('#option-quality').dispatchEvent('input');
    assert.equal(await page.locator('[data-field="quality"] output').textContent(), '73%');
    await page.keyboard.press('Escape'); return { saved, selected: 0.73, displayed: '73%' };
  });
  await test('V2 audio waveform accepts range and keyboard alternatives with large touch handles', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([Q.wav()]); Hub.openTool(Hub.tools.find(t => t.id === 'audio-edit')); });
    const start = page.locator('.audio-studio input[aria-label="بداية المقطع بالثواني"]');
    await page.waitForFunction(() => !document.querySelector('.audio-studio input[aria-label="بداية المقطع بالثواني"]')?.disabled);
    await start.fill('0.25'); await start.dispatchEvent('input'); assert.equal(await page.locator('#option-start').inputValue(), '0.25');
    await page.locator('#option-end').fill('1.5'); await page.locator('#option-end').dispatchEvent('change');
    const r = await evaluate(() => ({ end: document.querySelector('.audio-studio input[aria-label="نهاية المقطع بالثواني"]').value, canvasWidth: document.querySelector('.audio-studio canvas').width, handles: [...document.querySelectorAll('.audio-marker')].map(b => b.getBoundingClientRect().width) }));
    assert.equal(Number(r.end), 1.5); assert.ok(r.canvasWidth > 0); assert.deepEqual(r.handles, [44, 44]);
    await page.locator('.audio-studio button').filter({ hasText: 'تشغيل الجزء المحدد' }).click();
    await page.waitForFunction(() => document.querySelector('.audio-studio').textContent.includes('إيقاف المعاينة'));
    await page.keyboard.press('Escape'); return r;
  });
  await test('V2 Data Lab editable table exports the actual edited cell through the processing queue', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([Q.files.table]); Hub.openTool(Hub.tools.find(t => t.id === 'csv-studio')); });
    const cell = page.locator('.data-grid tbody input').first(); await cell.waitFor(); await cell.fill('اسم محرر');
    await page.locator('#option-output').selectOption('json');
    const previous = await evaluate(() => Hub.state.jobs.map(j => j.id)); await page.locator('#run-tool').click();
    await page.waitForFunction(ids => Hub.state.jobs.some(j => !ids.includes(j.id) && j.toolId === 'csv-studio' && ['completed', 'failed'].includes(j.state)), previous);
    const r = await evaluate(async ids => { const job = Hub.state.jobs.find(j => !ids.includes(j.id) && j.toolId === 'csv-studio'); return { state: job.state, message: job.message, values: job.outputs.length ? JSON.parse(await job.outputs[0].blob.text()) : null }; }, previous);
    assert.equal(r.state, 'completed', r.message); assert.equal(r.values[0].name, 'اسم محرر'); return { state: r.state, firstName: r.values[0].name };
  });
  await test('V2 PDF visual organizer exports the actual selected order and rotation', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([Q.files['صفحات.pdf']]); Hub.openTool(Hub.tools.find(t => t.id === 'pdf-organize')); });
    await page.locator('[data-pdf-pages] [data-page="1"]').waitFor();
    await page.locator('[data-pdf-pages] [aria-label="نقل الصفحة 3 إلى الأعلى"]').click();
    await page.locator('[data-pdf-pages] [aria-label="نقل الصفحة 3 إلى الأعلى"]').click();
    await page.locator('[data-pdf-pages] [aria-label="تدوير الصفحة 3 بمقدار 90 درجة"]').click();
    await page.locator('[data-pdf-pages] [aria-label="اختيار الصفحة 2"]').uncheck();
    const previous = await evaluate(() => Hub.state.jobs.map(j => j.id)); await page.locator('#run-tool').click();
    await page.waitForFunction(ids => Hub.state.jobs.some(j => !ids.includes(j.id) && j.toolId === 'pdf-organize' && ['completed', 'failed'].includes(j.state)), previous);
    const r = await evaluate(async ids => { const job = Hub.state.jobs.find(j => !ids.includes(j.id) && j.toolId === 'pdf-organize'); if (job.state !== 'completed') throw new Error(job.message); const doc = await (await Hub.deps.load('pdfLib')).PDFDocument.load(await job.outputs[0].blob.arrayBuffer()); return doc.getPages().map(p => ({ width: p.getWidth(), rotation: p.getRotation().angle })); }, previous);
    assert.deepEqual(r, [{ width: 330, rotation: 90 }, { width: 310, rotation: 0 }]); return r;
  });
  await test('V2 searchable archive picker exports the renamed selected entry', async () => {
    await evaluate(async () => { Hub.state.files = []; await Hub.addFiles([Q.files.zip]); Hub.openTool(Hub.tools.find(t => t.id === 'zip-extract')); });
    await page.locator('#zip-entry-search').waitFor(); await page.locator('#zip-entry-search').fill('مضغوط'); assert.equal(await page.locator('[data-zip-index]').count(), 1);
    await page.locator('#zip-entry-name-0').fill('مجلد/اسم من الواجهة.txt');
    const previous = await evaluate(() => Hub.state.jobs.map(j => j.id)); await page.locator('#run-tool').click();
    await page.waitForFunction(ids => Hub.state.jobs.some(j => !ids.includes(j.id) && j.toolId === 'zip-extract' && ['completed', 'failed'].includes(j.state)), previous);
    const r = await evaluate(async ids => { const j = Hub.state.jobs.find(j => !ids.includes(j.id) && j.toolId === 'zip-extract'); return { state: j.state, message: j.message, name: j.outputs[0]?.name, path: j.outputs[0]?.archivePath, bytes: j.outputs[0]?.blob.size }; }, previous);
    assert.equal(r.state, 'completed', r.message); assert.match(r.name, /اسم من الواجهة/); assert.ok(r.bytes > 0); return { state: r.state, name: r.name, path: r.path, bytes: r.bytes };
  });
  await test('V2 QR dialog supports direct text with zero source files and validates the generated PNG', async () => {
    await evaluate(() => { Hub.state.files = []; Hub.emit(); Hub.openTool(Hub.tools.find(t => t.id === 'qr-generate')); });
    assert.equal(await page.locator('#run-tool').isDisabled(), false); await page.locator('#option-text').fill('رمز من الواجهة 123');
    const previous = await evaluate(() => Hub.state.jobs.map(j => j.id)); await page.locator('#run-tool').click();
    await page.waitForFunction(ids => Hub.state.jobs.some(j => !ids.includes(j.id) && j.toolId === 'qr-generate' && ['completed', 'failed'].includes(j.state)), previous);
    const r = await evaluate(async ids => { const j = Hub.state.jobs.find(j => !ids.includes(j.id) && j.toolId === 'qr-generate'); if (j.state !== 'completed') throw new Error(j.message); const p = await Q.pixels(j.outputs[0].blob); return { state: j.state, text: jsQR(new Uint8ClampedArray(p.pixels), p.width, p.height)?.data }; }, previous);
    assert.equal(r.state, 'completed'); assert.equal(r.text, 'رمز من الواجهة 123'); return r;
  });
  await test('V2 mobile and tablet sections and populated tool dialogs stay inside the viewport', async () => {
    const sizes = [[360, 800], [412, 915], [915, 412], [800, 1280], [1280, 800]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const view of ['home', 'tools', 'documents', 'data', 'media', 'workflows', 'activity', 'settings']) {
        await evaluate(view => Hub.navigate(view), view);
        const r = await evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth, dir: getComputedStyle(document.body).direction }));
        assert.ok(r.content <= r.viewport + 1, `${view} overflow at ${width}x${height}: ${r.content}`); assert.equal(r.dir, 'rtl');
      }
      await evaluate(() => Hub.openTool(Hub.tools.find(t => t.id === 'csv-studio')));
      const d = await page.locator('#tool-dialog').evaluate(node => ({ right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left, scroll: node.scrollWidth, width: node.clientWidth }));
      assert.ok(d.left >= 0 && d.right <= width + 1, `Dialog outside ${width}px viewport`); assert.ok(d.scroll <= d.width + 1, `Dialog horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(artifacts, `v2-dialog-${width}x${height}.png`) }); await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 412, height: 915 }); return { sizes: sizes.length, viewsPerSize: 8, dialogChecks: sizes.length };
  });

  await test('V2 has no uncaught runtime errors or non-GET file requests', async () => {
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(requests.filter(r => !['GET', 'HEAD'].includes(r.method) || /invalid\.example/.test(r.url)), []);
  });
  const summary = {
    timestamp: new Date().toISOString(), mode: 'production index.html V2 regression', chromium: browser.version(), playwright: require('playwright/package.json').version,
    cdn: useCachedCDN ? 'Pinned CDN bytes from integrity-checked test cache' : 'Live CDN', physicalDeviceTesting: false, touchHardwareEmulation: true,
    passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, results,
    testedArtifact: { filename: 'index.html', bytes: fs.statSync(htmlPath).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex') },
  };
  fs.writeFileSync(path.join(artifacts, 'v2-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, chromium: summary.chromium }, null, 2));
  if (summary.failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });
