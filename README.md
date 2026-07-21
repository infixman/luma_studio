# Luma Studio ibon 列印

Cloudflare Python Worker：從 R2 讀取指定資料夾的圖片，走 ibon 一般網頁上傳流程，將取件編號快取 24 小時於 D1，並提供公開取件頁與受 Google OAuth 保護的圖檔管理介面。

本專案不使用 ibon 僅供企業客戶使用的 Open API。

## 使用方式

在瀏覽器開啟下列網址，會顯示含 QR Code、取件編號和列印期限的公開頁面：

```text
https://luma-studio.infixman.workers.dev/ibon_print/20260721_soda
```

給程式或 Postman 使用時，加入 `?format=json` 可取得 JSON：

```text
https://luma-studio.infixman.workers.dev/ibon_print/20260721_soda?format=json
```

JSON 包含 `pincode`、`deadline`、`qrCodeSvg`、圖檔清單與快取資訊。ibon 的一般 `GetPincode` 回應目前 `qRcode` 為 `null`，因此 Worker 以同一組取件編號產生等效 SVG QR Code。

## 專案結構

```text
src/
  main.py             Worker、ibon 上傳流程、D1/R2/API/OAuth 路由
  admin_html.py       受保護的 R2 管理介面
  print_html.py       公開 ibon 取件頁
public/assets/        隨 Worker 一起部署的靜態 logo
design/               logo 原始檔，非公開路徑
migrations/           D1 schema migrations
scripts/              本機診斷與 R2 同步腳本
.github/workflows/    main branch 自動部署
```

公開取件頁、admin 和 logo 都使用同一個 Worker。`wrangler.toml` 的 `[assets]` 會將 `public/` 一起部署為 Cloudflare Workers Static Assets，因此目前不需要額外建立 Cloudflare Pages 專案，也不會產生跨網域或 CORS 問題。

## Cloudflare 初次設定

1. 安裝 [uv](https://docs.astral.sh/uv/)，登入 Cloudflare，並安裝依賴：

   ```powershell
   uv sync
   uv run pywrangler login
   ```

2. 建立資料庫與 R2 bucket：

   ```powershell
   uv run pywrangler d1 create luma-ibon-cache
   uv run pywrangler r2 bucket create luma-ibon-images
   ```

3. 把 D1 輸出的 `database_id` 填入 [wrangler.toml](wrangler.toml)。

4. 套用 migrations：

   ```powershell
   uv run pywrangler d1 execute luma-ibon-cache --remote --file migrations/0001_create_ibon_print_cache.sql
   uv run pywrangler d1 execute luma-ibon-cache --remote --file migrations/0002_create_admin_auth.sql
   ```

5. 將本機 `upload_ibon/<id>/` 同步到遠端 R2，然後部署：

   ```powershell
   .\scripts\sync-r2.ps1 20260721_soda
   uv run pywrangler deploy
   ```

## Admin 與 Google OAuth

管理介面：

```text
https://luma-studio.infixman.workers.dev/admin
```

僅允許 `chiao7912@gmail.com`、`infixman@gmail.com` 這兩個已驗證 Google 帳號。介面可建立資料夾、上傳/刪除圖片、刪除空資料夾與複製公開取件頁網址。任何圖檔異動都會清除該資料夾的 ibon 24 小時快取。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立 **Web application** OAuth 2.0 Client。
2. 在 Authorized redirect URIs 加入：

   ```text
   https://luma-studio.infixman.workers.dev/auth/callback
   ```

3. 將 OAuth 值存為 Cloudflare secrets，切勿寫入 Git：

   ```powershell
   uv run pywrangler secret put GOOGLE_CLIENT_ID
   uv run pywrangler secret put GOOGLE_CLIENT_SECRET
   uv run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI
   ```

`GOOGLE_OAUTH_REDIRECT_URI` 的值是上面的完整 callback URL。

## GitHub 自動部署

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 在 `main` 有新 commit 時執行 `uv run pywrangler deploy`。這一次部署同時發布 Worker、公開取件頁、admin 和 `public/` 靜態 logo；不需要第二個 Pages workflow。

請在 GitHub repository 的 **Settings → Secrets and variables → Actions** 設定：

- `CLOUDFLARE_API_TOKEN`：具此帳號 Workers 部署權限的 API token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID。

建立 GitHub repository 後：

```powershell
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Google OAuth secrets 只留在 Cloudflare，GitHub Actions 不需要也不應持有它們。

## 執行時行為與限制

- D1 快取保存 24 小時；快取命中時不會再上傳至 ibon。
- 快取未命中時，只接受資料夾內 1–8 個 `jpg/jpeg/png/bmp/gif`，總大小不得超過 15 MB。
- R2 object key 必須為 `<id>/<filename>`。
- 上傳順序為 `BaseEntry/GetEntry` → `IbonUpload/GetPincode` → `GetChunksize` → `Upload`。上游失敗時 JSON API 會回傳不含 token 的 `stage` 與安全診斷資訊。
- ibon 可能變更一般消費者流程或拒絕 Cloudflare 流量；每次部署後應以一個實際資料夾驗證。
