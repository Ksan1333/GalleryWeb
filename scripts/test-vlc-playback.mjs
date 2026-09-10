// Native GPU surface contract in isolated headless Chromium. No user media.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const client = readFileSync(resolve(root, 'src/services/vlcPlayer.ts'), 'utf8');
assert.ok(!client.includes('read_vlc_frame'), 'no continuous pixel IPC');
assert.ok(!client.includes('createFrameRenderer'), 'no WebGL re-upload');
const native = readFileSync(resolve(root, 'src-tauri/src/vlc_playback.rs'), 'utf8');
assert.ok(native.includes('Output::Native(session.surface.video)'));
assert.ok(native.includes('libvlc_media_player_set_hwnd'));
assert.match(native, /pub async fn open_vlc_player[\s\S]*?spawn_blocking/, 'cross-thread HWND creation never blocks the WebView UI thread');
assert.ok(!native.includes('pub async fn read_vlc_frame'));
const surface = readFileSync(resolve(root, 'src-tauri/src/vlc_surface.rs'), 'utf8');
assert.ok(!surface.includes('ShowCursor(') && !surface.includes('SetSystemCursor('));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/src-tauri/**', '**/release/**', '**/artifacts/**'] } }, plugins: [{ name: 'fixture', configureServer(vite) { vite.middlewares.use('/__vlc', (_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><style>body{margin:0}canvas{width:640px;height:360px}.pv-video-controls{position:absolute;left:0;top:300px;width:640px;height:60px;background:black}</style><section role="dialog" aria-modal="true"><div class="pv-video-surface" tabindex="0"><canvas></canvas></div><div class="pv-video-controls"></div></section><script type="module">import {VlcVideoHandle} from "/src/services/vlcPlayer.ts";import {surfaceLayout} from "/src/services/nativeVideoSurface.ts";window.Handle=VlcVideoHandle;window.layout=surfaceLayout;</script>'); }); } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fixture = window.fixture = { calls: [], listeners: {}, callbacks: {}, id: 0, slow: false, status: { state: 'playing', time: 10, duration: 120, width: 3840, height: 2160, volume: .5, muted: false, autoReduced: false } };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: event => { delete fixture.listeners[event]; } };
    window.__TAURI_INTERNALS__ = { transformCallback: callback => { const id = ++fixture.id; fixture.callbacks[id] = callback; return id; }, invoke: async (command, args) => {
      fixture.calls.push({ command, args });
      if (command === 'plugin:event|listen') { fixture.listeners[args.event] = fixture.callbacks[args.handler]; return 1; }
      if (command === 'plugin:event|unlisten') return;
      if (command === 'open_vlc_player') { if (fixture.slow) await new Promise(resolve => fixture.openReady = resolve); return 'session'; }
      if (command === 'read_vlc_status') return { ...fixture.status };
      if (command === 'set_vlc_surface' || command === 'close_vlc_player') return;
      if (command === 'capture_vlc_frame') return new Uint8Array([137,80,78,71]).buffer;
      if (command === 'control_vlc_player') {
        const c = args.control;
        if (c.type === 'seek') fixture.status.time = c.time;
        if (c.type === 'volume') { fixture.status.volume = c.volume; fixture.status.muted = c.muted; }
        if (c.type === 'pause') fixture.status.state = 'paused';
        if (c.type === 'play') fixture.status.state = 'playing';
        return;
      }
      throw new Error(command);
    } };
  });
  const fresh = async () => { await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__vlc`); await page.waitForFunction(() => window.Handle); };
  const open = async () => { await page.evaluate(() => { window.player = new Handle(document.querySelector('canvas'), 'a', { volume: .5, muted: false, loop: true }); }); await page.waitForFunction(() => player.readyState === 4 && fixture.calls.some(c => c.command === 'set_vlc_surface')); };
  await fresh(); await open();
  const geometry = await page.evaluate(() => layout(document.querySelector('canvas')));
  assert.deepEqual(geometry.rect, { x: 0, y: 0, width: 1280, height: 720 });
  assert.equal(geometry.holes.length, 1);
  assert.equal(geometry.holes[0].y, 600);
  assert.equal(await page.evaluate(() => player.videoWidth), 3840, 'native resolution is not limited to full HD');
  await page.waitForTimeout(2200);
  assert.ok(await page.evaluate(() => fixture.calls.filter(c => c.command === 'set_vlc_surface').length < 6), 'geometry/heartbeat only, not per-frame IPC');
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.command.includes('frame')).length), 0);
  await page.evaluate(() => { player.currentTime = 42; player.volume = .35; player.muted = true; player.pause(); });
  await page.waitForFunction(() => fixture.status.time === 42 && fixture.status.volume === .35 && fixture.status.muted && fixture.status.state === 'paused');
  await page.evaluate(() => player.play());
  assert.ok((await page.evaluate(() => player.capture())).startsWith('data:image/png;base64,'));
  await page.evaluate(() => {
    window.inputEvents = [];
    const target = document.querySelector('.pv-video-surface');
    for (const kind of ['pointerdown', 'pointerup', 'wheel']) target.addEventListener(kind, event => inputEvents.push({ kind, x: event.clientX, y: event.clientY, delta: event.deltaY }));
    const send = fixture.listeners['pixvault://vlc-input/session'];
    send({ payload: { kind: 'pointerdown', x: 200, y: 100, buttons: 1, delta: 0 } });
    send({ payload: { kind: 'pointerup', x: 200, y: 100, buttons: 0, delta: 0 } });
    send({ payload: { kind: 'wheel', x: 200, y: 100, buttons: 0, delta: -120 } });
  });
  assert.equal(await page.evaluate(() => inputEvents[0].x), 100, 'native input converts physical pixels to CSS coordinates');
  assert.equal(await page.evaluate(() => inputEvents[2].delta), -120);
  await page.evaluate(() => { const modal = document.createElement('div'); modal.id = 'confirm'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal); });
  await page.waitForFunction(() => fixture.calls.filter(c => c.command === 'set_vlc_surface').at(-1).args.layout.visible === false);
  await page.evaluate(() => document.querySelector('#confirm').remove());
  await page.waitForFunction(() => fixture.calls.filter(c => c.command === 'set_vlc_surface').at(-1).args.layout.visible === true);
  await page.evaluate(() => player.dispose());
  await page.waitForFunction(() => !fixture.listeners['pixvault://vlc-input/session']);
  const count = await page.evaluate(() => fixture.calls.length);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => fixture.calls.length), count, 'dispose stops polling/geometry/events');
  await fresh();
  await page.evaluate(() => { fixture.slow = true; window.player = new Handle(document.querySelector('canvas'), 'a', { volume: .5, muted: false, loop: false }); player.dispose(); });
  await page.waitForFunction(() => fixture.openReady);
  await page.evaluate(() => fixture.openReady());
  await page.waitForFunction(() => fixture.calls.some(c => c.command === 'close_vlc_player'));
  assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.command === 'set_vlc_surface').length), 0, 'late open cannot show stale native surface');
  assert.deepEqual(errors, []);
  console.log('PASS native GPU bridge: no frame IPC, bounded geometry heartbeat, DPI, overlay clipping, modal hide/restore, input, controls, explicit capture, cleanup, late open.');
} finally { await browser?.close(); await server.close(); }
