// Test data only. FFmpeg is NOT a runtime dependency or packaged with PixVault.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const ffmpeg = process.env.PIXVAULT_TEST_FFMPEG;
if (!ffmpeg)
    throw new Error('Set PIXVAULT_TEST_FFMPEG to a test-only FFmpeg executable');
const root = resolve(import.meta.dirname, '../src-tauri/target/vlc-fixtures');
await mkdir(root, { recursive: true });
for (const [codec, container] of [['mpeg4', 'avi'], ['ffv1', 'mkv'], ['wmv2', 'wmv'], ['libopenh264', 'mov'], ['libkvazaar', 'mkv']]) {
    const output = resolve(root, `日本語 ${codec}.${container}`);
    const result = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x192:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', codec, '-c:a', 'pcm_s16le', '-af', 'volume=5', output], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0)
        throw new Error(`Cannot generate ${codec} fixture`);
}
console.log(`Generated five synthetic codec/container fixtures: ${root}`);
