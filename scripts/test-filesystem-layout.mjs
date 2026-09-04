// Isolated, headless DOM tests only: no desktop automation or screenshots.
// Use an installed playwright package, or PLAYWRIGHT_MODULE=/path/to/index.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const baseline = process.argv.includes("--baseline-0.2.0");
const server = await createServer({
  root, configFile: false, logLevel: "error",
  plugins: [
    ...(baseline ? [{
      name: "old-filesystem-layout", enforce: "pre",
      transform(_code, id) {
        const path = id.replaceAll("\\", "/").split("?")[0];
        for (const file of ["FileSystemBrowser.tsx", "FileSystemBrowser.css"]) {
          if (path.endsWith(`/src/components/${file}`)) {
            return execFileSync("git", ["show", `0.2.0:src/components/${file}`], { cwd: root, encoding: "utf8" });
          }
        }
      },
    }] : []),
    react(),
    {
      name: "filesystem-layout-fixture",
      configureServer(vite) {
        vite.middlewares.use("/__filesystem_test", (_req, res) => {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div>
            <script type="module">
              import RefreshRuntime from '/@react-refresh';
              RefreshRuntime.injectIntoGlobalHook(window);
              window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
              window.__vite_plugin_react_preamble_installed__ = true;
            </script>
            <script type="module" src="/@vite/client"></script>
            <script type="module">
              import React from '/node_modules/.vite/deps/react.js';
              import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
              import {FileSystemBrowser} from '/src/components/FileSystemBrowser.tsx';
              import '/src/App.css';
              ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('div', {className: 'app-shell'},
                React.createElement('main', {className: 'main-panel'},
                  React.createElement('header', {className: 'topbar'}, 'PixVault — layout fixture'),
                  React.createElement(FileSystemBrowser, {refreshVersion: 0, onDataChanged: () => {}}))));
            </script></body></html>`);
        });
      },
    },
  ],
  optimizeDeps: { entries: ["src/components/FileSystemBrowser.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: { ignored: ["**/src-tauri/**", "**/release/**"] } },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  console.log(`Headless layout fixture ready (${baseline ? "0.2.0 baseline" : "working tree"})`);
  browser = await chromium.launch({ headless: true });
  const sizes = [[2330, 900], [1440, 900], [1024, 768], [760, 600], [390, 844], [2330, 520]];
  for (const [width, height] of sizes) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(20_000);
    console.log(`Checking ${width}x${height}`);
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    page.on("requestfailed", (request) => console.error(`Request failed: ${request.url()} ${request.failure()?.errorText}`));
    await page.addInitScript(() => {
      const longName = "とても長いフォルダー名_旅行写真_".repeat(12);
      const priorities = Array.from({ length: 20 }, (_, i) => ({
        id: `priority-${i}`, path: `E:\\${longName}${i}`, displayName: `${longName}${i}`,
        mediaCount: 0, isPriority: true,
      }));
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          if (command === "browse_file_system") {
            if (args.path === "E:\\denied") throw new Error("アクセスできません");
            if (!args.path) return {
              path: null, parentPath: null, rootId: null, relativeFolder: "", priorityPath: null,
              folders: [{ path: "E:\\", displayName: "Eドライブ" }],
            };
            const count = args.path === "E:\\" ? 13 : args.path === "E:\\many" ? 240 : 0;
            return {
              path: args.path, parentPath: args.path === "E:\\" ? null : "E:\\",
              rootId: "root", relativeFolder: args.path.slice(3), priorityPath: "E:\\",
              folders: Array.from({ length: count }, (_, i) => ({
                path: `E:\\${i === 0 ? "many" : longName + i}`,
                displayName: i === 0 ? "多数のフォルダー" : `${i}_${longName}`,
              })),
            };
          }
          if (command === "list_library_roots") return priorities;
          if (command === "get_media_page_info") return { totalCount: 0, dateGroups: [] };
          if (command === "list_media_items" || command === "list_media_folders") return [];
          if (command === "list_tag_translations") return {};
          throw new Error(`Unexpected native call: ${command}`);
        },
      };
    });
    await page.goto(`http://127.0.0.1:${address.port}/__filesystem_test`);
    await page.getByRole("button", { name: "Eドライブ" }).click();
    await page.locator(".mixed-folder-card").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const rect = (element) => element.getBoundingClientRect().toJSON();
      const scroller = document.querySelector(".virtual-media-scroller");
      const card = document.querySelector(".mixed-folder-card");
      const label = card.querySelector("strong");
      const container = document.querySelector(".filesystem-browser");
      const open = document.querySelector(".filesystem-toolbar button[type=submit]");
      return {
        scroller: rect(scroller), card: rect(card), label: rect(label), open: rect(open),
        openLines: open.scrollHeight, openFont: parseFloat(getComputedStyle(open).fontSize),
        labelFont: parseFloat(getComputedStyle(label).fontSize),
        overflow: container.scrollWidth - container.clientWidth,
        formOverflow: open.parentElement.scrollWidth - open.parentElement.clientWidth,
        pageBottom: rect(container).bottom,
        priorityHeight: rect(document.querySelector(".filesystem-priorities")).height,
        tilesFit: [...document.querySelectorAll(".mixed-folder-card")].every((tile) => {
          const box = rect(tile), name = rect(tile.querySelector("strong"));
          return box.right <= rect(scroller).right + 1 && name.bottom <= box.bottom + 1;
        }),
      };
    });
    assert.ok(geometry.scroller.height >= 150, `${width}x${height}: list collapsed: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.scroller.bottom <= height + 1, "list bottom fits the viewport");
    assert.ok(height - geometry.scroller.bottom < 40, "list consumes remaining window height");
    assert.ok(geometry.label.bottom <= geometry.card.bottom + 1, "folder label fits its tile");
    assert.ok(geometry.card.bottom <= geometry.scroller.bottom + 1, "entire first row is visible");
    assert.ok(Math.abs(geometry.card.width - geometry.card.height) < 2, "thumbnail plus label is square");
    assert.ok(geometry.labelFont >= 11 && geometry.label.height <= 31, "readable two-line folder name");
    assert.ok(geometry.open.width > geometry.openFont * 2 + 8, "open button has room for both characters");
    assert.ok(geometry.open.height <= 42, "open button stays on one line");
    assert.ok(geometry.overflow <= 1 && geometry.formOverflow <= 1, "no horizontal page/form overflow");
    assert.ok(geometry.priorityHeight < 50, "many long priority names do not consume vertical space");
    assert.ok(geometry.tilesFit, "long names and rightmost tiles remain within their bounds");
    assert.equal(await page.locator(".mixed-folder-card .folder-item-count").count(), 0, "unknown counts are hidden");

    // 240 directories must remain virtualized, including the last row.
    await page.locator(".mixed-folder-card").first().click();
    await page.waitForFunction(() => document.querySelector(".result-meta")?.textContent.includes("240"));
    await page.locator(".virtual-media-scroller").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => [...document.querySelectorAll(".mixed-folder-card strong")].some((item) => item.textContent.startsWith("239_")));
    assert.ok(await page.locator(".mixed-folder-card").count() < 240, "only visible folder rows are mounted");
    await page.getByRole("button", { name: "戻る", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".result-meta")?.textContent.includes("13"));
    await page.getByRole("textbox", { name: "フォルダーのパス", exact: true }).fill("E:\\empty");
    await page.getByRole("button", { name: "開く", exact: true }).click();
    await page.getByText("このフォルダーは空です", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "フォルダーのパス", exact: true }).fill("E:\\denied");
    await page.getByRole("button", { name: "開く", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.deepEqual(errors, [], "no React/browser runtime errors");
    console.log(`PASS ${width}x${height}: list ${Math.round(geometry.scroller.width)}x${Math.round(geometry.scroller.height)}, square tiles, labels, controls, priorities, scroll, navigation, empty/error`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
