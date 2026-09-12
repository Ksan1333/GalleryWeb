// Actual React viewer + video-folder entry, isolated headless. No desktop/user media.
// Media timing is a deterministic test double; this tests input routing, not codecs.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const diagnose = process.argv.includes('--diagnose');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  plugins: [react(), {name:'viewer-fixture', configureServer(vite) {
    vite.middlewares.use('/__viewer_test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script><script type="module" src="/@vite/client"></script>
      <script type="module">
        import React from '/node_modules/.vite/deps/react.js';
        import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
        import {FolderMediaCollection} from '/src/components/MediaCollection.tsx';
        import {MediaViewer} from '/src/components/MediaViewer.tsx';
        import {applyThemeSettings, themePresets} from '/src/services/theme.ts';
        import '/src/App.css';
        window.__theme = (mode, preset='default') => applyThemeSettings({mode, preset}, false);
        window.__presets = themePresets.map(p => p.id);
        window.__theme('light');
        const noop = () => {};
        function Fixture() {
          const [currentId, setId] = React.useState('book-1');
          const books = [0,1,2].map(i => window.__fixture.makeItem(i, 'archive'));
          if (new URLSearchParams(location.search).has('order')) return React.createElement(MediaViewer, {
            items:books, currentId, onClose:noop, onItemPatch:noop, onRemove:noop, onCurrentIdChange:setId,
            collection:{query:{sortBy:'name',sortDirection:'asc',kinds:['archive']}, totalCount:3,
              currentIndex:books.findIndex(b=>b.id===currentId), indexedItems:[[2,books[2]],[0,books[0]],[1,books[1]]]},
          });
          return React.createElement('div',{className:'app-shell'}, React.createElement('main',{className:'main-panel'},
            React.createElement(FolderMediaCollection,{navigationKey:'videos',eyebrow:'VIDEOS',title:'動画',description:'Fixture',
              kinds:['video'],emptyTitle:'Empty',emptyDescription:'Empty',onAddFolder:noop,onDataChanged:noop})));
        }
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      </script></body></html>`);
    });
  }}],
  optimizeDeps:{entries:['src/components/MediaCollection.tsx'],include:['react','react-dom/client']},
  server:{host:'127.0.0.1',port:0,watch:{ignored:['**/src-tauri/**','**/release/**']}},
});

function installFixture() {
  Object.defineProperty(navigator, 'platform', {value:'Win32',configurable:true});
  // This fixture models successful playback; suppress real browser decode
  // errors from its placeholder SVG. Explicit failure tests live separately.
  document.addEventListener('error',e=>{if(e.isTrusted&&e.target instanceof HTMLMediaElement)e.stopImmediatePropagation()},true);
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="gray"/></svg>');
  const state = window.__fixture = {unexpected:[], calls:[], playCalls:0, pauseCalls:0, callbacks:{}, listeners:{}, callbackId:0,
    playback:{state:'playing',message:'',time:60,duration:120,width:640,height:360,volume:.5,muted:false,autoReduced:false}};
  state.makeItem = (i, kind='video') => ({id:`${kind==='archive'?'book':'video'}-${i}`,rootId:'fixture-root',
    relativePath:`${['1','2','10'][i]}.${kind==='archive'?'zip':'webm'}`,path:`E:/Fixture/${['1','2','10'][i]}.${kind==='archive'?'zip':'webm'}`,
    name:`${['1','2','10'][i]}.${kind==='archive'?'zip':'webm'}`,kind,sizeBytes:4096,width:640,height:360,
    durationSeconds:120,pageCount:2,isFavorite:true,ageRating:'SFW',tags:[{id:'tag1',name:'fixture',color:'#448844',source:'ai',confidence:.8}],
    modifiedAt:'2026-09-06T00:00:00Z',thumbnailPath:svg});
  const times = new WeakMap(), paused = new WeakMap();
  Object.defineProperties(HTMLMediaElement.prototype, {
    currentTime:{configurable:true,get(){return times.get(this)??60},set(v){times.set(this,v);this.dispatchEvent(new Event('timeupdate'))}},
    duration:{configurable:true,get(){return 120}},
    paused:{configurable:true,get(){return paused.get(this)??false}},
    readyState:{configurable:true,get(){return 4}},
    error:{configurable:true,get(){return null}},
  });
  HTMLMediaElement.prototype.play = function(){state.playCalls++;paused.set(this,false);this.dispatchEvent(new Event('play'));return Promise.resolve()};
  HTMLMediaElement.prototype.pause = function(){state.pauseCalls++;paused.set(this,true);this.dispatchEvent(new Event('pause'))};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:event=>{delete state.listeners[event]}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:callback=>{const id=++state.callbackId;state.callbacks[id]=callback;return id},
    convertFileSrc:()=>svg,invoke:async(command,args={})=>{
      state.calls.push({command,args});
      if(command==='open_vlc_player'){state.playCalls++;return 'viewer-job';}
      if(command==='close_vlc_player')return null;
      if(command==='set_vlc_surface')return null;
      if(command==='capture_vlc_frame')return new ArrayBuffer(0);
      if(command==='read_vlc_status')return {...state.playback};
      if(command==='read_vlc_frame'){
        if(args.after===1)return new ArrayBuffer(0);
        const packet=new ArrayBuffer(24+640*360*4),view=new DataView(packet);
        [640,360,640*4,1,640,360].forEach((v,i)=>view.setUint32(i*4,v,true));return packet;
      }
      if(command==='control_vlc_player'){
        const control=args.control;
        if(control.type==='seek')state.playback.time=control.time;
        if(control.type==='pause'){state.pauseCalls++;state.playback.state='paused';}
        if(control.type==='play'){state.playCalls++;state.playback.state='playing';}
        if(control.type==='volume'){state.volumeTouched=true;state.playback.volume=control.volume;state.playback.muted=control.muted;}
        if(control.type==='initialVolume'&&!state.volumeTouched)state.playback.volume=state.playback.autoReduced?Math.min(state.playback.volume,control.volume*.4):control.volume;
        return null;
      }
      if(command==='plugin:event|listen'){state.listeners[args.event]=state.callbacks[args.handler];return 1;}
      if(command.startsWith('plugin:event|'))return 1;
      if(command==='plugin:window|is_fullscreen')return false;
      if(command==='plugin:window|set_theme'||command==='set_preference')return null;
      if(command==='get_preferences')return {galleryDisplayPreferences:{sortOrder:'name-asc',groupMode:'none',gridSize:'medium'}};
      if(command==='list_library_roots')return [{id:'fixture-root',path:'E:/Fixture',displayName:'Video fixture',mediaCount:3,isPriority:true}];
      if(command==='list_media_folders')return [];
      if(command==='get_media_page_info')return {totalCount:3,dateGroups:[]};
      if(command==='list_media_items')return [0,1,2].map(i=>state.makeItem(i,args.query.kinds?.includes('zip')?'archive':'video')).slice(args.query.offset??0,(args.query.offset??0)+(args.query.limit??3));
      if(command==='get_media_thumbnails')return args.mediaIds.map(mediaId=>({mediaId,thumbnailPath:svg}));
      if(command==='get_media_thumbnail'||command==='get_archive_cover'||command==='get_archive_book_page')return svg;
      if(command==='get_archive_book_info')return {pageCount:2};
      if(command==='precache_archive_book_pages')return {pageCount:2,cachedPages:2};
      if(command==='list_book_bookmarks'||command==='list_tags')return [];
      if(command==='list_tag_translations')return {};
      if(command==='get_visual_recommendations')return {recommendations:[],pending:false};
      state.unexpected.push(command);throw new Error('Unexpected fixture command: '+command);
    }};
}

// Computed styles from an isolated fixture, never a user browser/window.
function contrastSamples() {
  const rgb = value => {const c=document.createElement('canvas').getContext('2d');c.fillStyle=value;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v)};
  const over = (f,b) => [0,1,2].map(i=>f[i]*f[3]+b[i]*(1-f[3])).concat(1);
  const bg = el => {
    const chain=[];for(let p=el;p;p=p.parentElement)chain.unshift(p);
    return chain.reduce((colors,p)=>colors.flatMap(c=>{
      const style=getComputedStyle(p),base=over(rgb(style.backgroundColor),c);
      const stops=[...style.backgroundImage.matchAll(/(?:rgba?|color)\([^)]*\)/g)].map(m=>rgb(m[0]));
      return [base,...stops.map(stop=>over(stop,base))];
    }),[[255,255,255,1]]);
  };
  const lum = c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  return ['.pv-media-info-summary strong','.pv-media-info-summary small','.pv-media-info-list dt','.pv-media-info-list dd',
    '.pv-media-info-path','.pv-media-info-relative','.pv-media-info-section-title > span','.pv-media-info-explorer',
    '.pv-media-recommendation-note','.pv-media-info-tags > button','.pv-viewer-title h2','.pv-viewer-title p'].map(selector=>{
    const el=document.querySelector(selector);if(!el)return {selector,missing:true};
    const style=getComputedStyle(el),ratios=bg(el).map(background=>{
      const a=lum(over(rgb(style.color),background)),b=lum(background);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    return {selector,ratio:Math.min(...ratios),font:parseFloat(style.fontSize)};
  });
}

let browser;
try {
  await server.listen(); browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},hasTouch:true});
  await context.addInitScript(installFixture);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  const base=`http://127.0.0.1:${server.httpServer.address().port}/__viewer_test`;
  await page.goto(base);
  await page.locator('.root-folder-main').click();
  await page.locator('[data-media-id="video-0"]').click();
  await page.locator('.pv-video-surface > canvas').waitFor();
  assert.equal(await page.locator('.pv-media-info-panel.is-collapsed').count(), 1,
    'recommendations start hidden');
  assert.equal(await page.locator('.pv-viewer-rail.is-collapsed').count(), 1,
    'the viewer list starts hidden');
  const initialInfoBox=await page.locator('.pv-media-info-panel.is-collapsed').boundingBox();
  const initialRailBox=await page.locator('.pv-viewer-rail.is-collapsed').boundingBox();
  assert.ok(initialInfoBox&&initialInfoBox.height>initialInfoBox.width*2,
    'a right-docked minimized recommendation panel keeps the edge-tab shape');
  assert.ok(initialRailBox&&initialRailBox.width>initialRailBox.height*2,
    'a bottom-docked minimized list keeps the edge-tab shape');
  await page.getByRole('button',{name:'情報とレコメンドを開く'}).click();
  await page.getByRole('button',{name:'メディア一覧を開く'}).click();
  await page.locator('.pv-media-info-list dd').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.pv-viewer-page-loading'));
  assert.equal(await page.locator('.pv-viewer-page-loading').count(), 0,
    'a playing video must not keep the full-screen loading overlay visible');
  assert.deepEqual(await page.locator('.pv-viewer-rail-name').allTextContents(),['1.webm','2.webm','10.webm'],
    'the video gallery and indexed viewer rail share Explorer natural-name order');
  await page.evaluate(()=>{
    window.__fixture.playback.autoReduced=true;
    window.__fixture.playback.volume=.31;
    window.dispatchEvent(new CustomEvent('pixvault:video-playback-settings',{detail:{volume:.9,muted:false,loop:false}}));
  });
  await page.waitForFunction(()=>document.querySelector('.pv-video-volume input').value==='0.31');
  assert.equal(await page.evaluate(()=>window.__fixture.playback.volume),.31,'reduced actual volume is not reset to 50% or a late saved value');
  await page.getByRole('button',{name:'ミュート',exact:true}).click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.__fixture.playback.volume),.31,'muting cannot restore the louder saved volume');
  await page.getByRole('button',{name:'ミュートを解除',exact:true}).click();
  await page.locator('.pv-video-surface').dispatchEvent('wheel',{deltaY:-120});
  await page.waitForFunction(()=>Math.abs(window.__fixture.playback.volume-.36)<1e-9);
  await page.locator('.pv-video-surface').dispatchEvent('wheel',{deltaY:120});
  await page.waitForFunction(()=>Math.abs(window.__fixture.playback.volume-.31)<1e-9);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pixvault:video-playback-settings',{detail:{volume:.8,muted:false,loop:false}})));
  await page.waitForTimeout(250);
  assert.ok(Math.abs(await page.evaluate(()=>window.__fixture.playback.volume)-.31)<1e-9,'manual changes remain based on the reduced actual level');
  const samples=await page.evaluate(contrastSamples);
  console.log('LIGHT CONTRAST',JSON.stringify(samples));
  if(!diagnose) {
    for(const preset of await page.evaluate(()=>window.__presets)) {
      await page.evaluate(p=>window.__theme('light',p),preset);
      const themed=await page.evaluate(contrastSamples);
      // Media chrome is intentionally dark for dark presets; verify the themed information panel here.
      for(const s of themed.filter(s=>s.selector.startsWith('.pv-media-'))) assert.ok(!s.missing&&s.ratio>=4.5,`${preset}: ${JSON.stringify(s)}`);
    }
    await page.evaluate(()=>window.__theme('light'));
    await page.evaluate(()=>document.querySelector('.pv-media-info-panel').classList.add('is-collapsed','is-dragging','drag-target-bottom'));
    for(const s of await page.evaluate(contrastSamples)) assert.ok(!s.missing&&s.ratio>=4.5,`floating panel: ${JSON.stringify(s)}`);
    await page.evaluate(()=>document.querySelector('.pv-media-info-panel').classList.remove('is-collapsed','is-dragging','drag-target-bottom'));
  }
  const surface=page.locator('.pv-video-surface');
  const time=()=>page.evaluate(()=>window.__fixture.playback.time);
  const reset=async()=>{await page.evaluate(()=>window.__fixture.playback.time=60);await page.waitForTimeout(500)};
  const bounds=await surface.boundingBox();
  await page.waitForFunction(()=>window.__fixture.listeners['pixvault://vlc-input/viewer-job']);
  await page.evaluate(async()=>{
    const rect=document.querySelector('.pv-video-surface').getBoundingClientRect();
    const send=window.__fixture.listeners['pixvault://vlc-input/viewer-job'];
    const x=(rect.x+rect.width*.8)*devicePixelRatio,y=(rect.y+rect.height*.5)*devicePixelRatio;
    const tap=()=>{send({payload:{kind:'pointerdown',x,y,buttons:1,delta:0}});send({payload:{kind:'pointerup',x,y,buttons:0,delta:0}})};
    tap();await new Promise(resolve=>setTimeout(resolve,150));tap();
  });
  await page.waitForFunction(()=>window.__fixture.playback.time===70);
  assert.equal(await time(),70,'native HWND input bridge reaches actual React double-tap seek');
  await reset();
  await page.getByRole('button',{name:'すべての枠を非表示（Escで戻す）'}).click();
  assert.equal(await page.locator('.pv-viewer-header').count(),0,'hide-all removes viewer chrome');
  await page.getByRole('button',{name:'すべての枠を表示（Esc）'}).click();
  assert.equal(await page.locator('.pv-viewer-header').count(),1,'viewer chrome can be restored without closing media');
  await page.evaluate(async()=>{
    const rect=document.querySelector('.pv-video-surface').getBoundingClientRect();
    const send=window.__fixture.listeners['pixvault://vlc-input/viewer-job'];
    const x=(rect.x+rect.width*.8)*devicePixelRatio,y=(rect.y+rect.height*.5)*devicePixelRatio;
    const tap=()=>{send({payload:{kind:'pointerdown',x,y,buttons:1,delta:0}});send({payload:{kind:'pointerup',x,y,buttons:0,delta:0}})};
    tap();await new Promise(resolve=>setTimeout(resolve,150));tap();
  });
  await page.waitForFunction(()=>window.__fixture.playback.time===70);
  await reset();
  await surface.dblclick({position:{x:bounds.width*.8,y:bounds.height*.5}});
  const mouseTime=await time();await reset();
  // Reproduce WebViews which don't deliver a compatibility dblclick for touch.
  await page.evaluate(()=>document.addEventListener('dblclick',e=>e.stopImmediatePropagation(),true));
  await surface.tap({position:{x:bounds.width*.8,y:bounds.height*.5}});
  await surface.tap({position:{x:bounds.width*.8,y:bounds.height*.5}});
  await page.waitForTimeout(600);
  const touchTime=await time();
  console.log('VIDEO SEEK',{mouseTime,touchTime});
  if(!diagnose){
    assert.equal(mouseTime,70);assert.equal(touchTime,70);
    for(const s of samples)assert.ok(!s.missing&&s.ratio>=4.5,JSON.stringify(s));
    await reset();
    const pauses=await page.evaluate(()=>window.__fixture.pauseCalls);
    await surface.click({position:{x:bounds.width*.2,y:bounds.height*.5}});
    await page.waitForTimeout(350);
    await surface.click({position:{x:bounds.width*.2,y:bounds.height*.5}});
    await page.waitForTimeout(500);
    assert.equal(await time(),50,'slow double tap seeks backwards without toggling playback');
    assert.equal(await page.evaluate(()=>window.__fixture.pauseCalls),pauses);
    await surface.click({position:{x:bounds.width*.5,y:bounds.height*.5}});
    await page.waitForTimeout(550);
    assert.equal(await page.evaluate(()=>window.__fixture.pauseCalls),pauses+1,'single click still pauses');
    const cdp=await context.newCDPSession(page);
    const touch={x:bounds.x+bounds.width*.8,y:bounds.y+bounds.height*.5,id:5};
    await reset();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touch,x:touch.x+40}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForTimeout(550);
    assert.equal(await time(),60);
    assert.equal(await page.evaluate(()=>window.__fixture.playCalls),1,'drag must not toggle playback');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    await page.waitForTimeout(550);
    assert.equal(await time(),60,'cancelled touch must not seek');
    await surface.focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.__fixture.playCalls),2,'keyboard playback is supported');
    await surface.click({position:{x:bounds.width*.8,y:bounds.height*.5}});
    await page.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.waitForTimeout(550);
    assert.equal(await page.evaluate(()=>window.__fixture.pauseCalls),pauses+1,'close cancels pending single tap');
    assert.deepEqual(await page.evaluate(()=>window.__fixture.unexpected),[]);
    console.log('Viewer interactions passed: 20 themed info panels; mouse/touch/slow/single/drag/cancel/keyboard/close.');
  }
  if(diagnose) {
    await page.goto(base+'?order');
    await page.getByRole('button',{name:'次の本',exact:true}).waitFor();
    const order={nextDisabled:await page.getByRole('button',{name:'次の本',exact:true}).isDisabled(),
      rail:await page.locator('.pv-viewer-rail-name').allTextContents()};
    console.log('ORDER DIAGNOSIS (not a repaired behavior)',JSON.stringify(order));
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>window.__fixture.unexpected),[]);
} finally {await browser?.close();await server.close();}
