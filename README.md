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
  wrangler.jsonc      Worker 與靜態資產設定
  worker/index.ts     供應 SPA、為 /bio_link 注入分享預覽標籤
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
| GET | `/api/admin/bio-link/stats?days=` | 造訪統計，需登入 |

### 跨來源與 CSRF

前端是不同來源，session cookie 因此為 `SameSite=None; Secure; HttpOnly`。少掉的 SameSite 保護由兩件事補上：

1. 所有非 GET 請求必須帶 `x-luma-app: 1`。自訂標頭會強制觸發 CORS 預檢，跨站表單無法偽造。
2. 同時檢查 `Origin` 在 `ALLOWED_ORIGINS` 清單內，否則 403。

`ALLOWED_ORIGINS` 與 `FRONTEND_ORIGIN` 定義在 [backend/wrangler.toml](backend/wrangler.toml) 的 `[vars]`。新增前端網域時要同步更新。

### 公開端點的速率限制

每個不需登入就能打到的端點都有 per-IP 上限，定義在 [backend/wrangler.toml](backend/wrangler.toml) 的 `[[ratelimits]]`：

| 端點 | 上限 | 為什麼 |
| --- | --- | --- |
| `/auth/login` | 10 次／分 | 每次嘗試都會在訪客還沒證明任何事之前寫一列 `admin_oauth_states`。D1 寫入額度與 session 表共用，打爆它就等於把管理者鎖在自己的後台外面 |
| `/api/print/{id}`、`/ibon_print/{id}` | 20 次／分 | 快取未命中時要從 R2 讀最多 15 MB，再跑四步驟的 ibon 上傳 |
| `/api/bio-link`、`/r/{id}` | 120 次／分 | 兩次 D1 讀取，加上每位訪客每天最多一次的去重寫入 |
| `/images/{folder}/{file}`、`/bio-link-assets/{file}` | 240 次／分 | 每次一筆 R2 讀取。額度較寬，因為一間教室共用一個對外位址，而 admin 的縮圖一次就抓八張 |

以 Cloudflare 自行填入的 `CF-Connecting-IP` 為 key，該標頭無法被用戶端偽造。取不到位址時**不套用限制**，而不是把所有人算成同一個——否則單一來源就能吃光全體額度。

限制是「盡力而為」：綁定不存在或呼叫失敗時一律放行。會讓網站掛掉的速率限制，比它要防的濫用更糟。

這一層保護的是 D1 寫入額度、R2 讀取與 ibon 上傳。**它保護不了 Worker 自己的每日請求額度**——限制器要執行，Worker 就已經被叫起來了。那一層需要 Cloudflare 的 WAF 速率限制規則，在 Worker 之前攔下請求；目前設定的是 `luma-studio.tw` zone 上一條涵蓋所有 API 路徑、每 10 秒 50 次、封鎖 10 秒的規則。

R2 物件的回應帶了 `cache-control: public, max-age=3600`，但 **Cloudflare 預設不會快取 Worker 產生的回應**。要讓重複請求不進 R2，需在儀表板加一條 Cache Rule：符合 `/images/*` 或 `/bio-link-assets/*` 時設為 Eligible for cache。目前沒有設，所以每一次請求都是一筆 R2 讀取。

### 備份

[.github/workflows/backup.yml](.github/workflows/backup.yml) 每天台北時間清晨三點把 D1 匯出、壓縮後上傳到 R2 的 `_backups/YYYY-MM-DD.json.gz`。也可以在 Actions 頁面手動觸發。

用的是 `d1 execute` 逐表查詢而不是 `d1 export`。後者的端點即使 token 有 `D1:Edit` 仍回 `Authentication error [code: 10000]`，而查詢端點是部署本來就在用的那一套。

備份用自己的 token，存成 GitHub secret `CLOUDFLARE_BACKUP_TOKEN`。這個工作會讀出整個資料庫，部署 token 沒有理由具備那個能力；反過來部署權限對備份也毫無用處。建立方式：

My Profile → API Tokens → Create Token → Create Custom Token

| Type | Resource | Level |
| --- | --- | --- |
| Account | D1 | Edit |
| Account | Workers R2 Storage | Edit |

Account Resources 選 Include 你的帳號。建立後把值存進 GitHub 的 `production` environment（或 repository secrets）。

**錯誤代碼的分辨**：`10000` 是 token 權限不足，`7403` 是帳號無權存取該服務——後者通常代表 token 值或 `CLOUDFLARE_ACCOUNT_ID` 與儀表板上看到的那一組對不起來，加權限沒有用。工作的第一步會跑 `wrangler whoami`，就是為了先分辨這兩種情況。

只匯出四張表：`bio_link_settings`、`bio_link_items`、`bio_link_events`、`folder_print_settings`。刻意排除的是：

- `admin_sessions`、`admin_oauth_states` — 裡面是**有效的憑證**，備份等於把祕密多存一份，而且重登入就能重建
- `ibon_print_cache` — 24 小時就過期，重跑一次上傳即可

匯出後會檢查檔案大小與內容，空檔或缺表就讓工作失敗——否則會安靜地把無用的備份存起來，等到真的要用才發現。

還原時先把備份轉成 SQL，再送進 D1：

```powershell
python scripts/restore-d1.py backup.json.gz > restore.sql
uv --directory backend run pywrangler d1 execute luma-ibon-cache --remote --file restore.sql
```

[scripts/restore-d1.py](scripts/restore-d1.py) 產生的是 `INSERT OR REPLACE`：主鍵相同的列會被覆蓋，備份之後才新增的列保持不動，所以還原不會安靜地刪掉較新的資料。要讓資料庫完全等同備份時加 `--replace-tables`，它會先清空各表。也可以用 `--table` 只還原其中幾張。

備份不會自動清理。要限制數量的話，在 R2 → `luma-ibon-images` → Settings 加一條 lifecycle rule，讓 `_backups/` 前綴的物件在 90 天後過期。

**R2 裡的圖檔本身沒有備份。** 客人的作品圖只有一份，這是已知的缺口。

### 監測

[.github/workflows/canary.yml](.github/workflows/canary.yml) 每天台北時間早上七點半跑兩件事。失敗時 GitHub 會寄信給 repo 擁有者。

**ibon 取件流程**：向 `zz_canary` 這個資料夾請求取件編號，確認拿到的 pincode 真的是 8–12 位數字、有列印期限、有圖檔清單。

這條流程走的是 ibon 的一般消費者網頁介面，不是官方 API——ibon 隨時可能改欄位或開始擋 Cloudflare 的流量。沒有這個監測的話，你會在客人站在超商裡打不開連結時才知道。

執行前會先刪掉該資料夾的 24 小時快取。少了這步，canary 第二天起就只是在讀自己的資料庫，會在真正的流程壞掉時天天顯示正常。

**公開路徑**：確認 `/`、`/admin`、`/bio_link`、`/ibon_print/{id}`、`/api/health`、`/api/bio-link` 都回 200，而且 `/bio_link` 帶著分享預覽標籤。`/admin` 曾經因為前端 Worker 的一行錯誤而 307 導回首頁，這類檢查就是為了讓那種問題自己現形。

建立 `zz_canary` 資料夾時放一張小圖即可。它會出現在 admin 的資料夾清單裡（底線開頭的 id 無法通過 `IDENTIFIER_PATTERN`，所以不能藏起來），排在最後。

**這會每天在 ibon 產生一組真實的取件編號。** 量很小，但那是真的在使用 ibon 的服務。

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

7. 套用下一節的後台設定。

## Cloudflare 後台設定

以下設定**不在版控裡**，只存在於 Cloudflare 儀表板。重建環境或換帳號時要照著設一遍，否則會出現一些很難查的症狀——這一節就是為了避免那些。

### 網域與 Worker 綁定

網域註冊在 Gandi，但 nameserver 指向 Cloudflare（Gandi → 網域管理 → Nameservers → External）。Workers 的 Custom Domain 必須在 zone 由 Cloudflare 託管的前提下才能綁。

Workers & Pages → 選 Worker → Settings → Domains & Routes → Add → Custom Domain：

| Worker | 網域 |
| --- | --- |
| `luma-studio-web` | `luma-studio.tw` |
| `luma-studio-web` | `www.luma-studio.tw` |
| `luma-studio` | `api.luma-studio.tw` |

DNS 記錄與憑證由 Cloudflare 自動建立。**綁定前不要手動加 A/CNAME**，已存在的記錄會讓綁定失敗。

### Worker secrets

只有後端 Worker 需要。用指令設定，不要寫進 `wrangler.toml` 的 `[vars]`——那份設定會進版控。

```powershell
uv --directory backend run pywrangler secret put GOOGLE_CLIENT_ID
uv --directory backend run pywrangler secret put GOOGLE_CLIENT_SECRET
uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI
uv --directory backend run pywrangler secret put VISITOR_SALT
```

`GOOGLE_OAUTH_REDIRECT_URI` 是 `https://api.luma-studio.tw/auth/callback`。`VISITOR_SALT` 填任意隨機字串。

### 速率限制規則

Security → Security rules → Rate limiting rules → Create rule。

| 欄位 | 值 |
| --- | --- |
| Rule name | `api flood guard` |
| Expression | `starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/auth/") or starts_with(http.request.uri.path, "/r/") or starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/bio-link-assets/") or starts_with(http.request.uri.path, "/ibon_print/")` |
| Requests / Period | 50 / 10 秒 |
| Action / Duration | Block / 10 秒 |

免費方案把 Period、Duration 鎖在 10 秒，計數依據固定為 IP，只有 Requests 可調。

**為什麼是 50 而不是更嚴**：團體包班時整間教室共用一個對外 IP，7-11 店內 Wi-Fi 也是。設太緊會整班一起被擋。觀察 Security → Events 的觸發次數再調整。

