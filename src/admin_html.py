ADMIN_HTML = r"""<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Luma Studio · ibon 圖檔管理</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Microsoft JhengHei", system-ui, sans-serif; background:#10151d; color:#edf2f7; }
    body { margin:0; background:radial-gradient(circle at top right,#204e4b 0,#10151d 38rem); min-height:100vh; }
    main { max-width:980px; margin:0 auto; padding:36px 20px 64px; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; border-bottom:1px solid #354050; padding-bottom:22px; }
    h1 { margin:0; font-size:26px; } h2 { font-size:18px; margin:0; } p { color:#b9c3d0; }
    button, input { font:inherit; } button { border:0; border-radius:8px; padding:9px 13px; background:#2f8d83; color:white; cursor:pointer; }
    button:hover { background:#3aa697; } button.danger { background:#913c4b; } button.ghost { background:#273241; }
    .grid { display:grid; grid-template-columns:310px 1fr; gap:20px; margin-top:26px; } .card { background:#17202cdd; border:1px solid #344152; border-radius:12px; padding:18px; }
    .row { display:flex; gap:9px; align-items:center; } .row input { min-width:0; flex:1; padding:9px; border:1px solid #475569; border-radius:8px; background:#0f1722; color:#fff; }
    .folders, .files { list-style:none; padding:0; margin:14px 0 0; } li { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 3px; border-bottom:1px solid #2b3747; }
    .folder { flex:1; text-align:left; background:transparent; padding:4px 0; color:#d6f2ec; } .file-name { overflow-wrap:anywhere; } .muted { color:#91a0b2; font-size:13px; }
    #status { min-height:22px; margin:16px 0 0; } #status.error { color:#ff9da8; } #status.ok { color:#8ee7c8; }
    .empty { padding:22px 0; color:#91a0b2; text-align:center; }
    @media (max-width:720px) { .grid { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <main>
    <header><div><h1>ibon 圖檔管理</h1><p>R2 bucket: <code>luma-ibon-images</code></p></div><button id="logout" class="ghost">登出</button></header>
    <div id="status" aria-live="polite"></div>
    <section class="grid">
      <div class="card"><h2>資料夾</h2><p class="muted">資料夾名稱就是列印 API 的 id。</p>
        <div class="row"><input id="new-folder" maxlength="128" placeholder="例如 20260721_soda"><button id="create-folder">新增</button></div>
        <ul id="folders" class="folders"></ul>
      </div>
      <div class="card"><h2 id="file-title">請選擇資料夾</h2><p class="muted">可上傳 jpg、jpeg、png、bmp、gif；每個列印資料夾最多 8 張、總計 15 MB。</p>
        <div class="row"><input id="files" type="file" accept=".jpg,.jpeg,.png,.bmp,.gif" multiple disabled><button id="upload" disabled>上傳</button><button id="delete-folder" class="danger" disabled>刪除空資料夾</button></div>
        <ul id="files-list" class="files"><li class="empty">尚未選擇資料夾</li></ul>
      </div>
    </section>
  </main>
  <script>
    const state = { folder: null };
    const status = document.querySelector('#status');
    const setStatus = (text, kind='') => { status.textContent=text; status.className=kind; };
    async function api(path, options={}) {
      const response = await fetch(path, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '操作失敗');
      return body;
    }
    function esc(value) { return String(value); }
    async function loadFolders() {
      const data = await api('/api/admin/folders');
      const root = document.querySelector('#folders'); root.replaceChildren();
      if (!data.folders.length) { root.innerHTML='<li class="empty">沒有資料夾</li>'; return; }
      for (const folder of data.folders) {
        const li=document.createElement('li'); const select=document.createElement('button'); select.className='folder'; select.textContent='📁 '+esc(folder); select.onclick=()=>selectFolder(folder);
        li.append(select); root.append(li);
      }
    }
    async function selectFolder(folder) {
      state.folder=folder; document.querySelector('#file-title').textContent='資料夾：'+folder;
      document.querySelector('#files').disabled=false; document.querySelector('#upload').disabled=false; document.querySelector('#delete-folder').disabled=false;
      await loadFiles();
    }
    async function loadFiles() {
      const data=await api('/api/admin/objects?folder='+encodeURIComponent(state.folder));
      const root=document.querySelector('#files-list'); root.replaceChildren();
      if (!data.objects.length) { root.innerHTML='<li class="empty">沒有圖檔</li>'; return; }
      for (const item of data.objects) {
        const li=document.createElement('li'); const name=document.createElement('span'); name.className='file-name'; name.textContent=item.name+' ('+Math.ceil(item.size/1024)+' KB)';
        const remove=document.createElement('button'); remove.className='danger'; remove.textContent='刪除'; remove.onclick=async()=>{ if(confirm('刪除 '+item.name+'？')) { await api('/api/admin/objects?key='+encodeURIComponent(item.key),{method:'DELETE'}); setStatus('已刪除，該資料夾的列印快取已清除。','ok'); await loadFiles(); }};
        li.append(name,remove); root.append(li);
      }
    }
    document.querySelector('#create-folder').onclick=async()=>{ const input=document.querySelector('#new-folder'); const folder=input.value.trim(); if(!folder)return; await api('/api/admin/folders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({folder})}); input.value=''; setStatus('資料夾已建立。','ok'); await loadFolders(); await selectFolder(folder); };
    document.querySelector('#upload').onclick=async()=>{ const files=[...document.querySelector('#files').files]; if(!files.length)return; for(const file of files){ const form=new FormData(); form.append('folder',state.folder); form.append('file',file); await api('/api/admin/upload',{method:'POST',body:form}); } document.querySelector('#files').value=''; setStatus('上傳完成，該資料夾的列印快取已清除。','ok'); await loadFiles(); };
    document.querySelector('#delete-folder').onclick=async()=>{ if(!confirm('只可刪除沒有圖檔的資料夾。要繼續？'))return; await api('/api/admin/folders/'+encodeURIComponent(state.folder),{method:'DELETE'}); setStatus('資料夾已刪除。','ok'); state.folder=null; document.querySelector('#file-title').textContent='請選擇資料夾'; document.querySelector('#files-list').innerHTML='<li class="empty">尚未選擇資料夾</li>'; document.querySelector('#files').disabled=true; document.querySelector('#upload').disabled=true; document.querySelector('#delete-folder').disabled=true; await loadFolders(); };
    document.querySelector('#logout').onclick=async()=>{ await api('/auth/logout',{method:'POST'}); location.assign('/admin'); };
    loadFolders().catch(error=>setStatus(error.message,'error'));
    window.addEventListener('unhandledrejection', event=>setStatus(event.reason?.message || '操作失敗','error'));
  </script>
</body>
</html>"""
