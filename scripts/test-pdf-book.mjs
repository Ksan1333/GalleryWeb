// Actual PDF.js worker + application thumbnail/book renderers, isolated headless.
// The only PDF is synthesized in memory; no screenshots, desktop or user files.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");

function coloredPdf() {
  const colors = ["1 0 0", "0 1 0", "0 0 1"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>",
  ];
  for (const [index, color] of colors.entries()) {
    const stream = `${color} rg 0 0 200 300 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents ${4 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

const pdf = coloredPdf();
const server = await createServer({
  root, configFile: false, logLevel: "error",
  plugins: [{
    name: "export-private-pdf-renderers-for-test", enforce: "pre",
    transform(code, id) {
      const path = id.replaceAll("\\", "/").split("?")[0];
      if (path.endsWith("/src/components/MediaViewer.tsx")) return `${code}\nexport { BookViewer };`;
      if (path.endsWith("/src/components/MediaCollection.tsx")) return `${code}\nexport { PdfThumbnail };`;
    },
  }, react(), {
    name: "synthetic-pdf-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__colored.pdf", (_request, response) => {
        response.setHeader("Content-Type", "application/pdf");
        response.end(pdf);
      });
      vite.middlewares.use("/__pdf_test", (_request, response) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="ja"><body><div id="root"></div>
          <script type="module">
            import RefreshRuntime from '/@react-refresh';
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
            window.__vite_plugin_react_preamble_installed__ = true;
          </script><script type="module" src="/@vite/client"></script>
          <script type="module">
            import React from '/node_modules/.vite/deps/react.js';
            import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
            import {BookViewer} from '/src/components/MediaViewer.tsx';
            import {PdfThumbnail} from '/src/components/MediaCollection.tsx';
            import '/src/App.css';
            const {useRef, useState} = React;
            window.__pdf = {page:0, count:0, loading:true, error:null, cover:null};
            const item = {id:'synthetic-pdf', name:'Color fixture', kind:'pdf', path:location.origin+'/__colored.pdf',
              sizeBytes:${pdf.length}, modifiedAt:'2026-09-05', tags:[], favorite:false};
            const onCount = count => window.__pdf.count = count;
            const onLoading = loading => window.__pdf.loading = loading;
            const onError = error => window.__pdf.error = error;
            const onCover = cover => window.__pdf.cover = cover;
            const onCoverError = () => window.__pdf.coverError = true;
            const noop = () => {};
            function Fixture() {
              const [page, setPage] = useState(0);
              const [binding, setBinding] = useState('right');
              const [mode, setMode] = useState('single');
              const refs = useRef([]);
              window.__setBinding = setBinding; window.__setMode = setMode;
              window.__pdf.page = page;
              return React.createElement('main', null,
                React.createElement('section', {style:{height:700, display:'grid'}}, React.createElement(BookViewer, {
                  item, pageIndex:page, onPageIndexChange:setPage, canvasRefs:refs, onPageCountChange:onCount,
                  onLoadingChange:onLoading, onError, viewMode:mode, binding, menusHidden:false,
                  seekAnchors:[0,2], onSeekStart:noop,
                })), React.createElement(PdfThumbnail, {source:item.path, name:item.name, onRendered:onCover, onSourceError:onCoverError}));
            }
            const renderRoot = ReactDOM.createRoot(document.getElementById('root'));
            renderRoot.render(React.createElement(Fixture));
            window.__unmountPdf = () => renderRoot.unmount();
          </script></body></html>`);
      });
    },
  }],
  optimizeDeps: { force: true, entries: ["src/components/MediaViewer.tsx", "src/components/MediaCollection.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/src-tauri/**", "**/release/**"] } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    window.__pdfBlobUrls = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob.type.startsWith("image/")) window.__pdfBlobUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => { window.__pdfBlobUrls.delete(url); revoke(url); };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__pdf_test`);
  try {
    await page.waitForFunction(() => window.__pdf?.count === 3 && !window.__pdf.loading && window.__pdf.cover, undefined, { timeout: 30_000 });
  } catch (error) {
    console.error('PDF fixture state:', await page.evaluate(() => ({ ...window.__pdf, cover: Boolean(window.__pdf?.cover) })), runtimeErrors);
    throw error;
  }
  async function expectPages(numbers) {
    await page.waitForFunction((expected) => {
      const canvases = [...document.querySelectorAll('.pv-book-spread canvas')];
      return canvases.length === expected.length && canvases.every((canvas, slot) => {
        const rgb = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return rgb[expected[slot] - 1] > 240 && [...rgb].slice(0, 3).filter((channel) => channel < 20).length === 2;
      });
    }, numbers);
    assert.deepEqual(await page.locator('.pv-book-spread figcaption').allTextContents(), numbers.map(String));
  }
  await expectPages([1]);
  const seek = page.getByRole('slider', { name: 'ブックのページ位置' });
  assert.equal(await seek.getAttribute('dir'), 'rtl');
  await seek.press('ArrowLeft');
  await expectPages([2]);
  await seek.press('End');
  await expectPages([3]);
  await seek.press('Home');
  await expectPages([1]);
  assert.deepEqual(await page.locator('.pv-book-seek-anchor').evaluateAll((anchors) => anchors.map((anchor) => anchor.style.left)), ['100%', '0%']);
  await page.evaluate(() => window.__setBinding('left'));
  await page.waitForFunction(() => document.querySelector('.pv-book-page-seek input').dir === 'ltr');
  await seek.press('ArrowRight');
  await expectPages([2]);
  await seek.press('Home');
  await page.evaluate(() => { window.__setBinding('right'); window.__setMode('spread'); });
  await expectPages([2, 1]);
  assert.equal(await page.evaluate(() => Boolean(window.__pdf.error || window.__pdf.coverError)), false);
  assert.match(await page.evaluate(() => window.__pdf.cover), /^data:image\/jpeg;base64,/);
  await page.evaluate(() => window.__unmountPdf());
  await page.waitForFunction(() => window.__pdfBlobUrls.size === 0);
  assert.deepEqual(runtimeErrors, []);
  console.log('PASS actual PDF worker, thumbnail, 3-page color rendering, RTL/LTR seeking, spread order and image URL disposal');
} finally {
  await browser?.close();
  await server.close();
}
