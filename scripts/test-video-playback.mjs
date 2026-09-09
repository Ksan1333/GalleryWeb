// Isolated headless React test; no user's app, files, desktop or screenshots.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const server = await createServer({ root: resolve(import.meta.dirname, '..'), configFile: false,
  logLevel: 'error', plugins: [react(), { name: 'playback-fixture', configureServer(vite) {
    vite.middlewares.use('/__playback', (_, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
        window.__vite_plugin_react_preamble_installed__=true;
      </script><script type="module" src="/@vite/client"></script>
      <script type="module">
        import React from '/node_modules/.vite/deps/react.js';
        import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
        import {useVideoPlaybackSource} from '/src/hooks/useVideoPlaybackSource.ts';
        import '/src/components/MediaViewer.css';
        const loaded=v=>window.fixture.loading=v;
        function Viewer({id}) {
          const ref=React.useRef(null);
          const playback=useVideoPlaybackSource(id, 'http://127.0.0.1/original-'+id+'.mp4', ref, loaded);
          return React.createElement('div',{},
            React.createElement('video',{ref,src:playback.source}),
            React.createElement('output',{'data-phase':playback.phase},playback.message),
            React.createElement('button',{onClick:playback.retry},'retry'),
            React.createElement('button',{onClick:playback.useCompatibility},'compatibility'));
        }
        function App() {
          const [id,setId]=React.useState('a');
          window.fixture.open=setId;
          return React.createElement('div',{},id&&React.createElement(Viewer,{id,key:id}),
            React.createElement('button',{onClick:()=>setId('b')},'next'),
            React.createElement('button',{onClick:()=>setId(null)},'close'),
            React.createElement('div',{className:'pv-viewer-page-loading'},'loading'));
        }
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
      </script></body></html>`);
    });
  }}], optimizeDeps: { include: ['react','react-dom/client'] },
  server: { host:'127.0.0.1',port:0,watch:{ignored:['**/src-tauri/**','**/release/**','**/artifacts/**']} } });

let browser;
try {
  await server.listen(); browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  await context.addInitScript(() => {
    const fixture=window.fixture={ calls:[],states:new WeakMap(),loading:true,status:{state:'preparing',message:'converting'},slowStart:false,job:0 };
    document.addEventListener('error',e=>{if(e.isTrusted&&e.target instanceof HTMLMediaElement)e.stopImmediatePropagation()},true);
    Object.defineProperties(HTMLMediaElement.prototype,{
      readyState:{get(){return fixture.states.get(this)?.readyState??0}},
      error:{get(){return null}},
      paused:{get(){return fixture.states.get(this)?.paused??true}},
      currentTime:{get(){return fixture.states.get(this)?.time??0},set(time){fixture.states.set(this,{...fixture.states.get(this),time})}},
      duration:{get(){return 120}},
    });
    HTMLMediaElement.prototype.pause=function(){};
    fixture.emit=(name,state={})=>{const v=document.querySelector('video');fixture.states.set(v,{...fixture.states.get(v),...state});v.dispatchEvent(new Event(name))};
    window.__TAURI_INTERNALS__={ convertFileSrc:path=>'http://127.0.0.1/'+path, invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='start_video_playback') {
        const id='job-'+(++fixture.job);
        if(fixture.slowStart) await new Promise(resolve=>fixture.resolveStart=resolve);
        return id;
      }
      if(command==='get_video_playback_status')return fixture.status;
      if(command==='cancel_video_playback')return null;
      throw new Error('Unexpected command '+command);
    }};
  });
  const page=await context.newPage(); const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  page.on('response',r=>{if(r.status()>=400)console.error('HTTP',r.status(),r.url())});
  await page.route('**/*',route=>new URL(route.request().url()).port===String(server.httpServer.address().port)?route.continue():route.abort());
  const url=`http://127.0.0.1:${server.httpServer.address().port}/__playback`;
  const fresh=async()=>{await page.goto(url);await page.locator('video').waitFor()};
  const phase=expected=>page.waitForFunction(value=>document.querySelector('output')?.dataset.phase===value,expected);
  const emit=(name,state)=>page.evaluate(([name,state])=>window.fixture.emit(name,state),[name,state]);
  const starts=()=>page.evaluate(()=>fixture.calls.filter(c=>c.command==='start_video_playback'));

  await fresh();
  const loadingStyle=await page.locator('.pv-viewer-page-loading').evaluate(el=>({pointer:getComputedStyle(el).pointerEvents,height:el.getBoundingClientRect().height}));
  assert.equal(loadingStyle.pointer,'none');assert.ok(loadingStyle.height<80,'loading remains a small badge');
  await emit('loadeddata',{readyState:2});await phase('ready');
  await emit('waiting',{readyState:1});await phase('buffering');
  await emit('playing',{readyState:4,paused:false});await phase('ready');
  assert.equal((await starts()).length,0);

  await fresh();await emit('error');await phase('preparing');
  await page.waitForFunction(()=>fixture.calls.some(c=>c.command==='get_video_playback_status'));
  await page.evaluate(()=>fixture.status={state:'ready',message:'ready',path:'compatible.mp4'});
  await page.waitForFunction(()=>document.querySelector('video').src.endsWith('/compatible.mp4'));
  await page.evaluate(()=>fixture.status={state:'preparing',message:'transcoding'});
  await emit('error');await phase('preparing');
  await page.waitForFunction(()=>fixture.calls.filter(c=>c.command==='start_video_playback').length===2);
  assert.equal((await starts())[1].args.transcode,true,'failed remux falls back to re-encoding');
  await page.evaluate(()=>fixture.status={state:'ready',path:'compatible.webm',message:'ready'});
  await page.waitForFunction(()=>document.querySelector('video').src.endsWith('/compatible.webm'));
  await emit('playing',{readyState:4,paused:false});await phase('ready');
  await page.getByRole('button',{name:'close',exact:true}).click();
  await page.waitForFunction(()=>fixture.calls.filter(c=>c.command==='cancel_video_playback').length===2);

  await fresh();await page.clock.install();
  await emit('loadedmetadata',{readyState:1});
  await page.clock.fastForward(15_100);await phase('preparing');
  assert.equal((await starts()).length,1,'metadata without decoded frames still invokes compatibility playback');
  await page.getByRole('button',{name:'next',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video').src.endsWith('original-b.mp4'));
  await page.waitForFunction(()=>fixture.calls.some(c=>c.command==='cancel_video_playback'));
  await page.clock.resume();

  await fresh();await page.evaluate(()=>fixture.slowStart=true);await emit('error');await phase('preparing');
  await page.waitForFunction(()=>fixture.resolveStart);
  await page.getByRole('button',{name:'close',exact:true}).click();
  await page.evaluate(()=>fixture.resolveStart());
  await page.waitForFunction(()=>fixture.calls.some(c=>c.command==='cancel_video_playback'));
  assert.equal(await page.locator('video').count(),0,'a late conversion result cannot reopen the viewer');

  await fresh();await page.evaluate(()=>fixture.status={state:'error',message:'offline'});await emit('error');await phase('error');
  await page.getByRole('button',{name:'retry',exact:true}).click();
  await page.waitForFunction(()=>fixture.calls.filter(c=>c.command==='start_video_playback').length===2);
  assert.equal((await starts())[1].args.transcode,false,'retry restarts the first attempt instead of getting stuck');
  await page.getByRole('button',{name:'close',exact:true}).click();
  assert.deepEqual(errors,[]);
  console.log('PASS: loading badge, playback/buffering, remux → transcode, metadata stall, next/close cancellation, late start, offline retry');
} finally { await browser?.close();await server.close(); }
