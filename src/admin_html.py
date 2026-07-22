ADMIN_HTML = r"""<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/assets/luma-studio-favicon.png">
  <link rel="apple-touch-icon" href="/assets/luma-studio-favicon.png">
  <title>Luma Studio · ibon 圖檔管理</title>
  <style>
    :root { color-scheme:light; font-family:"Segoe UI", "Microsoft JhengHei", system-ui, sans-serif; background:#f7f6f2; color:#1e2938; }
    * { box-sizing:border-box; } body { margin:0; min-height:100vh; background:#f7f6f2; }
    main { max-width:1080px; margin:0 auto; padding:44px 24px 72px; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; border-bottom:1px solid #d8ddd7; padding-bottom:26px; }
    .brand-logo { display:block; width:154px; height:auto; } h2 { font-size:1.125rem; margin:0; color:#1f3343; } p { color:#596775; line-height:1.5; }
    button, input { font:inherit; } button { border:1px solid #247e78; border-radius:7px; padding:9px 13px; background:#287f79; color:#fff; cursor:pointer; font-weight:600; transition:background-color .15s ease, border-color .15s ease; }
    button:hover:not(:disabled) { background:#1f6e69; border-color:#1f6e69; } button:disabled { cursor:not-allowed; opacity:.55; } button.danger { background:#b74355; border-color:#b74355; } button.danger:hover:not(:disabled) { background:#9f3447; border-color:#9f3447; } button.ghost { background:#fff; color:#405160; border-color:#c8d0cc; }
    button:focus-visible, input:focus-visible { outline:3px solid #a7d5d0; outline-offset:2px; }
    .grid { display:grid; grid-template-columns:320px minmax(0, 1fr); gap:28px; margin-top:32px; } .card { background:#fff; border:1px solid #d8ddd7; border-radius:10px; padding:22px; }
    .row { display:flex; gap:10px; align-items:center; } .row input { min-width:0; flex:1; padding:10px 11px; border:1px solid #bbc6c1; border-radius:7px; background:#fff; color:#1e2938; }
    .folders, .files { list-style:none; padding:0; margin:16px 0 0; } li { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:11px 0; border-bottom:1px solid #e1e5e1; }
    .folder { flex:1; text-align:left; border:0; background:transparent; padding:6px 4px; color:#253746; font-weight:600; } .folder:hover:not(:disabled) { background:#edf5f3; color:#1e625e; } .folder-row.selected { margin:0 -8px; padding:11px 8px; border-radius:7px; background:#edf5f3; border-bottom-color:transparent; }
    .copy-link { display:grid; place-items:center; flex:0 0 36px; width:36px; height:36px; padding:0; border:1px solid #c7d2cd; border-radius:7px; background:#fff; color:#3a6c68; } .copy-link:hover:not(:disabled) { background:#edf5f3; border-color:#80aaa4; } .copy-link svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; } .copy-link.copied { border-color:#287f79; background:#e6f2ef; color:#19665f; animation:copy-success .45s cubic-bezier(.16,1,.3,1); } @keyframes copy-success { 50% { transform:translateY(-3px) scale(1.08); } }
    .file-name { min-width:0; overflow-wrap:anywhere; font-weight:600; } .file-actions { display:flex; flex:0 0 auto; gap:8px; align-items:center; } .muted { color:#697683; font-size:.875rem; }
    #status { position:fixed; z-index:10; left:50%; bottom:28px; width:max-content; max-width:calc(100vw - 32px); margin:0; padding:12px 16px; border-radius:8px; background:#263b47; color:#fff; box-shadow:0 12px 30px rgba(23,44,60,.22); font-weight:600; line-height:1.45; opacity:0; pointer-events:none; transform:translate(-50%, 16px); transition:opacity .2s ease, transform .2s ease; } #status.visible { opacity:1; transform:translate(-50%, 0); } #status.error { background:#9f3447; } #status.ok { background:#216c66; }
    .empty { padding:24px 0; color:#71808a; text-align:center; }
    .print-settings { margin:26px 0 24px; padding:20px 0 22px; border-top:1px solid #e1e5e1; border-bottom:1px solid #e1e5e1; } .print-settings-header { display:flex; justify-content:space-between; gap:14px; align-items:baseline; } .print-settings-header p { margin:4px 0 0; }
    .setting-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:17px 22px; margin:18px 0 0; } fieldset { min-width:0; margin:0; padding:0; border:0; } legend { padding:0; color:#253746; font-weight:700; } .choices { display:flex; flex-wrap:wrap; gap:7px; margin-top:8px; }
    button.choice { min-height:38px; border-color:#d1d9d4; background:#f3f5f2; color:#45545d; font-size:.875rem; } button.choice:hover:not(:disabled) { border-color:#80aaa4; background:#edf5f3; color:#1e625e; } button.choice.selected { border-color:#247e78; background:#287f79; color:#fff; } button.choice:disabled { border-color:#e1e5e1; background:#f7f8f6; color:#a4afaa; opacity:1; }
    .print-summary { margin:17px 0 0; color:#536371; font-size:.92rem; } .print-summary strong { color:#1f3343; } .cache-notice { margin:12px 0 0; padding:10px 12px; border-radius:7px; background:#f3f6f2; color:#596775; font-size:.875rem; line-height:1.55; }
    .upload-area { margin:22px 0 0; } .drop-zone { display:grid; width:100%; min-height:142px; place-items:center; gap:7px; padding:22px; border:1.5px dashed #90b9b3; border-radius:9px; background:#f5faf8; color:#245f5b; text-align:center; cursor:pointer; } button.drop-zone { border-color:#90b9b3; background:#f5faf8; color:#245f5b; } button.drop-zone:hover:not(:disabled), button.drop-zone.drag-over { border-color:#287f79; background:#e8f4f1; } button.drop-zone:disabled { border-color:#d9e1dd; background:#f6f7f5; color:#8a9992; } .drop-zone-icon { font-size:1.65rem; line-height:1; } .drop-zone-title { font-weight:700; line-height:1.55; } .drop-zone-hint { color:#687780; font-size:.875rem; font-weight:400; } .upload-progress { display:grid; gap:7px; margin-top:12px; } .upload-progress[hidden] { display:none; } .upload-progress-label { color:#52636e; font-size:.875rem; } .progress-track { height:7px; overflow:hidden; border-radius:99px; background:#e0e8e4; } .progress-bar { width:0; height:100%; border-radius:inherit; background:#287f79; transition:width .2s ease-out; } .upload-limit { margin:22px 0 0; padding:16px; border:1px solid #d7e1dc; border-radius:8px; background:#f3f6f2; color:#536371; line-height:1.55; } .folder-actions { display:flex; justify-content:flex-end; margin-top:14px; }
    @media (max-width:720px) { main { padding:28px 16px 48px; } .grid { grid-template-columns:1fr; gap:18px; } .brand-logo { width:126px; } .row { align-items:stretch; flex-wrap:wrap; } .setting-grid { grid-template-columns:1fr; gap:15px; } button.choice { min-height:44px; } button.drop-zone { min-height:154px; } .file-actions button { min-height:44px; } }
  </style>
</head>
<body>
  <main>
    <header><img class="brand-logo" src="/assets/luma-studio-logo.png" alt="Luma Studio 南光繪誌"><button id="logout" class="ghost">登出</button></header>
    <div id="status" aria-live="polite"></div>
    <section class="grid">
      <div class="card"><h2>資料夾</h2><p class="muted">資料夾名稱就是列印 API 的 id。</p>
        <div class="row"><input id="new-folder" maxlength="128" placeholder="例如 20260721_soda"><button id="create-folder">新增</button></div>
        <ul id="folders" class="folders"></ul>
      </div>
      <div class="card"><h2 id="file-title">請選擇資料夾</h2><p class="muted">可上傳 jpg、jpeg、png、bmp、gif；每個列印資料夾最多 8 張、總計 15 MB。</p><p class="cache-notice">圖片上傳、刪除或列印規格異動時，會清除這個資料夾的 pincode 快取；下次公開列印將重新建立取件編號。</p>
        <section id="print-settings" class="print-settings" hidden aria-labelledby="print-settings-title">
          <div class="print-settings-header"><div><h2 id="print-settings-title">列印規格</h2><p class="muted">規格異動會清除目前資料夾的 ibon 快取。</p></div></div>
          <div class="setting-grid">
            <fieldset><legend>紙張尺寸</legend><div class="choices"><button type="button" class="choice" data-setting="paper" data-value="A4">A4</button><button type="button" class="choice" data-setting="paper" data-value="A3">A3</button><button type="button" class="choice" data-setting="paper" data-value="4x6">4x6</button><button type="button" class="choice" data-setting="paper" data-value="4x6sticker">4x6貼紙</button></div></fieldset>
            <fieldset><legend>色彩模式</legend><div class="choices"><button type="button" class="choice" data-setting="color" data-value="mono">黑白</button><button type="button" class="choice" data-setting="color" data-value="color">彩色</button></div></fieldset>
            <fieldset><legend>列印模式</legend><div class="choices"><button type="button" class="choice" data-setting="sides" data-value="single">單面列印</button><button type="button" class="choice" data-setting="sides" data-value="double">雙面列印</button></div></fieldset>
            <fieldset><legend>紙張種類</legend><div class="choices"><button type="button" class="choice" data-setting="paperType" data-value="common">一般用紙</button><button type="button" class="choice" data-setting="paperType" data-value="special">特殊用紙</button></div></fieldset>
          </div>
          <p id="print-summary" class="print-summary"></p>
        </section>
        <section id="upload-area" class="upload-area" hidden aria-label="圖片上傳">
          <input id="files" type="file" accept=".jpg,.jpeg,.png,.bmp,.gif" multiple hidden>
          <button id="drop-zone" class="drop-zone" type="button" disabled><span class="drop-zone-icon" aria-hidden="true">⇧</span><span class="drop-zone-title">拖曳檔案至此<br>／點擊這裡選擇檔案即可上傳</span><span id="upload-slots" class="drop-zone-hint"></span></button>
          <div id="upload-progress" class="upload-progress" hidden aria-live="polite"><span id="upload-progress-label" class="upload-progress-label"></span><div class="progress-track"><div id="upload-progress-bar" class="progress-bar"></div></div></div>
        </section>
        <p id="upload-limit" class="upload-limit" hidden></p>
        <div class="folder-actions"><button id="delete-folder" class="danger" disabled>刪除空資料夾</button></div>
        <ul id="files-list" class="files"><li class="empty">尚未選擇資料夾</li></ul>
      </div>
    </section>
  </main>
  <script>
    const defaultPrint = { paper: 'A4', color: 'color', sides: 'single', paperType: 'common' };
    const MAX_FILE_COUNT = 8;
    const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
    const imagePattern = /\.(jpg|jpeg|png|bmp|gif)$/i;
    const state = { folder: null, files: [], print: { ...defaultPrint }, uploading: false };
    const printUrlBase = 'https://luma-studio.infixman.workers.dev/ibon_print/';
    const status = document.querySelector('#status');
    let statusTimer;
    const setStatus = (text, kind='') => { clearTimeout(statusTimer); status.textContent=text; status.className='visible '+kind; statusTimer=setTimeout(()=>{ status.className=''; }, 4200); };
    async function api(path, options={}) {
      const response = await fetch(path, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '操作失敗');
      return body;
    }
    function esc(value) { return String(value); }
    function isPhotoPaper() { return state.print.paper === '4x6' || state.print.paper === '4x6sticker'; }
    function selectTypeFromPrint() {
      if (state.print.paper === '4x6') return 'F4X6N1';
      if (state.print.paper === '4x6sticker') return 'F4X6S1';
      return 'F' + state.print.paper + (state.print.color === 'color' ? 'C' : 'B') + (state.print.paperType === 'common' ? 'N' : 'S') + (state.print.sides === 'single' ? '1' : '2');
    }
    function printFromSelectType(selectType) {
      if (selectType === 'F4X6N1') return { paper: '4x6', color: 'color', sides: 'single', paperType: 'common' };
      if (selectType === 'F4X6S1') return { paper: '4x6sticker', color: 'color', sides: 'single', paperType: 'common' };
      const match = /^F(A[34])(C|B)(N|S)(1|2)$/.exec(selectType);
      if (!match) return { ...defaultPrint };
      return { paper: match[1], color: match[2] === 'C' ? 'color' : 'mono', paperType: match[3] === 'N' ? 'common' : 'special', sides: match[4] === '1' ? 'single' : 'double' };
    }
    function syncPrintSettings(summary='') {
      const photoPaper = isPhotoPaper();
      document.querySelectorAll('[data-setting]').forEach(button => {
        const setting = button.dataset.setting; const value = button.dataset.value;
        const unavailable = photoPaper && setting !== 'paper' && value !== (setting === 'color' ? 'color' : setting === 'sides' ? 'single' : 'common');
        button.disabled = !state.folder || unavailable;
        button.classList.toggle('selected', state.print[setting] === value);
      });
      document.querySelector('#print-summary').textContent = summary || '下一次列印將使用：' + selectTypeFromPrint();
    }
    async function loadPrintSettings() {
      const data = await api('/api/admin/print-settings?folder=' + encodeURIComponent(state.folder));
      state.print = printFromSelectType(data.selectType);
      syncPrintSettings('目前規格：' + data.printSpec + '（' + data.selectType + '）');
    }
    async function savePrintSettings() {
      const data = await api('/api/admin/print-settings', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({folder:state.folder, selectType:selectTypeFromPrint()}) });
      syncPrintSettings('目前規格：' + data.printSpec + '（' + data.selectType + '）');
      if (data.cacheInvalidated) setStatus('列印規格已更新，該資料夾的列印快取已清除。', 'ok');
    }
    function showCopied(button, label) {
      const originalHtml = button.innerHTML; const originalLabel = button.getAttribute('aria-label');
      button.classList.add('copied'); button.setAttribute('aria-label','已複製 '+label);
      button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>';
      setTimeout(()=>{ button.classList.remove('copied'); button.setAttribute('aria-label',originalLabel); button.innerHTML=originalHtml; }, 1800);
    }
    async function copyUrl(url, button, label) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const field = document.createElement('textarea'); field.value = url; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.append(field); field.select();
        const copied = document.execCommand('copy'); field.remove();
        if (!copied) throw new Error('無法複製網址');
      }
      showCopied(button, label); setStatus('已複製「'+label+'」的網址。', 'ok');
    }
    async function copyPrintUrl(folder, button) {
      await copyUrl(printUrlBase + encodeURIComponent(folder), button, folder+' 的列印頁');
    }
    function publicImageUrl(key) {
      return location.origin + '/images/' + key.split('/').map(encodeURIComponent).join('/');
    }
    function updateUploadUi() {
      const area=document.querySelector('#upload-area'); const input=document.querySelector('#files'); const zone=document.querySelector('#drop-zone'); const slots=document.querySelector('#upload-slots'); const limit=document.querySelector('#upload-limit');
      const remaining=Math.max(0, MAX_FILE_COUNT-state.files.length); const full=state.folder && remaining===0;
      area.hidden=!state.folder || full; limit.hidden=!full;
      limit.textContent=full ? '已達上傳上限（8 / 8 張）。請先刪除圖檔後再上傳。' : '';
      input.disabled=!state.folder || state.uploading || full; zone.disabled=!state.folder || state.uploading || full;
      slots.textContent=state.folder ? '目前 '+state.files.length+' / '+MAX_FILE_COUNT+' 張，還可上傳 '+remaining+' 張。' : '';
    }
    function setUploadProgress(value, label='') {
      const progress=document.querySelector('#upload-progress'); const bar=document.querySelector('#upload-progress-bar');
      progress.hidden=!label; document.querySelector('#upload-progress-label').textContent=label; bar.style.width=Math.round(value*100)+'%';
    }
    async function loadFolders() {
      const data = await api('/api/admin/folders');
      const root = document.querySelector('#folders'); root.replaceChildren();
      if (!data.folders.length) { root.innerHTML='<li class="empty">沒有資料夾</li>'; return; }
      for (const folder of data.folders) {
        const li=document.createElement('li'); li.className='folder-row'+(folder===state.folder ? ' selected' : '');
        const select=document.createElement('button'); select.className='folder'; select.textContent='📁 '+esc(folder); select.onclick=()=>selectFolder(folder);
        const copy=document.createElement('button'); copy.className='copy-link'; copy.type='button'; copy.title='複製列印網址'; copy.setAttribute('aria-label','複製 '+folder+' 的列印網址');
        copy.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"></rect><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"></path></svg>';
        copy.onclick=async()=>{ try { await copyPrintUrl(folder, copy); } catch (error) { setStatus(error.message || '無法複製網址','error'); } };
        li.append(select,copy); root.append(li);
      }
    }
    async function selectFolder(folder) {
      state.folder=folder; document.querySelector('#file-title').textContent='資料夾：'+folder;
      document.querySelectorAll('.folder-row').forEach(item=>item.classList.toggle('selected',item.querySelector('.folder').textContent==='📁 '+folder));
      document.querySelector('#delete-folder').disabled=false;
      document.querySelector('#print-settings').hidden=false;
      updateUploadUi();
      await Promise.all([loadFiles(), loadPrintSettings()]);
    }
    async function loadFiles() {
      const data=await api('/api/admin/objects?folder='+encodeURIComponent(state.folder));
      state.files=data.objects; updateUploadUi();
      const root=document.querySelector('#files-list'); root.replaceChildren();
      if (!data.objects.length) { root.innerHTML='<li class="empty">沒有圖檔</li>'; return; }
      for (const item of data.objects) {
        const li=document.createElement('li'); const name=document.createElement('span'); name.className='file-name'; name.textContent=item.name+' ('+Math.ceil(item.size/1024)+' KB)';
        const actions=document.createElement('div'); actions.className='file-actions';
        const copy=document.createElement('button'); copy.className='copy-link'; copy.type='button'; copy.title='複製公開圖檔網址'; copy.setAttribute('aria-label','複製 '+item.name+' 的公開網址');
        copy.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"></rect><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"></path></svg>';
        copy.onclick=async()=>{ try { await copyUrl(publicImageUrl(item.key), copy, item.name+' 的公開圖檔'); } catch (error) { setStatus(error.message || '無法複製網址','error'); } };
        const remove=document.createElement('button'); remove.className='danger'; remove.textContent='刪除'; remove.onclick=async()=>{ if(confirm('刪除 '+item.name+'？')) { await api('/api/admin/objects?key='+encodeURIComponent(item.key),{method:'DELETE'}); setStatus('已刪除圖片，pincode 快取已清除；下次公開列印會建立新的取件編號。','ok'); await loadFiles(); }};
        actions.append(copy,remove); li.append(name,actions); root.append(li);
      }
    }
    document.querySelector('#create-folder').onclick=async()=>{ const input=document.querySelector('#new-folder'); const folder=input.value.trim(); if(!folder)return; await api('/api/admin/folders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({folder})}); input.value=''; setStatus('資料夾已建立。','ok'); await loadFolders(); await selectFolder(folder); };
    function uploadFile(file, onProgress) {
      return new Promise((resolve,reject)=>{
        const request=new XMLHttpRequest(); request.open('POST','/api/admin/upload'); request.responseType='json';
        request.upload.onprogress=(event)=>{ if(event.lengthComputable) onProgress(event.loaded); };
        request.onerror=()=>reject(new Error('上傳連線失敗'));
        request.onload=()=>{ const body=request.response || (()=>{ try { return JSON.parse(request.responseText); } catch { return {}; } })(); if(request.status >= 200 && request.status < 300) resolve(body); else reject(new Error(body.error || '上傳失敗')); };
        const form=new FormData(); form.append('folder',state.folder); form.append('file',file); request.send(form);
      });
    }
    async function acceptFiles(fileList) {
      if(!state.folder || state.uploading) return;
      const files=[...fileList]; if(!files.length) return;
      const remaining=MAX_FILE_COUNT-state.files.length;
      if(files.length > remaining) { document.querySelector('#files').value=''; setStatus('目前只剩 '+remaining+' 個上傳名額，請減少選取的檔案。','error'); return; }
      if(files.some(file=>!imagePattern.test(file.name))) { document.querySelector('#files').value=''; setStatus('只可上傳 jpg、jpeg、png、bmp、gif 圖檔。','error'); return; }
      const total=files.reduce((sum,file)=>sum+file.size,0); const existingTotal=state.files.reduce((sum,file)=>sum+file.size,0);
      if(existingTotal+total > MAX_TOTAL_BYTES) { document.querySelector('#files').value=''; setStatus('每個資料夾的圖檔總計不可超過 15 MB。','error'); return; }
      let completed=0;
      state.uploading=true; updateUploadUi(); setUploadProgress(0,'準備上傳 '+files.length+' 個檔案…');
      try {
        for(let index=0; index<files.length; index++) { const file=files[index]; await uploadFile(file,loaded=>setUploadProgress((completed+loaded)/total,'上傳中 '+(index+1)+' / '+files.length+'：'+file.name)); completed+=file.size; setUploadProgress(completed/total,'已完成 '+(index+1)+' / '+files.length+' 個檔案'); }
        document.querySelector('#files').value=''; setStatus('圖片已上傳，pincode 快取已清除；下次公開列印會建立新的取件編號。','ok'); await loadFiles();
      } catch(error) { setStatus(error.message || '上傳失敗','error'); }
      finally { state.uploading=false; updateUploadUi(); setTimeout(()=>setUploadProgress(0,''),500); }
    }
    const fileInput=document.querySelector('#files'); const dropZone=document.querySelector('#drop-zone');
    dropZone.onclick=()=>{ if(!dropZone.disabled) fileInput.click(); };
    fileInput.onchange=()=>acceptFiles(fileInput.files);
    ['dragenter','dragover'].forEach(type=>dropZone.addEventListener(type,event=>{ event.preventDefault(); if(!dropZone.disabled) dropZone.classList.add('drag-over'); }));
    ['dragleave','drop'].forEach(type=>dropZone.addEventListener(type,event=>{ event.preventDefault(); dropZone.classList.remove('drag-over'); }));
    dropZone.addEventListener('drop',event=>{ if(!dropZone.disabled) acceptFiles(event.dataTransfer.files); });
    document.querySelectorAll('[data-setting]').forEach(button=>button.onclick=async()=>{ if(!state.folder || button.disabled)return; const before={...state.print}; state.print[button.dataset.setting]=button.dataset.value; if(isPhotoPaper()) { state.print.color='color'; state.print.sides='single'; state.print.paperType='common'; } syncPrintSettings(); try { await savePrintSettings(); } catch (error) { state.print=before; syncPrintSettings(); throw error; } });
    document.querySelector('#delete-folder').onclick=async()=>{ if(!confirm('只可刪除沒有圖檔的資料夾。要繼續？'))return; await api('/api/admin/folders/'+encodeURIComponent(state.folder),{method:'DELETE'}); setStatus('資料夾已刪除。','ok'); state.folder=null; state.files=[]; state.print={...defaultPrint}; document.querySelector('#file-title').textContent='請選擇資料夾'; document.querySelector('#files-list').innerHTML='<li class="empty">尚未選擇資料夾</li>'; document.querySelector('#delete-folder').disabled=true; document.querySelector('#print-settings').hidden=true; updateUploadUi(); await loadFolders(); };
    document.querySelector('#logout').onclick=async()=>{ await api('/auth/logout',{method:'POST'}); location.assign('/admin'); };
    loadFolders().catch(error=>setStatus(error.message,'error'));
    window.addEventListener('unhandledrejection', event=>setStatus(event.reason?.message || '操作失敗','error'));
  </script>
</body>
</html>"""
