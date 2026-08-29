import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const reportPath = resolve(process.argv[2] ?? "artifacts/thumbnail-benchmark.json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const coldLimits = new Map([
  ["image", 250],
  ["gif", 150],
  ["video", 250],
  ["zip", 500],
]);

const checks = [];
for (const kind of report.kinds ?? []) {
  checks.push([
    kind.generatorWarmPathProbe?.p95Ms <= 1,
    `${kind.kind} warm path p95 ${kind.generatorWarmPathProbe?.p95Ms?.toFixed(3)} ms <= 1 ms`,
  ]);
  checks.push([
    kind.cacheCold?.p95Ms <= (coldLimits.get(kind.kind) ?? 500),
    `${kind.kind} cold p95 ${kind.cacheCold?.p95Ms?.toFixed(1)} ms remains within the CI ceiling`,
  ]);
}

const sequential = report.sequentialBatch?.itemsPerSecond ?? 0;
const parallel = report.foregroundParallelBatch?.itemsPerSecond ?? 0;
const requiredSpeedup = (report.foregroundParallelBatch?.workers ?? 1) > 1 ? 1.35 : 0.95;
checks.push([
  sequential > 0 && parallel / sequential >= requiredSpeedup,
  `foreground batch speedup ${(parallel / Math.max(sequential, Number.EPSILON)).toFixed(2)}x >= ${requiredSpeedup.toFixed(2)}x`,
]);
checks.push([
  report.pipeline?.sqliteThumbnailSourceLookup?.p95Ms <= 5,
  `SQLite thumbnail lookup p95 ${report.pipeline?.sqliteThumbnailSourceLookup?.p95Ms?.toFixed(3)} ms <= 5 ms`,
]);

let failed = false;
console.log(`Thumbnail performance gate: ${reportPath}`);
for (const [passed, description] of checks) {
  console.log(`  ${passed ? "PASS" : "FAIL"} ${description}`);
  if (!passed) failed = true;
}
if (failed) process.exitCode = 1;
