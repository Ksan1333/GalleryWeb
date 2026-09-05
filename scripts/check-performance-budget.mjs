import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(projectRoot, "dist");
const indexPath = resolve(distDirectory, "index.html");

const budgets = {
  // Raw ceilings include the 0.1.26 workspace shell and responsive navigation.
  // Compressed startup assets remain deliberately tight so an accidentally
  // eager feature route still fails instead of hiding behind readable CSS.
  initialJavaScriptBytes: 320 * 1024,
  initialJavaScriptGzipBytes: 100 * 1024,
  initialCssBytes: 122 * 1024,
  initialCssGzipBytes: 24 * 1024,
  largestApplicationChunkBytes: 450 * 1024,
  largestWorkerChunkBytes: 1300 * 1024,
  // PDF.js 6.2.108's security update adds ~9.5 KiB to its lazy renderer/worker.
  // 0.2.6 adds up to 4 KiB for staged external-open hydration and release notes.
  // Startup and individual chunk limits stay unchanged.
  totalAssetBytes: 2614 * 1024,
};

function fail(message) {
  console.error(`Performance budget check failed: ${message}`);
  process.exitCode = 1;
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

if (!existsSync(indexPath)) {
  fail("dist/index.html was not found; run the production build first.");
} else {
  const html = readFileSync(indexPath, "utf8");
  const initialPaths = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1].split(/[?#]/, 1)[0])
    .filter((path) => path.startsWith("/assets/"))
    .map((path) => resolve(distDirectory, `.${decodeURIComponent(path)}`))
    .filter((path) => path.startsWith(distDirectory));

  const missingInitialAsset = initialPaths.find((path) => !existsSync(path));
  if (missingInitialAsset) {
    fail(`initial asset is missing: ${relative(projectRoot, missingInitialAsset)}`);
  } else {
    const initialJavaScript = initialPaths.filter((path) => [".js", ".mjs"].includes(extname(path)));
    const initialCss = initialPaths.filter((path) => extname(path) === ".css");
    const rawBytes = (paths) => paths.reduce((total, path) => total + statSync(path).size, 0);
    const gzipBytes = (paths) => paths.reduce(
      (total, path) => total + gzipSync(readFileSync(path), { level: 9 }).length,
      0,
    );
    const assets = filesBelow(resolve(distDirectory, "assets"));
    const applicationChunks = assets.filter((path) => extname(path) === ".js");
    const workerChunks = assets.filter((path) => extname(path) === ".mjs");
    const maximumSize = (paths) => paths.reduce(
      (maximum, path) => Math.max(maximum, statSync(path).size),
      0,
    );
    const measurements = {
      initialJavaScriptBytes: rawBytes(initialJavaScript),
      initialJavaScriptGzipBytes: gzipBytes(initialJavaScript),
      initialCssBytes: rawBytes(initialCss),
      initialCssGzipBytes: gzipBytes(initialCss),
      largestApplicationChunkBytes: maximumSize(applicationChunks),
      largestWorkerChunkBytes: maximumSize(workerChunks),
      totalAssetBytes: rawBytes(assets),
    };

    console.log("Static performance budgets:");
    for (const [name, budget] of Object.entries(budgets)) {
      const actual = measurements[name];
      const passed = actual <= budget;
      console.log(
        `  ${passed ? "PASS" : "FAIL"} ${name}: ${formatBytes(actual)} / ${formatBytes(budget)}`,
      );
      if (!passed) process.exitCode = 1;
    }
  }
}
