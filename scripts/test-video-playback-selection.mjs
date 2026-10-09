import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const fixture = `import React, {useRef,useState,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {useVideoPlayback} from '/src/hooks/useVideoPlayback.ts';
function Fixture(){
 const [item,setItem]=useState({id:'a',mime:'video/mp4'});
 const video=useRef(null), canvas=useRef(null);
 const loading=useCallback(value=>{window.loading=value},[]);
 const playback=useVideoPlayback(item.id,video,canvas,{volume:.5,muted:false,loop:false,mimeType:item.mime},loading);
 window.current=()=>({playback,video:video.current}); window.select=setItem;
 return <div>{playback.native?<canvas ref={canvas}/>:<video ref={video}/>}<span>{playback.phase}</span></div>;
} createRoot(document.getElementById('root')).render(<Fixture/>);`;
const fakeVlc = `export class VlcVideoHandle extends EventTarget {
 readyState=0; error=null;
 constructor(){super(); window.opened++;window.nativePlayer=this;}
 async dispose(){window.disposed++;}
}`;
const server = await createServer({ root, configFile:false, logLevel:'error',
 server:{host:'127.0.0.1',port:0,watch:{ignored:['**/src-tauri/**','**/artifacts/**']}},
 plugins:[{name:'selection-fixtures', enforce:'pre',
 resolveId(id){if(id==='/__fixture.tsx')return '/virtual/__fixture.tsx';if(id==='/__fake-vlc.js')return '/virtual/__fake-vlc.js';},
 load(id){if(id==='/virtual/__fixture.tsx')return fixture;if(id==='/virtual/__fake-vlc.js')return fakeVlc;},
 transform(code,id){if(id.endsWith('/src/hooks/useVideoPlayback.ts')) return code.replace('"../services/vlcPlayer"','"/__fake-vlc.js"');},
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
   if(req.url==='/__fake-vlc.js'){res.setHeader('Content-Type','application/javascript');res.end(fakeVlc);}
   else if(req.url==='/__selection'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/__fixture.tsx"></script>');}
   else next();
 });}},react({include:/src\/.*\.[jt]sx?$/})] });
let browser;
try {
 await server.listen();
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
 await page.addInitScript(()=>{
   window.opened=0;window.disposed=0;window.__TAURI_INTERNALS__={};
   Object.defineProperty(navigator,'platform',{value:'Win32'});
   HTMLMediaElement.prototype.canPlayType=function(type){return type==='video/mp4'?'maybe':'';};
   const original=setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===8000?500:ms,...args);
 });
 const fresh=async()=>{await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__selection`);await page.waitForFunction(()=>window.current);};
 await fresh();
 await page.evaluate(()=>{Object.defineProperty(current().video,'readyState',{value:4});current().video.dispatchEvent(new Event('canplay'));});
 await page.waitForFunction(()=>current().playback.phase==='ready');
 await page.waitForTimeout(600);
 assert.equal(await page.evaluate(()=>opened),0,'supported, ready media never opens VLC');
 await page.evaluate(()=>{window.oldVideo=current().video;oldVideo.dispatchEvent(new Event('error'));});
 await page.waitForFunction(()=>opened===1);
 await page.evaluate(()=>{nativePlayer.readyState=4;nativePlayer.dispatchEvent(new Event('playing'));});
 await page.waitForFunction(()=>current().playback.phase==='ready');
 await page.evaluate(()=>select({id:'b',mime:'video/mp4'}));
 await page.waitForFunction(()=>!current().playback.native && disposed===1);
 await page.evaluate(()=>{oldVideo.dispatchEvent(new Event('error'));Object.defineProperty(current().video,'readyState',{value:4});current().video.dispatchEvent(new Event('canplay'));});
 assert.equal(await page.evaluate(()=>opened),1,'stale media events cannot restart VLC');
 await page.evaluate(()=>select({id:'c',mime:'video/x-matroska'}));
 await page.waitForFunction(()=>opened===2);
 assert.equal(await page.evaluate(()=>current().playback.native),true,'unsupported containers bypass browser probing');
 await page.evaluate(()=>{nativePlayer.error=new Error('decoder failed');nativePlayer.dispatchEvent(new Event('error'));});
 await page.waitForFunction(()=>current().playback.phase==='error');
 await page.evaluate(()=>current().playback.retry());
 await page.waitForFunction(()=>opened===3);
 await fresh();
 await page.waitForFunction(()=>opened===1);
 assert.equal(await page.evaluate(()=>current().playback.native),true,'stalled browser startup falls back without conversion');
 assert.deepEqual(errors,[]);
 console.log('PASS browser playback, codec fallback, native errors/retry, media switching, stale events, startup timeout');
} finally {await browser?.close();await server.close();}
