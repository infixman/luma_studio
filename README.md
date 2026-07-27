# Luma Studio ibon 列印

從 R2 讀取指定資料夾的圖片，走 ibon 一般網頁上傳流程，將取件編號快取 24 小時於 D1，並提供公開取件頁與受 Google OAuth 保護的圖檔管理介面。

本專案不使用 ibon 僅供企業客戶使用的 Open API。

前後端為兩個獨立部署：

| 部署 | 內容 | 網址 |
| --- | --- | --- |
| `luma-studio` | Cloudflare Python Worker，純 JSON API 與圖檔 | `https://api.luma-studio.tw` |
| `luma-studio-web` | Vite + Preact 靜態站台，管理介面與公開取件頁 | `https://luma-studio.tw` |

## 使用方式

公開取件頁（含 QR Code、取件編號與列印期限）：

```text
https://luma-studio.tw/ibon_print/20260721_soda
```

給程式或 Postman 使用時直接打 API：

```text
https://api.luma-studio.tw/api/print/20260721_soda
```

JSON 包含 `pincode`、`deadline`、`qrCodeSvg`、圖檔清單與快取資訊。ibon 的一般 `GetPincode` 回應目前 `qRcode` 為 `null`，因此 Worker 以同一組取件編號產生等效 SVG QR Code。

舊網址仍可用。已經發出去的 `https://api.luma-studio.tw/ibon_print/{id}` 預設一律 302 導向前端頁面——包含 LINE、IG 內建瀏覽器與 QR 掃描 app 這類送 `Accept: */*` 的客戶端。只有明確要求 JSON 的呼叫端會拿到資料：`?format=json`，或送出 `Accept: application/json` 且不接受 HTML。

## 專案結構

```text
backend/
  wrangler.toml       Worker 設定與 [vars]
  src/
    main.py           路由與 Worker 入口
    responses.py      Ctx、CORS 與回應建構
    auth.py           Google OAuth 與 session
    admin_api.py      /api/admin/* 端點
    ibon.py           ibon 上傳流程、D1 快取、列印規格
    bio_link.py       Bio link 的設定、連結、匿名點擊記錄
    bio_link_api.py   /api/admin/bio-link* 端點
    migrations.py     啟動時套用的 D1 schema
    common.py         共用常數與小工具
frontend/
  wrangler.jsonc      靜態資產 Worker 設定
  vite.config.ts
  public/assets/      logo 與教學圖
  src/
    app.tsx           路徑對應
    pages/            HomePage、AdminPage、PrintPage、BioLinkPage、BioLinkAdminPage
    components/       StatusBar、IconButtons、AdminNav、SocialIcon
    lib/              api、型別、列印規格轉換
    styles/           base、home、admin、admin-nav、print、bio-link、bio-link-admin
design/               logo 原始檔，非公開路徑
scripts/              本機診斷與 R2 同步腳本
docs/superpowers/specs/  設計文件
.github/workflows/    main branch 自動部署（後端先、前端後）
```

