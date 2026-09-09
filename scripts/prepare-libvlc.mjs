// Build-time only: the installed app never downloads an engine or transcodes video.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const version = '3.0.23';
const checksum = '992d19dbd0b8a7cde9167d2f7780b1ef6f92acc8a71acfa736101a21f35181e1';
const root = resolve(import.meta.dirname, '../src-tauri/target/libvlc');
const directory = resolve(root, `vlc-${version}`);
if (process.platform !== 'win32') {
    console.log('libVLC Windows bundle preparation skipped');
    process.exit(0);
}
await mkdir(root, { recursive: true });
if (process.argv.includes('--source')) {
    const source = resolve(root, `vlc-${version}.tar.xz`), sourceHash = 'e891cae6aa3ccda69bf94173d5105cbc55c7a7d9b1d21b9b21666e69eff3e7e0';
    const sha = async (path) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path))
        hash.update(chunk); return hash.digest('hex'); };
    if (!existsSync(source) || await sha(source) !== sourceHash) {
        const response = await fetch(`https://download.videolan.org/pub/videolan/vlc/${version}/vlc-${version}.tar.xz`);
        if (!response.ok || !response.body)
            throw new Error('VLC source download failed');
        await pipeline(response.body, createWriteStream(source));
        if (await sha(source) !== sourceHash)
            throw new Error('VLC source checksum mismatch');
    }
    // LGPL text for the embedding library, in addition to the distribution's GPL.
    const extracted = spawnSync('tar.exe', ['-xf', source, '-C', root, `vlc-${version}/COPYING.LIB`], { stdio: 'inherit', windowsHide: true });
    if (extracted.status !== 0)
        throw new Error('Cannot extract libVLC license');
    console.log(`Verified corresponding VLC source: ${source}`);
}
if (existsSync(resolve(directory, 'libvlc.dll')) && existsSync(resolve(directory, '.pixvault-verified'))) {
    if ((await readFile(resolve(directory, '.pixvault-verified'), 'utf8')).trim() === checksum) {
        console.log('Pinned libVLC bundle already prepared');
        process.exit(0);
    }
}
const archive = resolve(root, `vlc-${version}-win64.zip`);
const hashFile = async (path) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path))
    hash.update(chunk); return hash.digest('hex'); };
if (!existsSync(archive) || await hashFile(archive) !== checksum) {
    const response = await fetch(`https://download.videolan.org/pub/videolan/vlc/${version}/win64/vlc-${version}-win64.zip`);
    if (!response.ok || !response.body)
        throw new Error(`VLC download failed: ${response.status}`);
    const partial = archive + '.partial';
    await pipeline(response.body, createWriteStream(partial));
    if (await hashFile(partial) !== checksum) {
        await rm(partial);
        throw new Error('VLC SHA-256 mismatch');
    }
    await rename(partial, archive);
}
const result = spawnSync('tar.exe', ['-xf', archive, '-C', root], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0)
    throw new Error('Cannot unpack libVLC bundle');
if (!existsSync(resolve(directory, 'libvlc.dll')) || !existsSync(resolve(directory, 'plugins')))
    throw new Error('Incomplete libVLC bundle');
// Generated verification marker, not a source file. All upstream notices stay intact.
await pipeline([checksum + '\n'], createWriteStream(resolve(directory, '.pixvault-verified')));
console.log(`Prepared verified libVLC ${version}: ${directory}`);
