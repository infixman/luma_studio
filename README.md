# Luma Studio

`GET /ibon_print/:id` 會從 Cloudflare R2 讀取 `:id/` 資料夾，依序執行 ibon 一般網頁上傳流程（`GetEntry` -> `GetPincode` -> `GetChunksize` -> `Upload`），以取件碼產生 SVG QR Code，並將結果快取到 D1 24 小時。本專案不使用 ibon 僅供企業客戶使用的 Open API。

範例：

```text
https://luma-studio.infixman.workers.dev/ibon_print/20260721_soda
```

JSON 回應包含 `pincode`、`deadline` 與 `qrCodeSvg`。ibon 一般 `GetPincode` 回應目前的 `qRcode` 為 `null`；ibon 成功頁的 QR 圖是由取件碼產生，因此 Worker 會用相同取件碼產生並快取等效的 SVG。

## Cloudflare 初次設定

1. 安裝 [uv](https://docs.astral.sh/uv/)，並登入 Cloudflare：

   ```powershell
   uv sync
   uv run pywrangler login
   ```

2. 建立資源：

   ```powershell
   uv run pywrangler d1 create luma-ibon-cache
   uv run pywrangler r2 bucket create luma-ibon-images
   ```

3. 將 D1 指令輸出的 `database_id` 填入 [wrangler.toml](wrangler.toml)，取代 `REPLACE_WITH_D1_DATABASE_ID`。

4. 套用 D1 migration，並將指定資料夾的圖檔上傳到遠端 R2：

   ```powershell
   uv run pywrangler d1 execute luma-ibon-cache --remote --file migrations/0001_create_ibon_print_cache.sql
   .\scripts\sync-r2.ps1 20260721_soda
   ```

5. 部署 Worker：

   ```powershell
   uv run pywrangler deploy
   ```

部署完成後，Wrangler 會輸出公開的 `workers.dev` 網址。

## R2 管理介面與 Google OAuth

管理介面位於：

```text
https://luma-studio.infixman.workers.dev/admin
```

它只允許這兩個已驗證的 Google 帳號登入：`chiao7912@gmail.com`、`infixman@gmail.com`。可新增資料夾、上傳／刪除圖檔，以及刪除空資料夾；任何圖檔異動都會刪除該資料夾現有的 ibon 24 小時快取。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立 **Web application** OAuth 2.0 Client。
2. 在 Authorized redirect URIs 加入：

   ```text
   https://luma-studio.infixman.workers.dev/auth/callback
   ```

3. 使用 Cloudflare secret 儲存 OAuth 設定。不要把它們寫進 `wrangler.toml` 或 Git：

   ```powershell
   uv run pywrangler secret put GOOGLE_CLIENT_ID
   uv run pywrangler secret put GOOGLE_CLIENT_SECRET
   uv run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI
   ```

   第三個值必須是上一項的完整 callback URL。

4. 套用新增的 session migration 後再部署：

   ```powershell
   uv run pywrangler d1 execute luma-ibon-cache --remote --file migrations/0002_create_admin_auth.sql
   uv run pywrangler deploy
   ```

## GitHub 版本控制與自動部署

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 只在 `main` 有新 commit 時部署；PR 合併到 `main` 會產生該 push，因此不額外監聽 `pull_request.closed`，避免合併時重複部署。

在 GitHub repository 的 **Settings → Secrets and variables → Actions** 建立：

- `CLOUDFLARE_API_TOKEN`：在 Cloudflare API Tokens 建立時選擇 **Edit Cloudflare Workers**，並將帳號資源範圍限制為部署此 Worker 的帳號。
- `CLOUDFLARE_ACCOUNT_ID`：部署此 Worker 的 Cloudflare Account ID。

建立 GitHub repo 後，在本機執行（將網址換成你的 repo）：

```powershell
git init
git add .
git commit -m "Initial luma-studio Worker"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Google OAuth secrets 只存在 Cloudflare；GitHub Actions 不需要也不應持有它們。

## 執行時行為

- 使用 D1 而非程序記憶體：24 小時快取可跨 Worker isolate 保留，並供所有請求共用。
- 快取命中時，直接回傳已儲存的 ibon 取件碼與 SVG，不會連線到 ibon。
- 快取未命中時，只接受資料夾內 1–8 個 `jpg/jpeg/png/bmp/gif` 圖檔，總大小不得超過 15 MB，與 ibon 網頁上傳限制一致。
- R2 物件鍵必須是 `:id/<filename>`；`scripts/sync-r2.ps1` 會將 `upload_ibon/:id` 以這個結構上傳至遠端 R2。
- Worker 遵循目前 ibon 一般網頁流程：`BaseEntry/GetEntry` -> `IbonUpload/GetPincode` -> `GetChunksize` -> `Upload`。每個快取未命中請求都會產生新的網頁進入資料（`disposableId`、`key`、`t1`），取得短效 token 與 uuid，並以 uuid 作為 `GetPincode` 的 `Key` header；token 不會儲存。
- 原始的 `ThanatosDi/ibonPrinter` 是協定參考實作。它需讀取本機檔案並使用同步 `requests`，無法原樣在 Worker 執行；本專案保留其請求順序，改由 R2 讀取圖檔、使用 Worker 原生非同步 `fetch`，並把結果存入 D1。
- ibon 可能變更一般消費者流程，或拒絕來自 Cloudflare 的請求。部署後請以一筆實際請求驗證；初始設定過程不會自動將圖片上傳給 ibon。
