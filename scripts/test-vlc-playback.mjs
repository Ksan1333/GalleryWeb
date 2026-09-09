// Native bridge and GPU drawing, in an isolated headless browser. No user media.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const native = readFileSync(resolve(root, 'src-tauri/src/vlc_playback.rs'), 'utf8');
for (const name of ['start_video_playback', 'get_video_playback_status', 'cancel_video_playback', 'ensure_engine', 'force_transcode'])
    assert.ok(!native.includes(name), name);
assert.ok(!existsSync(resolve(root, 'src-tauri/src/video_playback.rs')));
assert.ok(!existsSync(resolve(root, 'src/hooks/useVideoPlaybackSource.ts')));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/release/**', '**/artifacts/**'] } }, plugins: [{ name: 'fixture', configureServer(vite) { vite.middlewares.use('/__vlc', (_, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><canvas id="picture"></canvas><script type="module">import {VlcVideoHandle,createFrameRenderer} from '/src/services/vlcPlayer.ts';window.VideoHandle=VlcVideoHandle;window.createRenderer=createFrameRenderer;</script>`); }); } }] });
let browser;
try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
        const fixture = window.fixture = { calls: [], jobs: 0, slowOpen: false, slowFrame: false, pendingFrames: 0, maxPendingFrames: 0,
            status: { state: 'playing', time: 1, duration: 120, width: 2, height: 2, volume: .5, muted: false, autoReduced: false } };
        fixture.packet = () => { const data = new ArrayBuffer(24 + 32 * 2), view = new DataView(data); [2, 2, 32, 1, 2, 2].forEach((v, i) => view.setUint32(i * 4, v, true)); const pixels = new Uint8Array(data, 24); pixels.set([0, 0, 255, 0, 0, 255, 0, 0]); pixels.set([255, 0, 0, 0, 255, 255, 255, 0], 32); return data; };
        window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
                fixture.calls.push({ command, args });
                if (command === 'open_vlc_player') {
                    if (fixture.slowOpen)
                        await new Promise(resolve => fixture.openReady = resolve);
                    return 'job-' + (++fixture.jobs);
                }
                if (command === 'read_vlc_status')
                    return { ...fixture.status };
                if (command === 'read_vlc_frame') {
                    fixture.pendingFrames++;
                    fixture.maxPendingFrames = Math.max(fixture.maxPendingFrames, fixture.pendingFrames);
                    if (fixture.slowFrame)
                        await new Promise(resolve => fixture.frameReady = resolve);
                    fixture.pendingFrames--;
                    return args.after === 1 ? new ArrayBuffer(0) : fixture.packet();
                }
                if (command === 'control_vlc_player') {
                    const c = args.control;
                    if (c.type === 'seek')
                        fixture.status.time = c.time;
                    if (c.type === 'pause')
                        fixture.status.state = 'paused';
                    if (c.type === 'play')
                        fixture.status.state = 'playing';
                    if (c.type === 'volume') {
                        fixture.status.volume = c.volume;
                        fixture.status.muted = c.muted;
                    }
                    return;
                }
                if (command === 'close_vlc_player')
                    return;
                throw new Error('Unexpected ' + command);
            } };
    });
    const fresh = async () => { await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__vlc`); await page.waitForFunction(() => window.VideoHandle); };
    await fresh();
    const pixels = await page.evaluate(() => { const canvas = document.querySelector('canvas'); const renderer = createRenderer(canvas); renderer.draw(fixture.packet()); const gl = canvas.getContext('webgl'); const bytes = new Uint8Array(16); gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, bytes); renderer.dispose(); return [...bytes]; });
    assert.deepEqual(pixels, [0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255], 'BGRx, row padding and orientation render correctly');
    await page.evaluate(() => { window.player = new VideoHandle(document.querySelector('canvas'), 'a', { volume: .5, muted: false, loop: true }); });
    await page.waitForFunction(() => player.readyState === 4);
    assert.equal(await page.evaluate(() => document.querySelectorAll('video').length), 0, 'no browser codec dependency');
    await page.evaluate(() => { player.currentTime = 42; player.volume = .35; player.muted = true; player.loop = false; player.pause(); });
    await page.waitForFunction(() => fixture.status.time === 42 && fixture.status.volume === .35 && fixture.status.muted && fixture.status.state === 'paused');
    await page.evaluate(() => player.play());
    await page.waitForFunction(() => fixture.status.state === 'playing');
    assert.equal(await page.evaluate(() => player.canvas.toDataURL('image/png').startsWith('data:image/png')), true, 'frame capture remains available');
    await page.evaluate(() => player.dispose());
    await page.waitForFunction(() => fixture.calls.some(c => c.command === 'close_vlc_player'));
    await fresh();
    await page.evaluate(() => { fixture.slowOpen = true; window.player = new VideoHandle(document.querySelector('canvas'), 'a', { volume: 1, muted: false, loop: true }); player.dispose(); });
    await page.waitForFunction(() => fixture.openReady);
    await page.evaluate(() => fixture.openReady());
    await page.waitForFunction(() => fixture.calls.some(c => c.command === 'close_vlc_player'));
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.command === 'read_vlc_frame').length), 0, 'late open cannot resurrect a closed viewer');
    await fresh();
    await page.evaluate(() => { fixture.slowFrame = true; window.player = new VideoHandle(document.querySelector('canvas'), 'b', { volume: 1, muted: false, loop: true }); });
    await page.waitForFunction(() => fixture.frameReady);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => fixture.maxPendingFrames), 1, 'slow rendering never accumulates frame requests');
    await page.evaluate(() => { player.dispose(); fixture.frameReady(); });
    await fresh();
    await page.evaluate(() => { fixture.status = { ...fixture.status, state: 'error', message: 'bad video' }; window.player = new VideoHandle(document.querySelector('canvas'), 'c', { volume: .5, muted: false, loop: true }); });
    await page.waitForFunction(() => player.error?.message === 'bad video');
    await page.evaluate(() => player.dispose());
    assert.deepEqual(errors, []);
    console.log('PASS libVLC bridge: direct frames, GPU colors/stride/orientation, seek, volume, mute, loop, pause/play, capture, late close, backpressure, errors; transcoder removed.');
}
finally {
    await browser?.close();
    await server.close();
}
