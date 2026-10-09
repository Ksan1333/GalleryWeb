import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
if (process.platform === 'win32') {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(import.meta.dirname, 'prepare-vcredist.ps1')], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
console.log('Windows Visual C++ runtime preparation skipped');