## 後端 API

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/health` | 存活檢查，回報已套用的 migration |
| GET | `/api/session` | 已登入回 `{email}`，否則 401 |
| GET | `/auth/login?next=` | 導向 Google OAuth，`next` 必須在允許來源內 |
| GET | `/auth/callback` | 建立 session 後導回 `next` |
| POST | `/auth/logout` | 清除 session |
| GET | `/api/print/{id}` | 取件編號 JSON |
| GET | `/images/{folder}/{file}` | 公開圖檔 |
| GET | `/api/bio-link` | Bio link 公開內容，順帶記一筆瀏覽 |
| GET | `/r/{id}` | 記一筆點擊後 302 到目標網址 |
| GET | `/bio-link-assets/{file}` | Bio link 頭像 |
| — | `/api/admin/*` | 管理端點，需登入 |
| — | `/api/admin/bio-link*` | Bio link 編輯端點，需登入 |

### 跨來源與 CSRF

前端是不同來源，session cookie 因此為 `SameSite=None; Secure; HttpOnly`。少掉的 SameSite 保護由兩件事補上：

1. 所有非 GET 請求必須帶 `x-luma-app: 1`。自訂標頭會強制觸發 CORS 預檢，跨站表單無法偽造。
2. 同時檢查 `Origin` 在 `ALLOWED_ORIGINS` 清單內，否則 403。

`ALLOWED_ORIGINS` 與 `FRONTEND_ORIGIN` 定義在 [backend/wrangler.toml](backend/wrangler.toml) 的 `[vars]`。新增前端網域時要同步更新。

### D1 migration

schema 定義在 [backend/src/migrations.py](backend/src/migrations.py)，Worker 每個 isolate 首次收到請求時自動套用，並以 `schema_migrations` 表記錄。所有敘述都必須可重複執行，因為多個 isolate 會同時啟動。手動執行 `wrangler d1 execute` 已不再需要。

## Cloudflare 初次設定

1. 安裝 [uv](https://docs.astral.sh/uv/)，登入 Cloudflare，並安裝依賴：

   ```powershell
   uv --directory backend sync
   uv --directory backend run pywrangler login
   ```

2. 建立資料庫與 R2 bucket：

   ```powershell
   uv --directory backend run pywrangler d1 create luma-ibon-cache
   uv --directory backend run pywrangler r2 bucket create luma-ibon-images
   ```

3. 把 D1 輸出的 `database_id` 填入 [backend/wrangler.toml](backend/wrangler.toml)。

4. 部署後端（schema 會在第一個請求時自動建立）：

   ```powershell
   uv --directory backend run pywrangler deploy
   ```

5. 部署前端：

   ```powershell
   cd frontend
   npm ci
   npm run build
   npx wrangler deploy
   ```

6. 將本機 `upload_ibon/<id>/` 同步到遠端 R2：

   ```powershell
   .\scripts\sync-r2.ps1 20260721_soda
   ```

## 本機開發

兩個服務要同時跑：

```powershell
uv --directory backend run pywrangler dev
```

```powershell
cd frontend
npm run dev
```

前端預設打 `https://api.luma-studio.tw`。要改打本機後端，在 `frontend/.env.local` 設定：

```text
VITE_API_BASE=http://localhost:8787
```

後端的本機來源設定放在 `backend/.dev.vars`（見 [backend/.dev.vars.example](backend/.dev.vars.example)），**不要**把 localhost 寫進 `wrangler.toml` 的 `[vars]`——那份設定會上到 production，等於讓任何在該埠上的程式取得正式環境的寫入權。

注意本機為 http，瀏覽器不會接受 `Secure` cookie，因此需要登入的流程要對著已部署的後端測試。

## Admin 與 Google OAuth

管理介面：

```text
https://luma-studio.tw/admin
```

僅允許 `chiao7912@gmail.com`、`infixman@gmail.com` 這兩個已驗證 Google 帳號。介面可建立資料夾、上傳/刪除圖片、刪除空資料夾、複製或開啟公開取件頁與圖檔網址，並設定每個資料夾的紙張尺寸、色彩、單/雙面與紙張種類。

預設規格為 **A4／彩色／單面列印／一般用紙**，對應 ibon `SelectType: FA4CN1`。每次規格異動都會清除該資料夾的 ibon 24 小時快取；下一個公開列印請求會以新的 `SelectType` 建立 pincode。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立 **Web application** OAuth 2.0 Client。
2. 在 Authorized redirect URIs 加入後端的 callback：

   ```text
   https://api.luma-studio.tw/auth/callback
   ```

3. 將 OAuth 值存為 Cloudflare secrets，切勿寫入 Git：

   ```powershell
   uv --directory backend run pywrangler secret put GOOGLE_CLIENT_ID
   uv --directory backend run pywrangler secret put GOOGLE_CLIENT_SECRET
   uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI
   ```

4. Bio link 的訪客雜湊需要一組隨機鹽值，同樣以 secret 保存：

   ```powershell
   uv --directory backend run pywrangler secret put VISITOR_SALT
   ```

   值填任意隨機字串。**不要**寫進 `wrangler.toml` 的 `[vars]`——那份設定會進版控，鹽值一旦公開，任何人都能從 IP 反推訪客雜湊。未設定時程式會退回每個 isolate 隨機產生的鹽值，雜湊仍然安全，但「同一訪客每日只記一次」的去重只在單一 isolate 內成立。

`GOOGLE_OAUTH_REDIRECT_URI` 的值是上面的完整 callback URL。

## GitHub 自動部署

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 在 `main` 有新 commit 時先部署後端 Worker，成功後再建置並部署前端。

兩個 job 都綁在名為 `production` 的 GitHub Environment，請先建立該 environment，再於 repository 的 **Settings → Secrets and variables → Actions**（或該 environment）設定：

- `CLOUDFLARE_API_TOKEN`：具此帳號 Workers 部署權限的 API token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID。
- `API_BASE_URL`（variable，選用）：前端建置時要打的後端網址，未設定時使用預設值。

Google OAuth secrets 只留在 Cloudflare，GitHub Actions 不需要也不應持有它們。

## Bio Link

公開頁：

```text
https://luma-studio.tw/bio_link
```

編輯介面在 admin 的第二個分頁：

```text
https://luma-studio.tw/admin/bio-link
```

可設定頭像、顯示名稱、簡介，以及兩組連結：主要的連結按鈕，和一排社群 icon。兩者都可排序、可個別停用。頭像未設定時公開頁改用 logo。

限制：連結合計最多 50 筆、標題 80 字、網址 2048 字且只接受 `http`、`https`、`mailto`、`tel`；頭像 2 MB 以內的 jpg、png、gif、webp。頭像存在同一個 R2 bucket 的 `_bio-link/` 前綴下，該前綴刻意不符合 ibon 的資料夾規則，因此不會出現在資料夾清單，`/images/` 也取不到。

公開頁上的每個連結都指向 `/r/{id}`，由後端記錄後再轉出。記錄的是每位訪客每天每個目標一筆，內容包含國家、城市、來源網站、裝置類別與一組每日輪替的匿名雜湊，**無法識別個人，也無法跨日追蹤**。User-Agent 看起來是機器人或連結預覽器時完全不記錄。統計報表尚未實作，目前只寫入不讀取。

## 執行時行為與限制

- D1 快取保存 24 小時，並綁定資料夾的 ibon `SelectType`；快取命中時不會再上傳至 ibon。
- 快取未命中時，只接受資料夾內 1–8 個 `jpg/jpeg/png/bmp/gif`，總大小不得超過 15 MB。
- ibon 的 R2 object key 必須為 `<id>/<filename>`。Bio link 頭像是例外，放在 `_bio-link/` 前綴下。
- Bio link 的事件記錄採用「每位訪客每天每個目標最多一筆」，靠唯一索引與 `INSERT OR IGNORE` 達成。這不只是為了數字準確：這兩個端點是公開的，而 D1 的每日寫入額度與 admin session 共用，沒有上限的計數器等於讓任何人都能把你鎖在自己的後台外面。
- 上傳順序為 `BaseEntry/GetEntry` → `IbonUpload/GetPincode` → `GetChunksize` → `Upload`。上游失敗時 JSON API 會回傳不含 token 的 `stage` 與安全診斷資訊。
- ibon 可能變更一般消費者流程或拒絕 Cloudflare 流量；每次部署後應以一個實際資料夾驗證。
- 管理登入依賴跨站 cookie。若瀏覽器封鎖第三方 cookie 導致登入失效，退路是讓前後端共用同一個網域的兩個子網域。
