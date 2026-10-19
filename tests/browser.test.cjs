'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const htmlPath = process.env.HUB_TEST_HTML || path.join(root, 'index.html');
const moduleHarness = process.env.HUB_TEST_MODULES === '1';
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const results = [];
const errors = [];
const requests = [];
let browser, context, page, server;
const useCachedCDN = process.env.HUB_TEST_CACHE_CDN === '1';
const cache = path.join(__dirname, '.cache');
const dependencyPaths = [
  ['pdf-lib@1.17.1/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['pdfjs-dist@5.7.284/legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist@5.7.284/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['fflate@0.8.2/umd/index.js', 'fflate.min.js'],
];
async function installRoutes(target) {
  if (!useCachedCDN) return;
  await target.route('https://cdn.jsdelivr.net/**', async route => {
    const file = dependencyPaths.find(([fragment]) => route.request().url().includes(fragment));
    if (!file || !fs.existsSync(path.join(cache, file[1]))) return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cache, file[1])), headers: { 'access-control-allow-origin': '*' } });
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
  }
}
async function evaluate(fn, arg) { return page.evaluate(fn, arg); }
async function main() {
  assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
  server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/' && req.url.split('?')[0] !== '/index.html') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(htmlPath).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 412, height: 915 }, acceptDownloads: true, locale: 'ar-KW', reducedMotion: 'reduce' });
  await installRoutes(context);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  const start = performance.now();
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.Hub?.tools?.length > 0);
  const bootMs = Math.round(performance.now() - start);
  await evaluate(() => {
    window.__qa = {
      files: {}, out: {},
      ctx(signal) { return { signal: signal || new AbortController().signal, settings: { maxFileMB: 100, maxArchiveMB: 200, maxEntries: 1000, quality: 0.85, format: 'image/webp', concurrency: 1 }, records: [], progress() {}, stage() {} }; },
      async run(id, files, options = {}, signal) {
        const tool = Hub.tools.find(tool => tool.id === id);
        if (!tool) throw new Error(`Missing tool ${id}`);
        return tool.run(files, options, this.ctx(signal));
      },
      async image(name, width = 640, height = 480) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const c = canvas.getContext('2d');
        const gradient = c.createLinearGradient(0, 0, width, height); gradient.addColorStop(0, '#3176e8'); gradient.addColorStop(1, '#e43a92'); c.fillStyle = gradient; c.fillRect(0, 0, width, height);
        c.fillStyle = '#fff'; c.fillRect(20, 20, 150, 100);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        canvas.width = canvas.height = 1;
        return this.files[name] = new File([blob], name, { type: 'image/png' });
      },
      async pdf(name, widths) {
        const pdf = await (await Hub.deps.load('pdfLib')).PDFDocument.create();
        for (const width of widths) pdf.addPage([width, 600]);
        return this.files[name] = new File([await pdf.save()], name, { type: 'application/pdf' });
      },
      async dimensions(blob) { const b = await createImageBitmap(blob); const d = { width: b.width, height: b.height }; b.close(); return d; }
    };
  });
  await test('Arabic RTL shell and dependency laziness', async () => {
    const result = await evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, tools: Hub.tools.length, scriptSources: [...document.scripts].map(s => s.src).filter(Boolean), width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.equal(result.lang, 'ar'); assert.equal(result.dir, 'rtl'); assert.ok(result.tools >= 15); assert.ok(result.width <= result.viewport + 1);
    assert.ok(!result.scriptSources.some(src => /pdf-lib|fflate|pdfjs/.test(src)), 'heavy libraries must be lazy');
    return { bootMs, toolCount: result.tools };
  });
  await test('PNG → JPEG: valid encoding, Arabic filename', async () => {
    const result = await evaluate(async () => {
      const f = await __qa.image('صورة عربية.png');
      const output = (await __qa.run('image-transform', [f], { format: 'image/jpeg', quality: 0.85 }))[0];
      __qa.out.jpeg = output;
      return { ...await __qa.dimensions(output.blob), type: output.blob.type, name: output.name, bytes: [...new Uint8Array(await output.blob.slice(0, 3).arrayBuffer())] };
    });
    assert.equal(result.type, 'image/jpeg'); assert.deepEqual(result.bytes, [255, 216, 255]); assert.equal(result.width, 640); assert.equal(result.height, 480); assert.match(result.name, /صورة/);
    return result;
  });
  await test('PNG → WebP: reopen actual image', async () => {
    const result = await evaluate(async () => {
      const o = (await __qa.run('image-transform', [__qa.files['صورة عربية.png']], { format: 'image/webp', quality: 0.8 }))[0];
      return { ...await __qa.dimensions(o.blob), type: o.blob.type, signature: new TextDecoder().decode(await o.blob.slice(8, 12).arrayBuffer()) };
    });
    assert.equal(result.type, 'image/webp'); assert.equal(result.signature, 'WEBP'); assert.equal(result.width, 640); return result;
  });
  await test('Image resize, rotation, crop, compression and batch', async () => {
    const result = await evaluate(async () => {
      const f = __qa.files['صورة عربية.png'];
      const resized = (await __qa.run('image-transform', [f], { format: 'image/png', sizeMode: 'fit', width: 160, height: 160, preserveAspect: true }))[0];
      const rotated = (await __qa.run('image-transform', [f], { format: 'image/png', rotation: '90' }))[0];
      const crop = (await __qa.run('image-transform', [f], { format: 'image/png', crop: true, cropX: 10, cropY: 10, cropWidth: 100, cropHeight: 80 }))[0];
      const low = (await __qa.run('image-transform', [f], { format: 'image/jpeg', quality: 0.1 }))[0];
      const high = (await __qa.run('image-transform', [f], { format: 'image/jpeg', quality: 0.95 }))[0];
      const batch = await __qa.run('image-transform', [f, f], { format: 'image/webp' });
      return { resized: await __qa.dimensions(resized.blob), rotated: await __qa.dimensions(rotated.blob), crop: await __qa.dimensions(crop.blob), low: low.blob.size, high: high.blob.size, batch: batch.length };
    });
    assert.deepEqual(result.resized, { width: 160, height: 120 }); assert.deepEqual(result.rotated, { width: 480, height: 640 }); assert.deepEqual(result.crop, { width: 100, height: 80 }); assert.ok(result.low < result.high); assert.equal(result.batch, 2); return result;
  });
  await test('Multiple images → PDF: parse all pages', async () => {
    const result = await evaluate(async () => {
      const f2 = await __qa.image('ثانية.png', 240, 360);
      const o = (await __qa.run('images-pdf', [__qa.files['صورة عربية.png'], f2], { name: 'صور الاختبار' }))[0];
      __qa.out.imagesPdf = o;
      const pdf = await (await Hub.deps.load('pdfLib')).PDFDocument.load(await o.blob.arrayBuffer());
      return { pages: pdf.getPageCount(), size: o.blob.size, type: o.blob.type };
    });
    assert.equal(result.pages, 2); assert.equal(result.type, 'application/pdf'); return result;
  });
  // Additional module tests are appended below as the implementation contract settles.
  await test('PDF merge: preserves input/page order', async () => {
    const result = await evaluate(async () => {
      await __qa.pdf('الأول.pdf', [310, 320]); await __qa.pdf('الثاني.pdf', [330]);
      const o = (await __qa.run('pdf-merge', [__qa.files['الأول.pdf'], __qa.files['الثاني.pdf']]))[0];
      __qa.files['merged.pdf'] = new File([o.blob], 'merged.pdf', { type: 'application/pdf' });
      const pdf = await (await Hub.deps.load('pdfLib')).PDFDocument.load(await o.blob.arrayBuffer());
      return { pages: pdf.getPageCount(), widths: pdf.getPages().map(p => p.getWidth()) };
    });
    assert.equal(result.pages, 3); assert.deepEqual(result.widths, [310, 320, 330]); return result;
  });
  await test('PDF split and extract: parse generated outputs', async () => {
    const result = await evaluate(async () => {
      const f = __qa.files['merged.pdf']; const lib = await Hub.deps.load('pdfLib');
      const split = await __qa.run('pdf-split', [f], { pages: '', groupSize: 1 });
      const widths = [];
      for (const o of split) { const doc = await lib.PDFDocument.load(await o.blob.arrayBuffer()); widths.push(doc.getPages().map(p => p.getWidth())); }
      const grouped = await __qa.run('pdf-split', [f], { pages: '1-3', groupSize: 2 });
      const groupCounts = []; for (const o of grouped) groupCounts.push((await lib.PDFDocument.load(await o.blob.arrayBuffer())).getPageCount());
      const extracted = (await __qa.run('pdf-extract', [f], { pages: '3, 1' }))[0];
      const doc = await lib.PDFDocument.load(await extracted.blob.arrayBuffer());
      return { widths, groupCounts, extractedWidths: doc.getPages().map(p => p.getWidth()) };
    });
    assert.deepEqual(result.widths, [[310], [320], [330]]); assert.deepEqual(result.groupCounts, [2, 1]); assert.deepEqual(result.extractedWidths, [330, 310]); return result;
  });
  await test('PDF delete, reorder and rotate: validated page structures', async () => {
    const result = await evaluate(async () => {
      const f = __qa.files['merged.pdf']; const lib = await Hub.deps.load('pdfLib');
      async function read(id, options) { const o = (await __qa.run(id, [f], options))[0]; const pdf = await lib.PDFDocument.load(await o.blob.arrayBuffer()); return pdf.getPages().map(p => ({ width: p.getWidth(), rotation: p.getRotation().angle })); }
      return { deleted: await read('pdf-delete', { pages: '2' }), reordered: await read('pdf-reorder', { pages: '3, 1-2' }), rotated: await read('pdf-rotate', { pages: '2', angle: '90' }) };
    });
    assert.deepEqual(result.deleted.map(p => p.width), [310, 330]); assert.deepEqual(result.reordered.map(p => p.width), [330, 310, 320]); assert.deepEqual(result.rotated.map(p => p.rotation), [0, 90, 0]); return result;
  });
  await test('PDF rendering and embedded text extraction', async () => {
    const result = await evaluate(async () => {
      const lib = await Hub.deps.load('pdfLib'); const doc = await lib.PDFDocument.create(); const p = doc.addPage();
      p.drawText('Embedded test text', { x: 20, y: 100 });
      const file = new File([await doc.save()], 'embedded.pdf', { type: 'application/pdf' });
      const text = (await __qa.run('pdf-text', [file], { pages: '' }))[0];
      const rendered = await Hub.PDF.renderPage(file, 1, { signal: new AbortController().signal, maxWidth: 400 });
      return { text: await text.blob.text(), dimensions: await __qa.dimensions(rendered.blob), pages: rendered.pages };
    });
    assert.match(result.text, /Embedded test text/); assert.ok(result.dimensions.width > 0); assert.equal(result.pages, 1); return result;
  });
  await test('Malformed and empty PDF fail with Arabic errors', async () => {
    const result = await evaluate(async () => {
      const messages = [];
      for (const file of [new File(['%PDF-corrupt'], 'تالف.pdf'), new File([], 'فارغ.pdf')]) {
        try { await __qa.run('pdf-extract', [file], { pages: '1' }); messages.push('UNEXPECTED SUCCESS'); }
        catch (e) { messages.push(e.message); }
      }
      return messages;
    });
    assert.equal(result.length, 2); for (const m of result) assert.match(m, /[\u0600-\u06ff]/); return result;
  });
  await test('ZIP creation/extraction: UTF-8 filenames and byte equality', async () => {
    const result = await evaluate(async () => {
      const files = [new File(['مرحبا بالعالم'], 'رسالة عربية.txt', { type: 'text/plain' }), new File([new Uint8Array([0, 255, 17, 34])], 'binary.bin')];
      const o = (await __qa.run('zip-create', files, { prefix: 'مجلد' }))[0];
      const zipfile = new File([o.blob], 'أرشيف.zip', { type: 'application/zip' }); __qa.files.zip = zipfile;
      const info = await Hub.Archives.inspect(zipfile, __qa.ctx());
      const report = (await __qa.run('zip-inspect', [zipfile]))[0];
      if (!(await report.blob.text()).includes('رسالة عربية.txt')) throw new Error('ZIP inspection report lost Arabic entry name');
      const extracted = await __qa.run('zip-extract', [zipfile], { selection: 'all', asZip: false });
      const contents = [];
      for (const output of extracted) contents.push({ name: output.name, bytes: [...new Uint8Array(await output.blob.arrayBuffer())] });
      return { count: info.count, names: info.entries.map(e => e.name), contents };
    });
    assert.equal(result.count, 2); assert.ok(result.names.some(n => n.includes('رسالة عربية.txt'))); assert.ok(result.contents.some(o => o.bytes.join(',') === '0,255,17,34'));
    assert.ok(result.contents.some(o => Buffer.from(o.bytes).toString('utf8') === 'مرحبا بالعالم')); return { count: result.count, names: result.names };
  });
  await test('ZIP selected extraction and rebundling', async () => {
    const result = await evaluate(async () => {
      const selected = await __qa.run('zip-extract', [__qa.files.zip], { selection: '1', asZip: false });
      const repacked = await __qa.run('zip-extract', [__qa.files.zip], { selection: '1', asZip: true });
      const lib = await Hub.deps.load('zip'); const entries = Object.keys(lib.unzipSync(new Uint8Array(await repacked[0].blob.arrayBuffer())));
      return { selectedCount: selected.length, repackedCount: entries.length };
    });
    assert.equal(result.selectedCount, 1); assert.equal(result.repackedCount, 1); return result;
  });
  await test('ZIP security: traversal, decompressed-size and entry limits', async () => {
    const result = await evaluate(async () => {
      const lib = await Hub.deps.load('zip'); const messages = [];
      const cases = [
        { entries: { '../outside.txt': new Uint8Array([1]) }, settings: {} },
        { entries: { 'large.txt': new Uint8Array(2097152) }, settings: { maxArchiveMB: 1 } },
        { entries: { 'one.txt': new Uint8Array([1]), 'two.txt': new Uint8Array([2]) }, settings: { maxEntries: 1 } },
      ];
      for (const c of cases) {
        const f = new File([lib.zipSync(c.entries, { level: 0 })], 'test.zip'); const ctx = __qa.ctx(); Object.assign(ctx.settings, c.settings);
        try { await Hub.Archives.inspect(f, ctx); messages.push('UNEXPECTED SUCCESS'); } catch (e) { messages.push(e.message); }
      }
      return messages;
    });
    for (const m of result) assert.match(m, /[\u0600-\u06ff]/); return result;
  });
  await test('CSV → JSON: BOM, quotes, embedded commas/newlines, delimiter detection', async () => {
    const result = await evaluate(async () => {
      const csv = '\uFEFFname;note;code\r\n"سارة";"سطر أول\nسطر ثان، مع فاصلة";0012\r\n"O""Neil";"a,b";42';
      const o = (await __qa.run('csv-json', [new File([csv], 'بيانات.csv')], { delimiter: 'auto', header: true, numbers: true }))[0];
      return JSON.parse(await o.blob.text());
    });
    assert.equal(result.length, 2); assert.equal(result[0].name, 'سارة'); assert.equal(result[0].code, '0012'); assert.match(result[0].note, /\n/); assert.equal(result[1].name, 'O"Neil'); assert.equal(result[1].note, 'a,b'); assert.equal(result[1].code, 42); return { rows: result.length };
  });
  await test('JSON → CSV round trip and spreadsheet formula protection', async () => {
    const result = await evaluate(async () => {
      const rows = [{ name: 'علي', text: 'a,"b"\nc', n: 42 }, { name: 'نور', text: '=SUM(A1:A2)', n: 7 }];
      const o = (await __qa.run('json-csv', [new File([JSON.stringify(rows)], 'قيم.json')], { delimiter: 'comma', bom: true }))[0];
      const csv = await o.blob.text();
      const back = (await __qa.run('csv-json', [new File([csv], 'عوده.csv')], { delimiter: 'comma', header: true, numbers: true }))[0];
      return { csv, rows: JSON.parse(await back.blob.text()) };
    });
    assert.equal(result.rows[0].text, 'a,"b"\nc'); assert.equal(result.rows[0].name, 'علي'); assert.equal(result.rows[0].n, 42); assert.equal(result.rows[1].text, "'=SUM(A1:A2)"); assert.ok(!result.csv.includes(',=SUM')); return { rows: result.rows.length };
  });
  await test('JSON validation and corrupt CSV rejection', async () => {
    const result = await evaluate(async () => {
      const valid = (await __qa.run('json-format', [new File(['{"قيمة":[1,true,null]}'], 'صحيح.json')], { mode: 'pretty' }))[0];
      const messages = [];
      for (const [id, value, options] of [['json-format', '{"x":}', {}], ['csv-json', 'a,b\n"unterminated', { header: true }]]) {
        try { await __qa.run(id, [new File([value], 'invalid.txt')], options); messages.push('UNEXPECTED SUCCESS'); } catch (e) { messages.push(e.message); }
      }
      return { value: JSON.parse(await valid.blob.text()), messages };
    });
    assert.deepEqual(result.value, { قيمة: [1, true, null] }); for (const m of result.messages) assert.match(m, /[\u0600-\u06ff]/); return result.messages;
  });
  await test('SHA-256: known vectors, streaming boundary and duplicate content', async () => {
    const result = await evaluate(async () => {
      const reports = [];
      for (const [name, data] of [['empty', ''], ['abc', 'abc'], ['boundary', new Uint8Array(1048577).fill(97)]]) {
        const file = new File([data], name); const o = (await __qa.run('sha256', [file]))[0]; reports.push(await o.blob.text());
      }
      const duplicate = (await __qa.run('duplicates', [new File(['abc'], 'first.txt'), new File(['abc'], 'different-name.txt'), new File(['xyz'], 'first.txt')]))[0];
      return { reports, duplicate: await duplicate.blob.text() };
    });
    const crypto = require('node:crypto');
    const expected = [crypto.createHash('sha256').update('').digest('hex'), crypto.createHash('sha256').update('abc').digest('hex'), crypto.createHash('sha256').update(Buffer.alloc(1048577, 97)).digest('hex')];
    result.reports.forEach((r, i) => assert.ok(r.includes(expected[i]))); assert.match(result.duplicate, /different-name.txt/); assert.match(result.duplicate, /2 ملفات/); return { knownVectors: expected.length };
  });
  await test('Base64 binary round trip and invalid input rejection', async () => {
    const result = await evaluate(async () => {
      const original = new File([new Uint8Array([0, 255, 1, 128, 7])], 'binary.bin');
      const encoded = (await __qa.run('base64-encode', [original]))[0];
      const decoded = (await __qa.run('base64-decode', [new File([encoded.blob], 'encoded.txt')], { filename: 'مستعاد.bin' }))[0];
      let rejected = false; try { await __qa.run('base64-decode', [new File(['AB=='], 'bad.txt')]); } catch { rejected = true; }
      return { bytes: [...new Uint8Array(await decoded.blob.arrayBuffer())], rejected, name: decoded.name };
    });
    assert.deepEqual(result.bytes, [0, 255, 1, 128, 7]); assert.equal(result.rejected, true); assert.equal(result.name, 'مستعاد.bin'); return result;
  });
  await test('XML validation and inert uploaded HTML', async () => {
    const result = await evaluate(async () => {
      window.__uploadedExecuted = false;
      const content = '<html><body><script>window.__uploadedExecuted=true</script><img src="https://invalid.example/private"><p>نص آمن</p></body></html>';
      const html = (await __qa.run('html-text', [new File([content], 'untrusted.html')]))[0];
      const xml = (await __qa.run('xml-format', [new File(['<root><a>نص</a></root>'], 'safe.xml')]))[0];
      let dtdRejected = false; try { await __qa.run('xml-format', [new File(['<!DOCTYPE root [<!ENTITY ext SYSTEM "file:///etc/passwd">]><root>&ext;</root>'], 'bad.xml')]); } catch { dtdRejected = true; }
      return { html: await html.blob.text(), xml: await xml.blob.text(), executed: window.__uploadedExecuted, dtdRejected };
    });
    assert.match(result.html, /نص آمن/); assert.ok(!result.html.includes('__uploadedExecuted')); assert.equal(result.executed, false); assert.equal(result.dtdRejected, true); return { html: result.html, dtdRejected: result.dtdRejected };
  });
  await test('Image errors: corrupt, empty, unsupported and long filenames', async () => {
    const result = await evaluate(async () => {
      const errors = [];
const requests = [];
      for (const f of [new File(['badpng'], 'تالف.png', { type: 'image/png' }), new File([], 'فارغ.png', { type: 'image/png' }), new File(['unsupported'], 'file.xyz')]) {
        try { await __qa.run('image-transform', [f], { format: 'image/jpeg' }); errors.push('UNEXPECTED SUCCESS'); } catch (e) { errors.push(e.message); }
      }
      const long = new File([__qa.files['صورة عربية.png']], 'صورة-'.repeat(80) + '.png', { type: 'image/png' });
      const output = (await __qa.run('image-transform', [long], { format: 'image/jpeg' }))[0];
      return { errors, name: output.name, dimensions: await __qa.dimensions(output.blob) };
    });
    for (const m of result.errors) assert.match(m, /[\u0600-\u06ff]/); assert.match(result.name, /\.jpe?g$/); assert.equal(result.dimensions.width, 640); return { errors: result.errors, filenameLength: result.name.length };
  });
  await test('Cancellation before processing: no output is returned', async () => {
    const result = await evaluate(async () => {
      const controller = new AbortController(); controller.abort(); const names = [];
      for (const id of ['image-transform', 'pdf-extract', 'sha256', 'zip-create']) {
        const files = id.startsWith('pdf-') ? [__qa.files['merged.pdf']] : [__qa.files['صورة عربية.png']];
        try { await __qa.run(id, files, {}, controller.signal); names.push('UNEXPECTED SUCCESS'); } catch (e) { names.push(e.name); }
      }
      return names;
    });
    assert.deepEqual(result, ['AbortError', 'AbortError', 'AbortError', 'AbortError']); return result;
  });
  await test('Image pixels: flip, JPEG background, inert SVG and EXIF orientation', async () => {
    const result = await evaluate(async () => {
      async function pixels(blob) {
        const bitmap = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
        const g = c.getContext('2d'); g.drawImage(bitmap, 0, 0); bitmap.close();
        const p = [...g.getImageData(0, 0, 1, 1).data]; return { width: c.width, height: c.height, p };
      }
      const c = document.createElement('canvas'); c.width = 4; c.height = 2; const g = c.getContext('2d'); g.fillStyle = 'red'; g.fillRect(0, 0, 2, 2); g.fillStyle = 'blue'; g.fillRect(2, 0, 2, 2);
      const file = new File([await new Promise(r => c.toBlob(r))], 'pixels.png', { type: 'image/png' });
      const flip = (await __qa.run('image-transform', [file], { format: 'image/png', flipH: true }))[0];
      g.clearRect(0, 0, 4, 2);
      const transparent = new File([await new Promise(r => c.toBlob(r))], 'transparent.png', { type: 'image/png' });
      const background = (await __qa.run('image-transform', [transparent], { format: 'image/jpeg', background: '#00ff00', quality: 1 }))[0];
      window.__svgExecuted = false;
      const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>window.__svgExecuted=true</script><image href="https://invalid.example/private"/><rect width="20" height="10" fill="#ff0000"/></svg>'], 'untrusted.svg', { type: 'image/svg+xml' });
      const safeSvg = (await __qa.run('image-transform', [svg], { format: 'image/png' }))[0];
      c.width = 100; c.height = 50; g.fillStyle = 'red'; g.fillRect(0, 0, 100, 50);
      const jpg = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg'))).arrayBuffer());
      const exif = new Uint8Array([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
      const oriented = new File([jpg.slice(0, 2), exif, jpg.slice(2)], 'oriented.jpg', { type: 'image/jpeg' });
      const output = (await __qa.run('image-transform', [oriented], { format: 'image/png' }))[0];
      return { flip: await pixels(flip.blob), background: await pixels(background.blob), svg: await pixels(safeSvg.blob), svgExecuted: window.__svgExecuted, oriented: await __qa.dimensions(output.blob) };
    });
    assert.equal(result.flip.p[2], 255); assert.ok(result.background.p[1] >= 254); assert.equal(result.svg.width, 20); assert.equal(result.svg.p[0], 255); assert.equal(result.svgExecuted, false); assert.deepEqual(result.oriented, { width: 50, height: 100 }); return result;
  });
  await test('ZIP corrupted CRC is rejected during extraction', async () => {
    const message = await evaluate(async () => {
      const lib = await Hub.deps.load('zip'); const bytes = lib.zipSync({ 'data.txt': new Uint8Array([65, 66, 67]) }, { level: 0 });
      const view = new DataView(bytes.buffer); const offset = 30 + view.getUint16(26, true) + view.getUint16(28, true); bytes[offset] ^= 255;
      try { await __qa.run('zip-extract', [new File([bytes], 'tampered.zip')], { selection: 'all' }); return 'UNEXPECTED SUCCESS'; } catch (e) { return e.message; }
    });
    assert.match(message, /[\u0600-\u06ff]/); return message;
  });
  await test('Audio: inspect, trim, adjust gain and reopen PCM WAV', async () => {
    const result = await evaluate(async () => {
      const rate = 44100, length = rate * 2; const bytes = new Uint8Array(44 + length * 2); const view = new DataView(bytes.buffer);
      const str = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
      str(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, length * 2, true);
      for (let i = 0; i < length; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / rate * Math.PI * 2 * 440) * 10000), true);
      const file = new File([bytes], 'نغمة.wav', { type: 'audio/wav' });
      const before = await Hub.Media.inspect(file, 'audio', new AbortController().signal);
      const output = (await __qa.run('audio-edit', [file], { start: 0.5, end: 1.5, volume: 50 }))[0];
      const buffer = await output.blob.arrayBuffer(); const wav = new DataView(buffer); let maximum = 0;
      for (let i = 44; i < buffer.byteLength; i += 2) maximum = Math.max(maximum, Math.abs(wav.getInt16(i, true)));
      const after = await Hub.Media.inspect(output.blob, 'audio', new AbortController().signal);
      return { before: before.duration, after: after.duration, bytes: output.blob.size, rate: wav.getUint32(24, true), maximum };
    });
    assert.ok(Math.abs(result.before - 2) < 0.03); assert.ok(Math.abs(result.after - 1) < 0.03); assert.equal(result.bytes, 88244); assert.equal(result.rate, 44100); assert.ok(result.maximum > 4900 && result.maximum < 5100); return result;
  });
  await test('Video: native inspection and exact frame capture', async () => {
    const result = await evaluate(async bytes => {
      const file = new File([new Uint8Array(bytes)], 'فيديو.webm', { type: 'video/webm' });
      const metadata = await Hub.Media.inspect(file, 'video', new AbortController().signal);
      const output = (await __qa.run('video-frame', [file], { second: 1 }))[0];
      let invalidRejected = false;
      try { await __qa.run('video-frame', [file], { second: 800 }); } catch { invalidRejected = true; }
      return { duration: metadata.duration, ...await __qa.dimensions(output.blob), invalidRejected };
    }, [...fs.readFileSync(path.join(__dirname, 'fixtures', 'test-pattern.webm'))]);
    assert.equal(result.width, 160); assert.equal(result.height, 90); assert.ok(result.duration > 1); assert.equal(result.invalidRejected, true); return result;
  });
  await test('ZIP keeps legitimate empty entries and rejects conflicting names', async () => {
    const result = await evaluate(async () => {
      const zip = (await __qa.run('zip-create', [new File([], 'فارغ.txt')]))[0];
      const extracted = (await __qa.run('zip-extract', [new File([zip.blob], 'empty.zip')]))[0];
      let duplicateRejected = false;
      try { await __qa.run('zip-create', [new File(['a'], 'A.txt'), new File(['b'], 'a.txt')]); } catch { duplicateRejected = true; }
      return { emptyBytes: extracted.blob.size, allowEmpty: extracted.allowEmpty, duplicateRejected };
    });
    assert.equal(result.emptyBytes, 0); assert.equal(result.allowEmpty, true); assert.equal(result.duplicateRejected, true); return result;
  });
  await test('Text statistics, literal search, merge, split and encoding conversion', async () => {
    const result = await evaluate(async () => {
      const stats = (await __qa.run('text-stats', [new File(['مرحبا بكم\nمرحبا ثانية'], 'نص.txt')], { query: 'مرحبا' }))[0];
      const merged = (await __qa.run('text-merge', [new File(['أول'], '1.txt'), new File(['ثان'], '2.txt')], { separator: 'blank' }))[0];
      const original = 'a\r\nb\nc\rd';
      const split = await __qa.run('text-split', [new File([original], 'lines.txt')], { lines: 2 });
      const parts = []; for (const o of split) parts.push(await o.blob.text());
      const encoded = new File([new Uint8Array([0xe3, 0xd1, 0xcd, 0xc8, 0xc7])], 'arabic-windows.txt');
      const converted = (await __qa.run('text-encoding', [encoded], { encoding: 'windows-1256' }))[0];
      return { stats: await stats.blob.text(), merged: await merged.blob.text(), parts, original, utf8: await converted.blob.text() };
    });
    assert.match(result.stats, /الكلمات: 4/); assert.match(result.stats, /الأسطر: 2/); assert.match(result.stats, /مرات تطابق البحث: 2/);
    assert.equal(result.merged, 'أول\n\nثان'); assert.equal(result.parts.length, 2); assert.equal(result.parts.join(''), result.original); assert.equal(result.utf8, 'مرحبا'); return { parts: result.parts.length, encoding: result.utf8 };
  });
  await test('Arabic embedded PDF text: preserve words and render page', async () => {
    const fixturePage = await context.newPage();
    await fixturePage.setContent('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><style>body{font-family:"Noto Naskh Arabic",sans-serif;font-size:24px}</style><p>نص عربي لاختبار معالجة المستندات</p></html>');
    await fixturePage.evaluate(() => document.fonts.ready);
    const pdfBytes = await fixturePage.pdf({ format: 'A4' });
    await fixturePage.close();
    const result = await evaluate(async bytes => {
      const file = new File([new Uint8Array(bytes)], 'مستند عربي.pdf', { type: 'application/pdf' });
      const text = (await __qa.run('pdf-text', [file]))[0];
      const page = await Hub.PDF.renderPage(file, 1, { signal: new AbortController().signal, maxWidth: 400 });
      return { text: await text.blob.text(), dimensions: await __qa.dimensions(page.blob) };
    }, [...pdfBytes]);
    assert.match(result.text, /عربي/); assert.match(result.text, /المستندات/); assert.ok(result.dimensions.width > 0); return result;
  });
  if (!moduleHarness) {
    await test('Legacy/UTF-16 intake exposes encoding conversion with the correct default', async () => {
      const result = await evaluate(async () => {
        const tool = Hub.tools.find(t => t.id === 'text-encoding');
        const fixtures = [
          { name: 'ويندوز.txt', encoding: 'windows-1256', bytes: [0xe3, 0xd1, 0xcd, 0xc8, 0xc7] },
          { name: 'صغير.txt', encoding: 'utf-16le', bytes: [255, 254, 0x45, 6, 0x31, 6, 0x2d, 6, 0x28, 6, 0x27, 6] },
          { name: 'كبير.txt', encoding: 'utf-16be', bytes: [254, 255, 6, 0x45, 6, 0x31, 6, 0x2d, 6, 0x28, 6, 0x27] },
        ];
        const records = [];
        for (const fixture of fixtures) {
          const file = new File([new Uint8Array(fixture.bytes)], fixture.name);
          const record = await Hub.inspect(file);
          const output = (await __qa.run('text-encoding', [file], { encoding: record.encoding }))[0];
          records.push({ encoding: record.encoding, expectedEncoding: fixture.encoding, kind: record.kind, compatible: Hub.compatible(tool, record), warned: record.warnings.length > 0, text: await output.blob.text() });
        }
        return records;
      });
      for (const record of result) {
        assert.equal(record.kind, 'text'); assert.equal(record.encoding, record.expectedEncoding); assert.equal(record.compatible, true); assert.equal(record.warned, true); assert.equal(record.text, 'مرحبا');
      }
      const encodingPage = await context.newPage();
      await encodingPage.goto(origin, { waitUntil: 'load' });
      await encodingPage.locator('#file-input').setInputFiles([{ name: 'ترميز UTF16.txt', mimeType: 'text/plain', buffer: Buffer.from([255, 254, 0x45, 6, 0x31, 6, 0x2d, 6, 0x28, 6, 0x27, 6]) }]);
      await encodingPage.waitForFunction(() => Hub.state.files.some(r => r.encoding === 'utf-16le'));
      await encodingPage.locator('[data-tool="text-encoding"]').first().click();
      assert.equal(await encodingPage.locator('#option-encoding').inputValue(), 'utf-16le');
      await encodingPage.close();
      return { encodings: result.map(r => r.encoding), text: 'مرحبا', modalDefault: 'utf-16le' };
    });

    await test('Real upload → configure → process → valid browser download', async () => {
      const input = page.locator('#file-input');
      await input.setInputFiles([{ name: 'بيانات عربية.json', mimeType: 'application/json', buffer: Buffer.from('{"الاسم":"علي","القيم":[1,2,3]}') }]);
      await page.waitForFunction(() => Hub.state.files.some(r => r.file.name === 'بيانات عربية.json'));
      await page.locator('[data-tool="json-format"]').first().click();
      await page.locator('#run-tool').click();
      await page.waitForFunction(() => Hub.state.jobs.some(j => j.tool.id === 'json-format' && j.state === 'completed'));
      const downloadPromise = page.waitForEvent('download');
      await page.locator('[data-download]').first().click();
      const download = await downloadPromise;
      assert.equal(await download.failure(), null);
      const filename = path.join(artifacts, 'ui-download.json');
      await download.saveAs(filename);
      assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { الاسم: 'علي', القيم: [1, 2, 3] });
      return { suggestedFilename: download.suggestedFilename() };
    });
    await test('Output filename editing survives queue rendering and corrects extension', async () => {
      await page.locator('[data-view="activity"]:visible').first().click();
      const input = page.locator('[data-output-name]').first();
      await input.fill('اسم يدوي.exe');
      const id = await input.getAttribute('data-output-name');
      await evaluate(() => Hub.emit());
      const edited = page.locator('[data-output-name="' + id + '"]');
      assert.equal(await edited.inputValue(), 'اسم يدوي.exe');
      assert.equal(await edited.evaluate(node => document.activeElement === node), true);
      await edited.blur();
      const value = await edited.inputValue();
      assert.match(value, /\.json$/); assert.ok(!value.endsWith('.exe')); return { correctedName: value };
    });
    await test('Queue progress keeps completed outputs and file-list DOM stable', async () => {
      const result = await evaluate(async () => {
        const fileNode = document.querySelector('#file-list').firstElementChild;
        const outputNode = document.querySelector('[data-output-name]');
        if (!fileNode || !outputNode) throw new Error('Expected populated file and result lists');
        Hub.emit('jobs');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { fileStable: document.querySelector('#file-list').firstElementChild === fileNode, outputStable: document.querySelector('[data-output-name]') === outputNode };
      });
      assert.equal(result.fileStable, true); assert.equal(result.outputStable, true); return result;
    });
    await test('Image exact-size controls produce the requested output dimensions', async () => {
      const png = await evaluate(async () => [...new Uint8Array(await __qa.files['صورة عربية.png'].arrayBuffer())]);
      await page.locator('#file-input').setInputFiles([{ name: 'أبعاد.png', mimeType: 'image/png', buffer: Buffer.from(png) }]);
      await page.waitForFunction(() => Hub.state.files.some(r => r.file.name === 'أبعاد.png'));
      await page.locator('[data-view="tools"]:visible').first().click();
      await page.locator('[data-tool="image-transform"]').first().click();
      await page.locator('#option-sizeMode').selectOption('exact');
      assert.equal(await page.locator('#option-width').isVisible(), true);
      assert.equal(await page.locator('#option-height').isVisible(), true);
      await page.locator('#option-format').selectOption('image/png');
      await page.locator('#option-width').fill('120'); await page.locator('#option-height').fill('60');
      await page.locator('#option-preserveAspect').uncheck();
      const previous = await evaluate(() => Hub.state.jobs.map(j => j.id));
      await page.locator('#run-tool').click();
      await page.waitForFunction(previous => Hub.state.jobs.some(j => !previous.includes(j.id) && j.toolId === 'image-transform' && j.state === 'completed'), previous);
      const result = await evaluate(async previous => {
        const job = Hub.state.jobs.find(j => !previous.includes(j.id) && j.toolId === 'image-transform' && j.state === 'completed');
        return __qa.dimensions(job.outputs[0].blob);
      }, previous);
      assert.deepEqual(result, { width: 120, height: 60 }); return result;
    });
    await test('Queue deduplicates maximal-length output names without losing extension', async () => {
      const id = await evaluate(() => {
        const tool = { id: 'qa-output-name', name: 'اختبار أسماء النتائج', category: 'utilities', accept: ['any'], run: async () => [Hub.output(new Blob(['a']), 'س'.repeat(500) + '.txt'), Hub.output(new Blob(['b']), 'س'.repeat(500) + '.txt')] };
        return Hub.enqueue(tool, [new File(['seed'], 'seed.txt')]).id;
      });
      await page.waitForFunction(id => Hub.state.jobs.find(j => j.id === id)?.state === 'completed', id);
      const names = await evaluate(id => Hub.state.jobs.find(j => j.id === id).outputs.map(o => o.name), id);
      assert.equal(new Set(names).size, 2); for (const name of names) assert.match(name, /\.txt$/);
      await evaluate(id => {
        const job = Hub.state.jobs.find(j => j.id === id); const ids = new Set(job.outputs.map(o => o.id));
        Hub.state.outputs = Hub.state.outputs.filter(o => !ids.has(o.id)); Hub.state.jobs = Hub.state.jobs.filter(j => j.id !== id); Hub.emit();
      }, id);
      return { lengths: names.map(n => n.length), unique: true };
    });
    await test('Queue cancellation during streaming work and queued execution', async () => {
      const id = await evaluate(() => {
        const file = new File([new Uint8Array(20 * 1024 * 1024)], 'large.bin');
        const job = Hub.enqueue(Hub.tools.find(t => t.id === 'sha256'), [file], {});
        Hub.cancelJob(job.id); return job.id;
      });
      await page.waitForFunction(id => Hub.state.jobs.find(j => j.id === id)?.state === 'cancelled', id);
      assert.equal(await evaluate(id => Hub.state.jobs.find(j => j.id === id).state, id), 'cancelled');
      return { state: 'cancelled' };
    });
    await test('Mobile/tablet responsive layout, orientation and RTL stability', async () => {
      await page.locator('[data-view="home"]:visible').first().click();
      const sizes = [[360, 800], [412, 915], [915, 412], [800, 1280], [1280, 800]];
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(100);
        const layout = await evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth, dir: getComputedStyle(document.body).direction }));
        assert.ok(layout.content <= layout.viewport + 1, `Horizontal overflow at ${width}×${height}: ${layout.content}`); assert.equal(layout.dir, 'rtl');
        await page.screenshot({ path: path.join(artifacts, `layout-${width}x${height}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 412, height: 915 });
      return { viewports: sizes.length };
    });
    await test('Keyboard navigation and modal dismissal', async () => {
      await page.locator('[data-view="tools"]:visible').first().click();
      await page.keyboard.press('Tab');
      const tag = await evaluate(() => document.activeElement.tagName);
      assert.ok(['BUTTON', 'INPUT', 'A', 'SELECT', 'SUMMARY'].includes(tag));
      await page.locator('[data-tool="json-format"]').first().click();
      assert.equal(await page.locator('#run-tool').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#run-tool').isVisible(), false);
      return { keyboardFocusedTag: tag };
    });
    await test('Binary recognition overrides misleading extension and MIME', async () => {
      const result = await evaluate(async () => {
        const misleading = new File([__qa.files['صورة عربية.png']], 'ملف.txt', { type: 'text/plain' });
        const image = await Hub.inspect(misleading);
        const unknown = await Hub.inspect(new File([new Uint8Array([0, 1, 2, 255])], 'unknown.xyz'));
        const empty = await Hub.inspect(new File([], 'empty.png'));
        return { kind: image.kind, warnings: image.warnings, width: image.meta?.width, unknown: unknown.kind, emptyKind: empty.kind, emptyWarnings: empty.warnings };
      });
      assert.equal(result.kind, 'image'); assert.equal(result.width, 640); assert.ok(result.warnings.length > 0); assert.equal(result.unknown, 'unknown'); assert.equal(result.emptyKind, 'empty'); assert.ok(result.emptyWarnings.length > 0); return result;
    });
    await test('Batch browser download: ZIP has unique valid image results', async () => {
      const id = await evaluate(() => Hub.enqueue('image-transform', [__qa.files['صورة عربية.png'], __qa.files['صورة عربية.png']], { format: 'image/webp' }).id);
      await page.waitForFunction(id => Hub.state.jobs.find(j => j.id === id)?.state === 'completed', id);
      const names = await evaluate(id => Hub.state.jobs.find(j => j.id === id).outputs.map(o => o.name), id);
      assert.equal(new Set(names).size, 2);
      await page.locator('[data-view="activity"]:visible').first().click();
      const previous = await evaluate(() => Hub.state.jobs.map(j => j.id));
      await page.locator('#download-all').click();
      await page.waitForFunction(previous => Hub.state.jobs.some(j => !previous.includes(j.id) && j.toolId === 'zip-create' && j.state === 'completed'), previous);
      const outputId = await evaluate(previous => Hub.state.jobs.find(j => !previous.includes(j.id) && j.toolId === 'zip-create' && j.state === 'completed').outputs[0].id, previous);
      const downloadPromise = page.waitForEvent('download');
      await page.locator('[data-download="' + outputId + '"]').click();
      const download = await downloadPromise; const target = path.join(artifacts, 'batch-results.zip');
      await download.saveAs(target); assert.equal(await download.failure(), null);
      const result = await evaluate(async bytes => {
        const zip = (await Hub.deps.load('zip')).unzipSync(new Uint8Array(bytes));
        const keys = Object.keys(zip); let images = 0;
        for (const key of keys) if (/\.webp$/i.test(key)) { const b = await createImageBitmap(new Blob([zip[key]], { type: 'image/webp' })); if (b.width !== 640 || b.height !== 480) throw new Error('Batch image shape mismatch'); b.close(); images++; }
        return { count: keys.length, images };
      }, [...fs.readFileSync(target)]);
      assert.ok(result.count >= 3); assert.equal(result.images, 2); return result;
    });
    await test('Queue supports valid empty ZIP entries and sequential jobs', async () => {
      const ids = await evaluate(async () => {
        const zip = (await __qa.run('zip-create', [new File([], 'فارغ.txt')]))[0];
        const extraction = Hub.enqueue('zip-extract', [new File([zip.blob], 'empty.zip')], {});
        const hashing = Hub.enqueue('sha256', [new File(['abc'], 'abc.txt')], {});
        return [extraction.id, hashing.id];
      });
      await page.waitForFunction(ids => ids.every(id => Hub.state.jobs.find(j => j.id === id)?.state === 'completed'), ids);
      const result = await evaluate(ids => ids.map(id => { const j = Hub.state.jobs.find(j => j.id === id); return { state: j.state, bytes: j.outputs[0].blob.size }; }), ids);
      assert.equal(result[0].bytes, 0); assert.ok(result[1].bytes > 0); return result;
    });
    await test('Theme/preferences persist; private file contents do not persist', async () => {
      await page.locator('#theme-toggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      await page.locator('[data-view="settings"]:visible').first().click();
      const quality = page.locator('[data-preference="quality"]'); await quality.fill('77'); await quality.blur();
      await page.waitForFunction(() => Hub.state.settings.quality === 0.77);
      const persisted = await evaluate(() => JSON.stringify(localStorage));
      assert.ok(!persisted.includes('بيانات عربية.json')); assert.ok(!persisted.includes('القيم'));
      await page.screenshot({ path: path.join(artifacts, 'settings-light.png'), fullPage: true });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => Hub.state?.settings?.quality === 0.77);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      assert.equal(await evaluate(() => Hub.state.files.length), 0);
      await page.locator('#theme-toggle').click();
      return { quality: 0.77, privateFilesAfterReload: 0 };
    });
  }
  await test('Failed dependency loading: Arabic error, retry does not reuse rejection', async () => {
    const failureContext = await browser.newContext({ viewport: { width: 412, height: 915 } });
    await failureContext.route('https://cdn.jsdelivr.net/**', route => route.abort('failed'));
    const failurePage = await failureContext.newPage();
    await failurePage.goto(origin, { waitUntil: 'load' });
    const messages = await failurePage.evaluate(async () => {
      const messages = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await Hub.deps.load('pdfLib'); messages.push('UNEXPECTED SUCCESS'); } catch (e) { messages.push(e.message); }
      }
      return messages;
    });
    await failureContext.close();
    for (const message of messages) assert.match(message, /[\u0600-\u06ff]/); return messages;
  });
  await test('Uploaded HTML/SVG cannot request remote private resources; no file uploads', async () => {
    assert.deepEqual(requests.filter(r => r.url.includes('invalid.example') || !['GET', 'HEAD'].includes(r.method)), []);
  });
  await test('No uncaught browser exceptions', async () => { assert.deepEqual(errors, []); });
  const summary = {
    timestamp: new Date().toISOString(), mode: moduleHarness ? 'temporary module harness' : 'production index.html',
    chromium: browser.version(), playwright: require('playwright/package.json').version,
    cdn: useCachedCDN ? 'Exact pinned CDN bytes served by Playwright route from integrity-checked test cache' : 'Live CDN',
    physicalDeviceTesting: false, bootMs,
    passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length,
    results,
  };
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, chromium: summary.chromium, cdn: summary.cdn }, null, 2));
  if (summary.failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });
