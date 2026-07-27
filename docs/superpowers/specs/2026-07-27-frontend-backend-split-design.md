# 前後端分離設計（2026-07-27）

把目前單一 Cloudflare Python Worker（HTML 寫在 Python 字串裡）拆成兩個獨立部署：純 JSON API 後端，以及 Vite 建置的靜態前端。範圍限於現有功能——admin 管理介面與公開 ibon 取件頁。Link tree 功能不在本次範圍。

## 目標

- Admin 介面與公開取件頁改由前端專案負責，HTML/CSS/JS 成為可被工具鏈處理的真實檔案。
- 後端只回 JSON 與二進位圖檔，不再組 HTML。
- 兩個部署各自獨立：`luma-studio`（Python Worker，維持原名以保留既有網址、OAuth redirect URI 與 secrets）與 `luma-studio-web`（靜態資產 Worker）。
- D1 schema 由後端在啟動時自行套用，不再依賴人工執行 `wrangler d1 execute`。

## 非目標

- 不改 ibon 上傳流程、快取邏輯與列印規格模型。
- 不引入自訂網域（維持 `*.workers.dev`）。
- 不做 link tree。

## 儲存庫結構

```text
backend/
  pyproject.toml, uv.lock, pylock.toml
  wrangler.toml            name = luma-studio
  .dev.vars.example        本機來源設定範本
  src/
    main.py                路由與 Worker 入口
    ibon.py                ibon 上傳流程、D1 快取、列印規格
    admin_api.py           /api/admin/* 處理
    auth.py                Google OAuth、session cookie
    migrations.py          啟動時套用的 schema
    responses.py           Ctx、CORS 與回應建構
    common.py              共用常數與小工具
frontend/
  package.json, tsconfig.json, vite.config.ts
  wrangler.jsonc           name = luma-studio-web
  index.html
  public/                  favicon、logo、_headers
  src/
    main.tsx, app.tsx
    components/            StatusBar、IconButtons
    lib/api.ts             fetch 包裝（credentials + CSRF header + 401 處理）
    lib/types.ts           API 回應型別
    lib/printSpec.ts       列印規格與 SelectType 轉換
    pages/AdminPage.tsx
    pages/PrintPage.tsx
    styles/*.css
docs/superpowers/specs/
scripts/
```

原本的 `migrations/*.sql` 與 `public/assets/*` 併入上述位置；`src/admin_html.py`、`src/print_html.py` 移除。

## 後端 API

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/health` | 存活檢查，順帶回報已套用的 migration 版本 |
| GET | `/api/session` | 已登入回 `{email}`；未登入 401 |
| GET | `/auth/login?next=<url>` | 導向 Google OAuth，`next` 必須在前端來源允許清單內 |
| GET | `/auth/callback` | 建立 session cookie 後導回 `next` |
| POST | `/auth/logout` | 清除 session |
| GET | `/api/print/{id}` | 公開取件結果 JSON |
| GET | `/images/{folder}/{file}` | 公開圖檔（維持原路徑，前端與分享連結都指這裡） |
| GET/POST/PUT/DELETE | `/api/admin/*` | 既有管理端點，行為不變 |

相容處理：`GET /admin` 一律 302 到 `FRONTEND_ORIGIN/admin`。

`GET /ibon_print/{id}` 的網址已經印在分享連結與 QR Code 上，因此預設轉址到前端頁面，只有明確要求 JSON 的呼叫端例外（`?format=json`，或 `Accept` 含 `application/json` 且不含 `text/html`）。判斷不能只看 `Accept` 有沒有 `text/html`：LINE、IG 的內建瀏覽器與 QR 掃描 app 常送 `Accept: */*`，那些都是人在看，不是腳本。

### 跨來源

前後端不同來源，因此：

- `ALLOWED_ORIGINS` 為逗號分隔的來源允許清單（`wrangler.toml` 的 `[vars]`）。這份清單同時是 CSRF 防線與 OAuth `next` 的允許清單，因此不得包含 localhost：本機來源改放 `backend/.dev.vars`。
- 所有回應帶 `Access-Control-Allow-Origin`（回填請求的 Origin，僅限清單內）、`Access-Control-Allow-Credentials: true`、`Vary: Origin`。
- `OPTIONS` 預檢回 204，允許 `content-type` 與 `x-luma-app` 標頭。

### Cookie 與 CSRF

session cookie 必須跨站送出，因此改為 `SameSite=None; Secure; HttpOnly`。這會失去 SameSite 的 CSRF 保護，補兩道：

1. 所有非 GET 的 `/api/admin/*` 與 `/auth/logout` 要求 `x-luma-app: 1` 自訂標頭。自訂標頭強制觸發預檢，跨站表單無法偽造。
2. 同時檢查 `Origin` 標頭在允許清單內，不在則 403。

### 啟動時套用 migration

`migrations.py` 匯出有序的 migration 清單，每筆是 `{"name": ..., "statements": [...], "add_columns": [(table, column, definition)]}`；`add_columns` 為選填，用於 `ALTER TABLE` 這種沒有 `IF NOT EXISTS` 的敘述。首次請求時：

1. `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`。
2. 讀出已套用的 name，依序執行未套用者，每個 migration 完成後寫入紀錄。
3. 模組層級旗標記錄本 isolate 已完成，避免每次請求都查。

所有敘述必須可重複執行（`CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`）。`ALTER TABLE ADD COLUMN` 無法用 IF NOT EXISTS，改以 `PRAGMA table_info` 檢查欄位是否存在再決定是否執行；那道檢查與實際執行之間仍可能被另一個 isolate 插隊，因此重複欄位的錯誤要吞掉，其餘錯誤照常拋出。多個 isolate 可能同時啟動，因此紀錄寫入使用 `INSERT OR IGNORE`。

migration 失敗時回 503 並附上失敗的 migration 名稱，不讓請求在 schema 不完整的情況下繼續。失敗不會設定「已完成」旗標，下一個請求會重試。

`/images/{folder}/{file}` 只讀 R2，因此跳過 migration，D1 故障不會連帶讓公開頁的圖檔掛掉。`OPTIONS` 預檢同樣不碰資料庫。

## 前端

Vite + Preact + TypeScript。選 Preact 而非原生 DOM 操作，是因為 admin 介面已有可觀的狀態（選取資料夾、上傳進度、列印規格、檔案清單），手寫 DOM 同步是目前程式碼最難維護的部分。

- 路由：手寫路徑比對，不引入 router 套件。只有 `/admin` 與 `/ibon_print/:id` 兩條路徑，且沒有站內導航。
- `lib/api.ts` 統一加上 `credentials: 'include'` 與 `x-luma-app: 1`，並把 401 轉成導向 `${API_BASE}/auth/login?next=${location.href}`。導向前會在 `sessionStorage` 留下標記；若登入後第一個請求仍是 401（通常是瀏覽器封鎖跨站 cookie），改為顯示錯誤而非再次導向，避免無限迴圈。
- 兩頁的樣式最終打包成同一份 CSS，因此各自的規則都以 `body.admin` / `body.print` 限定作用域，由 `app.tsx` 依路徑設定 body class。
- `VITE_API_BASE` 於建置時注入後端來源。
- 樣式沿用 `.impeccable.md` 記錄的設計語言：暖白底、墨藍文字、低彩度藍綠、克制的紅色危險操作。CSS 拆成 `styles/base.css` 與各頁面樣式，不引入 CSS 框架。
- `public/_headers` 補回舊 Worker 對 admin 頁設定的 `X-Frame-Options: DENY` 與 `Referrer-Policy: no-referrer`；cookie 變成 SameSite=None 之後，少了這層會讓管理介面可被 iframe 點擊劫持。
- 公開取件頁維持 `noindex, nofollow`，因此不需要伺服器端渲染；QR Code SVG 由後端回傳的字串直接注入。

## 部署

兩個 wrangler 專案，兩個 GitHub Actions job：

- `backend`：`uv sync --frozen` 後 `uv run pywrangler deploy`，工作目錄 `backend/`。
- `frontend`：`npm ci`、`npm run build`、`npx wrangler deploy`，工作目錄 `frontend/`。前端 worker 只有 `assets` 設定，`not_found_handling` 設為 `single-page-application`。

兩個 job 共用同一組 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。前端建置需要 `VITE_API_BASE`，以 repository variable 提供。

先部署後端再部署前端，確保前端上線時 API 已存在。

## 錯誤處理

- 後端維持既有的錯誤形狀 `{"error": ...}`，前端以此顯示提示訊息。
- 前端 API 包裝把網路錯誤與非 JSON 回應轉成一致的 `Error`，由頁面層顯示到既有的浮動狀態列。
- 未登入時 admin 頁不渲染管理介面，直接導向登入。

## 驗證

- 後端：`python -m compileall` 等價的語法檢查，以及 `uv run pywrangler dev` 手動打 `/api/health`、`/api/session`。
- 前端：`npm run build`（含 `tsc --noEmit`）。
- 端對端：本機同時跑兩者，確認登入、資料夾 CRUD、上傳、列印規格與公開取件頁。

## 風險

- 跨站 cookie 依賴瀏覽器允許第三方 cookie。Safari 與部分瀏覽器的封鎖政策可能讓 admin 登入失效。若發生，退路是替兩個部署掛上同一個網域的子網域（`api.` 與 `www.`），讓 cookie 變成同站。這是本次架構最主要的技術風險，已知且可接受。
- 既有 `/ibon_print/{id}` 分享連結改為轉址，多一次 round trip。