這是唯一能保護 **Worker 每日請求額度**的一層，因為它在 Worker 之前執行。`backend/src/rate_limit.py` 的限制器保護的是 D1、R2 與 ibon 上傳，但限制器要執行，Worker 就已經被叫起來了。

### 快取規則

Caching → Cache Rules → Create rule。

| 欄位 | 值 |
| --- | --- |
| Rule name | `cache r2 assets` |
| Expression | `starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/bio-link-assets/")` |
| Cache eligibility | Eligible for cache |
| Edge TTL | Use cache-control header if present, bypass cache if not |

Cloudflare **預設不會快取 Worker 產生的回應**，所以沒有這條規則的話，每一次圖檔請求都是一筆 R2 讀取。Worker 已經在回應中送出 `cache-control: public, max-age=3600`，這條規則只是讓它生效。

### 安全性與協定設定

| 位置 | 項目 | 值 | 原因 |
| --- | --- | --- | --- |
| Security → Settings | Bot Fight Mode | **關** | 對純 JSON API 子網域誤判率高，會擋掉帶認證的 XHR |
| Security → Settings | Browser Integrity Check | 開 | 預設值，擋標頭異常的請求 |
| Speed → Settings | Always use HTTPS | 開 | |
| Speed → Settings | 0-RTT Connection Resumption | **關** | early data 在某些路徑上會被回 403 |

### 曾經踩過的坑

**HTTP/3 回 403。** 曾出現整個 `api.luma-studio.tw` 在某台機器的 Edge 上回 403，但同一台機器的 curl 正常、無痕視窗正常、Cloudflare 的 firewall event 查無記錄。原因是該網路的 HTTP/3（QUIC）路徑異常；`edge://flags` 關閉 Experimental QUIC protocol 後恢復。

診斷順序：比對瀏覽器與 curl 的 `https://www.cloudflare.com/cdn-cgi/trace` 輸出，若 `ip=` 相同而 `http=` 不同，就是協定層而非 Cloudflare 設定的問題。**不要在這種情況下逐項關閉安全設定**——firewall event 查不到記錄就代表不是那一層擋的。

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

連結順序可拖曳調整，也保留上下箭頭按鈕——拖曳在鍵盤上無法操作，手機上也不好按。

### 造訪統計

編輯頁下方有 7／30／90 天的統計：頁面瀏覽、連結點擊、點擊率、每日長條圖、各連結點擊排行，以及國家、來源網站、裝置的前幾名。

公開頁上的每個連結都指向 `/r/{id}`，由後端記錄後再轉出。記錄的是每位訪客每天每個目標一筆，內容包含國家、城市、來源網站、裝置類別與一組每日輪替的匿名雜湊，**無法識別個人，也無法跨日追蹤**。User-Agent 看起來是機器人或連結預覽器時完全不記錄。

因此所有數字都是「不重複訪客」而非原始次數：同一人整天重整也只算一次。這不只是讓數字有意義，更是必要的防護——這兩個端點是公開的，而 D1 的每日寫入額度與 admin session 共用。

### 分享預覽

`/bio_link` 被貼到 LINE、Facebook、Slack 時會顯示標題、簡介與品牌卡片。SPA 在爬蟲眼中是空白的 HTML，所以前端 Worker（[frontend/worker/index.ts](frontend/worker/index.ts)）會在回傳頁面前，向 API 取得目前內容並把 Open Graph 標籤寫進 `<head>`。爬蟲來得又急又密集，因此那次 API 呼叫在邊緣快取五分鐘。

預覽圖是 `public/assets/share-card.png`（1200×630），不是頭像——預覽卡片會裁切成約 1.91:1，方形頭像進去只會剩下一條。換 logo 之後重新產生：

```powershell
uv run --with pillow python scripts/build-share-card.py
```

## 執行時行為與限制

- D1 快取保存 24 小時，並綁定資料夾的 ibon `SelectType`；快取命中時不會再上傳至 ibon。
- 快取未命中時，只接受資料夾內 1–8 個 `jpg/jpeg/png/bmp/gif`，總大小不得超過 15 MB。
- ibon 的 R2 object key 必須為 `<id>/<filename>`。Bio link 頭像是例外，放在 `_bio-link/` 前綴下。
- Bio link 的事件記錄採用「每位訪客每天每個目標最多一筆」，靠唯一索引與 `INSERT OR IGNORE` 達成。這不只是為了數字準確：這兩個端點是公開的，而 D1 的每日寫入額度與 admin session 共用，沒有上限的計數器等於讓任何人都能把你鎖在自己的後台外面。
- 上傳順序為 `BaseEntry/GetEntry` → `IbonUpload/GetPincode` → `GetChunksize` → `Upload`。上游失敗時 JSON API 會回傳不含 token 的 `stage` 與安全診斷資訊。
- ibon 可能變更一般消費者流程或拒絕 Cloudflare 流量；每次部署後應以一個實際資料夾驗證。
- 管理登入依賴跨站 cookie。若瀏覽器封鎖第三方 cookie 導致登入失效，退路是讓前後端共用同一個網域的兩個子網域。
