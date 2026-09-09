// Play the synthetic files created by the Rust real_compatibility_formats test.
// This uses headless Chromium and never inspects the user's desktop or media.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const root=resolve(import.meta.dirname,'../artifacts/video-playback-tests/samples');
const files=readdirSync(root).filter(name=>/\.(webm|mp4)$/.test(name));
assert.ok(files.length>=5,'run the native synthetic video test first');
const server=createServer((req,res)=>{
  const name=decodeURIComponent(req.url.slice(1));
  if(!files.includes(name)){res.writeHead(404);res.end();return}
  const data=readFileSync(resolve(root,name));
  res.setHeader('Content-Type',name.endsWith('.mp4')?'video/mp4':'video/webm');
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Accept-Ranges','bytes');
  const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
  if(range){
    const from=Number(range[1]),to=Math.min(data.length-1,range[2]?Number(range[2]):data.length-1);
    res.writeHead(206,{'Content-Range':`bytes ${from}-${to}/${data.length}`,'Content-Length':to-from+1});res.end(data.subarray(from,to+1));
  }else{res.setHeader('Content-Length',data.length);res.end(data)}
});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});const page=await browser.newPage();
  for(const file of files){
    await page.setContent(`<video muted playsinline crossorigin="anonymous" src="http://127.0.0.1:${server.address().port}/${encodeURIComponent(file)}"></video>`);
    const result=await page.locator('video').evaluate(async video=>{
      await video.play();
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No decoded video frame')),10000);
        video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve()});});
      return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,error:video.error?.code};
    });
    assert.equal(result.width,160);assert.equal(result.height,96);assert.ok(result.duration>0);assert.equal(result.error,undefined);
    console.log('PASS Chromium frame decoded:',file);
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
