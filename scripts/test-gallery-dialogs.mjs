// Headless DOM coverage only. No desktop state, screenshots, or native media playback.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root, configFile: false, logLevel: "error",
  plugins: [react(), {
    name: "gallery-dialog-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__gallery_dialogs", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div>
          <script type="module">
            import RefreshRuntime from '/@react-refresh';
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
            window.__vite_plugin_react_preamble_installed__=true;
          </script>
          <script type="module" src="/@vite/client"></script>
          <script type="module">
            import React from '/node_modules/.vite/deps/react.js';
            import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
            import { GallerySearchModal, EMPTY_GALLERY_SEARCH_FILTERS } from '/src/components/GallerySearchModal.tsx';
            import { MediaCollection } from '/src/components/MediaCollection.tsx';
            import '/src/App.css';
            function Fixture(){
              const [search,setSearch]=React.useState(true);
              return React.createElement('div',{className:'app-shell'},React.createElement('main',{className:'main-panel'},
                React.createElement(MediaCollection,{eyebrow:'GALLERY',title:'ギャラリー',description:'fixture',emptyTitle:'空',emptyDescription:'空',advancedGallerySearch:true,compactFileLayout:true}),
                React.createElement(GallerySearchModal,{open:search,value:{...EMPTY_GALLERY_SEARCH_FILTERS,rootId:'root'},onApply:value=>{window.applied=value;setSearch(false)},onClear:()=>{},onClose:()=>setSearch(false)})));
            }
            ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
          </script></body></html>`);
      });
    },
  }],
  optimizeDeps: { entries: ["src/components/MediaCollection.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/src-tauri/**", "**/release/**"] } },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  for (const [width, height] of [[853, 903], [1024, 600], [390, 600], [640, 360], [760, 600], [1440, 900]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.calls = [];
      const longName='サンプルとても長いファイル名_'.repeat(6)+'.mp4';
      const item = { id:"media-1",rootId:"root",relativePath:"Folder/"+longName,path:"E:\\Folder\\"+longName,name:longName,kind:"video",mimeType:"video/mp4",sizeBytes:12345678,width:1920,height:1080,durationSeconds:94,isFavorite:true,ageRating:"SFW",modifiedAt:"2026-09-13T00:00:00Z",importedAt:"2026-09-12T00:00:00Z",tags:[{id:"tag-199",name:"last-tag",source:"user"}] };
      const items=[item,{...item,id:'media-2',kind:'image',name:'image.png',mimeType:'image/png',durationSeconds:undefined},{...item,id:'media-3',kind:'zip',name:'book.cbz',mimeType:'application/zip',durationSeconds:undefined,pageCount:32}];
      window.__TAURI_INTERNALS__ = { invoke: async (command, args={}) => {
        window.calls.push(command);
        if(command==='get_media_items_by_ids') return [item];
        if(command==='get_media_page_info') return {totalCount:3,dateGroups:[]};
        if(command==='list_media_items') return items;
        if(command==='list_library_roots') return [{id:'root',path:'E:\\',displayName:'Library',isPriority:true,mediaCount:1}];
        if(command==='list_tags') return Array.from({length:200},(_,i)=>({id:'tag-'+i,name:i===199?'last-tag':'Tag '+String(i).padStart(3,'0')}));
        if(command==='list_tag_translations') return {};
        if(command==='list_media_folders') return [{rootId:'root',relativeFolder:'Folder',itemCount:1}];
        if(command==='get_media_thumbnails') return [];
        if(command==='get_media_thumbnail') return null;
        if(command==='load_app_preferences') return {};
        if(command==='get_setting') return null;
        if(command==='reveal_media_in_explorer') return true;
        return null;
      } };
    });
    await page.goto(`http://127.0.0.1:${address.port}/__gallery_dialogs`);
    await page.locator(".gallery-search-tag-list > button").last().waitFor();
    await page.locator(".gallery-search-body").first().evaluate(element => { element.scrollTop = element.scrollHeight; });
    const geometry = await page.evaluate(() => {
      const body = document.querySelector('.gallery-search-body');
      const tags = document.querySelector('.gallery-search-tag-list');
      const footer = document.querySelector('.gallery-search-footer');
      return { body:body.getBoundingClientRect().toJSON(),tags:tags.getBoundingClientRect().toJSON(),footer:footer.getBoundingClientRect().toJSON(),overflow:document.querySelector('.gallery-search-dialog').scrollWidth-document.querySelector('.gallery-search-dialog').clientWidth };
    });
    assert.ok(geometry.body.height > 80, `${width}x${height}: search retains a usable scroll area`);
    assert.ok(geometry.tags.bottom <= geometry.body.bottom + 1, `${width}x${height}: complete tag list reaches above the footer: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.body.bottom <= geometry.footer.top + 1, "search footer never covers the scrolled content");
    assert.ok(geometry.footer.bottom <= height, "footer is inside the viewport");
    assert.ok(geometry.overflow <= 1, "dialog does not overflow horizontally");
    await page.locator(".gallery-search-tag-list").first().evaluate(element => { element.scrollTop=element.scrollHeight; });
    await page.getByRole('button',{name:'last-tag',exact:true}).click();
    await page.getByRole('button',{name:'この条件で検索',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.applied.tagIds),['tag-199']);
    if ([1024,760,1440].includes(width)) {
      await page.locator('.media-type-label').last().waitFor();
      const verifyCards = async (mode) => {
        const cards=await page.locator('.media-card').evaluateAll(elements=>elements.map(element=>{
          const rect=node=>node.getBoundingClientRect().toJSON();
          const visual=element.querySelector('.media-visual');
          const icon=element.querySelector('.media-type-label');
          const name=element.querySelector('.media-copy strong');
          const actions=element.querySelector('.media-card-actions');
          const buttons=[...actions.querySelectorAll('button')];
          return {card:rect(element),visual:rect(visual),icon:rect(icon),iconColor:getComputedStyle(icon).color,name:rect(name),nameFont:parseFloat(getComputedStyle(name).fontSize),actions:rect(actions),opacity:getComputedStyle(actions).opacity,buttons:buttons.map(button=>({rect:rect(button),label:button.getAttribute('aria-label')}))};
        }));
        assert.equal(cards.length,3,'all three media types are represented');
        assert.equal(new Set(cards.map(card=>card.iconColor)).size,3,'video, image and book have distinct colored icons');
        for (const card of cards) {
          assert.ok(card.icon.left>=card.visual.left && card.icon.left-card.visual.left<=10,`${mode}: type icon is at left edge`);
          assert.ok(card.icon.top>=card.visual.top && card.icon.top-card.visual.top<=10,`${mode}: type icon is at top edge`);
          assert.ok(card.nameFont>=12,`${mode}: filename is readable`);
          assert.ok(card.name.bottom<=card.card.bottom+1 && card.name.left>=card.card.left,`${mode}: filename fits the card`);
          if(mode==='list'||mode==='details') {
            assert.equal(card.opacity,'1',`${mode}: favorite and delete remain visible without hover`);
            assert.ok(card.name.right<=card.actions.left+1,`${mode}: filename never overlaps actions`);
            for(const button of card.buttons) assert.ok(button.rect.right<=card.card.right+1 && button.rect.bottom<=card.card.bottom+1,`${mode}: ${button.label} fits`);
          }
        }
      };
      await verifyCards('medium-icons');
      for(const [mode,label] of [['list','一覧'],['details','詳細']]) {
        await page.locator('.media-card').first().click({button:'right'});
        await page.getByRole('menuitemradio',{name:label,exact:true}).click();
        await page.locator('.view-mode-'+mode).waitFor();
        await page.waitForFunction(()=>[...document.querySelectorAll('.media-card-actions')].every(element=>getComputedStyle(element).opacity==='1'));
        await verifyCards(mode);
      }
      await page.locator('.media-card').first().click({button:'right'});
      await page.getByRole('menuitem',{name:'プロパティ',exact:true}).click();
      const dialog = page.getByRole('dialog',{name:'プロパティ',exact:true});
      await dialog.waitFor();
      await dialog.getByText('video/mp4',{exact:true}).waitFor();
      for (const label of ['ファイル名','形式','MIME','ファイルサイズ','寸法','アスペクト比','再生時間','更新日時','登録日時']) {
        assert.equal(await dialog.locator('dt').filter({hasText:label}).count(),1,`properties includes ${label}`);
      }
      await dialog.getByText('last-tag',{exact:true}).waitFor();
      assert.equal(await dialog.locator('video').count(),0,'properties never starts playback');
      assert.equal(await dialog.locator('.pv-media-info-drag-handle').count(),0,'properties is not a floating viewer panel');
      assert.equal(await dialog.locator('.pv-media-recommendation-grid').count(),0,'properties does not load recommendations');
      assert.equal(await dialog.locator('.pv-media-info-tags button').count(),0,'properties tags do not lead to navigation behind the dialog');
      const metadata=await dialog.evaluate(element=>{
        const content=element.querySelector('.media-properties-body');
        return {overflow:content.scrollWidth-content.clientWidth,fields:[...element.querySelectorAll('.pv-media-info-list dd')].map(field=>({overflow:field.scrollWidth-field.clientWidth,font:parseFloat(getComputedStyle(field).fontSize)}))};
      });
      assert.ok(metadata.overflow<=1,'enlarged properties fit without horizontal scroll');
      assert.ok(metadata.fields.every(field=>field.overflow<=1 && field.font>=12),'all metadata values wrap and remain legible');
      const calls=await page.evaluate(()=>window.calls);
      assert.ok(calls.includes('get_media_items_by_ids'),'refreshes only the requested file metadata');
      assert.ok(!calls.some(call=>/recommendation|video_playback/.test(call)),'no AI scan or playback work for properties');
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
    }
    assert.deepEqual(errors,[],'no browser runtime errors');
    console.log(`PASS ${width}x${height}: complete advanced-search scroll, final tag selection, visible footer${[1024,760,1440].includes(width)?', left-top media icons, list/details actions and filenames, properties metadata, no playback':''}`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
