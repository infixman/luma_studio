# luma-studio Python Worker

`GET /ibon_print/:id` reads `:id/` from Cloudflare R2, uses ibon's ordinary browser-upload sequence (`GetEntry` -> `GetPincode` -> `GetChunksize` -> `Upload`), generates an SVG QR code from the pickup number, and stores the result in D1 for 24 hours. It does not use ibon's company-only Open API.

Example:

```text
https://luma-studio.<your-subdomain>.workers.dev/ibon_print/20260721_soda
```

The JSON response contains `pincode`, `deadline`, and `qrCodeSvg`. The ordinary `GetPincode` response currently returns `qRcode: null`; the QR graphic on ibon's success page is generated from the pickup number, so this Worker saves an equivalent SVG together with ibon's response.

## One-time Cloudflare setup

1. Install [uv](https://docs.astral.sh/uv/) and authenticate with Cloudflare:

   ```powershell
   uv sync
   uv run pywrangler login
   ```

2. Create the resources:

   ```powershell
   uv run pywrangler d1 create luma-ibon-cache
   uv run pywrangler r2 bucket create luma-ibon-images
   ```

3. Copy the `database_id` printed by the D1 command into [wrangler.toml](wrangler.toml), replacing `REPLACE_WITH_D1_DATABASE_ID`.

4. Apply the D1 migration and upload the current folder to R2:

   ```powershell
   uv run pywrangler d1 execute luma-ibon-cache --remote --file migrations/0001_create_ibon_print_cache.sql
   .\scripts\sync-r2.ps1 20260721_soda
   ```

5. Deploy:

   ```powershell
   uv run pywrangler deploy
   ```

Wrangler prints the public `workers.dev` URL after deployment.

## R2 管理介面與 Google OAuth

管理介面位於：

```text
https://luma-studio.<your-subdomain>.workers.dev/admin
```

它只允許這兩個已驗證的 Google 帳號登入：`chiao7912@gmail.com`、`infixman@gmail.com`。可新增資料夾、上傳／刪除圖檔，以及刪除空資料夾；任何圖檔異動都會刪除該資料夾現有的 ibon 24 小時快取。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立 **Web application** OAuth 2.0 Client。
2. 在 Authorized redirect URIs 加入：

   ```text
   https://luma-studio.<your-subdomain>.workers.dev/auth/callback
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

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 只在 `main` 有新 commit 時部署；PR 合併到 `main` 會產生該 push，所以不額外監聽 `pull_request.closed`，避免合併時重複部署。

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

## Runtime behavior

- Uses D1, not process memory: the 24-hour cache survives Worker isolate changes and is shared across requests.
- A cache hit returns the saved ibon pickup number and SVG without contacting ibon.
- A cache miss accepts only image folders with 1–8 `jpg/jpeg/png/bmp/gif` files totaling no more than 15 MB, matching ibon's upload-page limits.
- R2 keys must be `:id/<filename>`; `scripts/sync-r2.ps1` uploads `upload_ibon/:id` in exactly that layout.
- The worker follows the current ordinary website sequence: `BaseEntry/GetEntry` -> `IbonUpload/GetPincode` -> `GetChunksize` -> `Upload`. For each cache miss it generates a new web-entry bootstrap payload (`disposableId`, `key`, `t1`), receives a short-lived token plus uuid, then uses the uuid as the `Key` header of `GetPincode`. Tokens are not stored.
- The original `ThanatosDi/ibonPrinter` is the protocol reference. It cannot run unchanged in a Worker because it reads local files and uses synchronous `requests`; this Worker retains its request sequence while reading R2, using Worker-native async `fetch`, and persisting the result in D1.
- ibon can change this consumer flow or reject Cloudflare-originated traffic. Test one real request after deployment; this repository has not uploaded any image to ibon during setup.
