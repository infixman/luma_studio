# Luma Studio ibon 列印

從 R2 讀取指定資料夾的圖片，走 ibon 一般網頁上傳流程，將取件編號快取 24 小時於 D1，並提供公開取件頁與受 Google OAuth 保護的圖檔管理介面。

本專案不使用 ibon 僅供企業客戶使用的 Open API。

公開端與管理端是各自獨立的部署：

| 部署 | 內容 | 網址 |
| --- | --- | --- |
| `luma-studio` | Cloudflare Python Worker，公開 JSON API 與圖檔 | `https://api.luma-studio.tw` |
| `luma-studio-admin-api` | Cloudflare Python Worker，管理 API | `https://admin-api.luma-studio.tw` |
| `luma-studio-web` | Vite + Preact 靜態站台，公開取件頁與 bio link | `https://luma-studio.tw` |
| `luma-studio-admin` | Vite + Preact 靜態站台，管理介面 | `https://admin.luma-studio.tw` |

兩個 Worker 共用 `backend/src/` 的程式碼，只是進入點不同（[main.py](backend/src/main.py) 與 [admin_main.py](backend/src/admin_main.py)），設定檔分別是 [wrangler.toml](backend/wrangler.toml) 與 [wrangler.admin.toml](backend/wrangler.admin.toml)。

拆開的理由是 cookie 隔離。兩邊的 session cookie 都沒有設 `Domain`，所以是 host-only —— 管理者的 session 只會被送到 `admin-api.luma-studio.tw`，公開站台上的任何腳本都碰不到它。四個網域仍同屬 `luma-studio.tw`，因此 `SameSite=Lax` 不受影響。

管理 Worker 是**唯一會套用 D1 migration 的部署**。公開 Worker 只讀取 `schema_migrations` 回報狀態，不修改 schema：結帳是熱路徑，不該為 schema 檢查付出冷啟動成本，而公開得到的 Worker 也沒有理由具備 `ALTER TABLE` 的能力。因此部署順序固定為管理端先、公開端後。

管理介面搬到 `admin.luma-studio.tw` 之後，前台 Worker 會把舊的 `/admin` 與 `/admin/bio-link` 以 301 永久轉向新網址（去掉 `/admin` 這一段，因為新主機上每一頁都是管理頁）。搬遷期間公開 Worker 上曾有一層 `/api/admin/*` 轉接，現已移除——那些路徑在公開 Worker 上回 404 而不是 401，因為 401 代表處理器還接著，只差一道 session 檢查。

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

已知缺口與待辦記在 [docs/backlog.md](docs/backlog.md)。

## 專案結構

```text
backend/
  wrangler.toml       公開 Worker 的設定與 [vars]
  wrangler.admin.toml 管理 Worker 的同上
  src/
    router.py         兩個 Worker 共用的 entrypoint：預檢、CSRF、migration、分派
    main.py           公開路由
    admin_main.py     管理路由
    responses.py      Ctx、CORS 與回應建構
    auth_admin.py     Google OAuth 與管理者 session
    admin_api.py      圖檔與列印設定管理
    ibon.py           ibon 上傳流程、D1 快取、列印規格
    bio_link.py       Bio link 的設定、連結、匿名點擊記錄
    bio_link_api.py   管理端 /api/bio-link* 端點
    shop.py           商品、規格、庫存與照片
    shop_admin_api.py 管理端商品端點
    migrations.py     D1 schema，由管理 Worker 套用
    common.py         共用常數與小工具
frontend/
  wrangler.jsonc      商店前台的 Worker 與靜態資產設定
  wrangler.admin.jsonc 管理後台的同上
  index.html          前台 shell
  admin.html          後台 shell
  .env.production     前台建置的 API 網址
  .env.admin          後台建置的 API 網址
  vite.config.ts      依 --mode 切換進入點與輸出目錄
  worker/
    storefront.ts     供應前台 SPA、為 /bio_link 注入分享預覽標籤、轉走舊的 /admin
    admin.ts          供應後台 SPA
  public/assets/      logo 與教學圖
  src/
    shared/           兩邊共用：api、types、SocialIcon、base.css
    storefront/       main、app、HomePage、PrintPage、BioLinkPage、行事曆
    admin/            main、app、AdminPage、BioLinkAdminPage、列印規格
design/               logo 原始檔，非公開路徑
scripts/              本機診斷與 R2 同步腳本
docs/superpowers/specs/  設計文件
.github/workflows/    main branch 自動部署
```

`src/` 底下只有三個目錄，規則很簡單：東西放在**用到它的那一邊**，兩邊都用到才進 `shared/`。目前 `shared/` 只有 API client、型別、社群圖示與基礎樣式。

## 後端 API

### 公開 Worker — `api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/health` | 存活檢查，唯讀回報資料庫中已套用的 migration |
| GET | `/api/print/{id}` | 取件編號 JSON |
| GET | `/images/{folder}/{file}` | 公開圖檔 |
| GET | `/api/bio-link` | Bio link 公開內容，順帶記一筆瀏覽 |
| GET | `/api/bio-link/calendar` | 課程表，獨立一次請求 |
| GET | `/r/{id}` | 記一筆點擊後 302 到目標網址 |
| GET | `/bio-link-assets/{file}` | Bio link 頭像 |
| GET | `/api/products` | 上架商品列表 |
| GET | `/api/products/{slug}` | 單一商品，只有 `active` 的解得開 |
| POST | `/api/cart/validate` | 依購物車內容重算價格、庫存與運費 |
| GET | `/api/shipping-methods` | 啟用中的配送方式與運費 |
| GET | `/shop-assets/{file}` | 商品照片 |
| GET | `/auth/login?next=`、`/auth/callback` | **顧客**的 Google 登入 |
| POST | `/auth/logout` | 清除顧客 session |
| GET | `/api/session` | 已登入回顧客資料，否則 401 |
| GET / PATCH | `/api/profile` | 顧客的預設收件資料 |
| POST | `/api/checkout` | 建立訂單並保留庫存 |
| GET | `/api/orders`、`/api/orders/{id}` | 自己的訂單 |
| POST | `/api/orders/{id}/fake-payment` | **開發用**，未開啟時一律 404 |

`/auth/*` 與 `/api/session` 在兩台主機上同名但意義不同：這裡是顧客，管理主機上是店主。兩邊的 cookie 名稱不同且都是 host-only，所以拿錯只會得到 401，不會意外升權。

### 管理 Worker — `admin-api.luma-studio.tw`

路徑上沒有 `/api/admin` 前綴。這台主機上每一支都是管理端點，所以登入檢查是靠近頂端的單一閘門（[admin_main.py](backend/src/admin_main.py)），不是每條路由各自記得要做的事。

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/health` | 存活檢查，並套用 migration |
| GET | `/api/session` | 已登入回 `{email}`，否則 401 |
| GET | `/auth/login?next=` | 導向 Google OAuth，`next` 必須在允許來源內 |
| GET | `/auth/callback` | 建立 session 後導回 `next` |
| POST | `/auth/logout` | 清除 session |
| — | `/api/folders`、`/api/objects`、`/api/upload`、`/api/print-settings` | 圖檔與列印設定管理 |
| — | `/api/bio-link*` | Bio link 編輯 |
| GET | `/api/bio-link/stats?days=` | 造訪統計 |
| GET / POST | `/api/products` | 商品列表與新增 |
| PUT | `/api/products/order` | 排序，必須排在 `{id}` 路由之前 |
| GET / PUT / DELETE | `/api/products/{id}` | 單一商品 |
| POST | `/api/products/{id}/variants` | 新增規格 |
| POST | `/api/products/{id}/images` | 上傳照片（multipart） |
| PUT / DELETE | `/api/variants/{id}` | 規格 |
| DELETE | `/api/images/{id}` | 照片 |
| GET / PUT | `/api/shipping-methods` | 運費與免運門檻 |

`/api/bio-link` 在兩台主機上都存在，語意不同：公開端是唯讀內容，管理端是編輯。不會混淆，因為授權管理端的 cookie 永遠不會被送到公開端。

### 跨來源與 CSRF

前端與 API 是不同來源（雖然同屬一個站台），session cookie 為 `SameSite=Lax; Secure; HttpOnly`。跨來源的部分由兩件事補上：

1. 所有非 GET 請求必須帶 `x-luma-app: 1`。自訂標頭會強制觸發 CORS 預檢，跨站表單無法偽造。
2. 同時檢查 `Origin` 在 `ALLOWED_ORIGINS` 清單內，否則 403。

兩個閘門都在 [router.py](backend/src/router.py) 的 `serve` 裡，兩個 Worker 共用同一份 —— 各留一份副本會漂移，而會漂移的那一份就是沒人在看的那一份。

`ALLOWED_ORIGINS` 與 `FRONTEND_ORIGIN` 各自定義在該 Worker 的設定檔 `[vars]`。兩份清單刻意不重疊：公開 API 不接受管理網域的來源，管理 API 也不接受公開站台的來源。

瀏覽器端有對應的一半：`_headers` 裡的 CSP `connect-src` 也是各站只放行自己的 API。這份檔案由 [vite.config.ts](frontend/vite.config.ts) 依 build mode 產生，而不是放在 `public/` —— `public/` 會被複製進兩份建置，共用一份就代表 `connect-src` 必須是兩邊需求的聯集，而聯集正好是我們不想要的東西。政策的來源是 `.env` 裡那組網址，跟 client 讀的是同一份，兩者不會各說各話。

### 速率限制

限制器宣告在**擁有該路由的那個 Worker** 的設定檔裡：

| Worker | 端點 | 上限 | 為什麼 |
| --- | --- | --- | --- |
| 管理 | `/auth/login` | 10 次／分 | 每次嘗試都會在訪客還沒證明任何事之前寫一列 `admin_oauth_states`。D1 寫入額度與 session 表共用，打爆它就等於把管理者鎖在自己的後台外面 |
| 公開 | `/api/print/{id}`、`/ibon_print/{id}` | 20 次／分 | 快取未命中時要從 R2 讀最多 15 MB，再跑四步驟的 ibon 上傳 |
| 公開 | `/auth/login` | 20 次／分 | 同上，但商店的顧客比後台的一位店主多，所以放寬 |
| 公開 | `/api/checkout` | 10 次／分 | 會扣庫存並寫四張表。沒有人一分鐘正當地下十張單，而嘗試這麼做的腳本等於每次把商品從架上拿走十五分鐘 |
| 公開 | `/api/products`、`/api/cart/validate` | 180 次／分 | 商品頁是好幾次 D1 讀取，而逛商店的人點擊遠多於看 bio link 的人 |
| 公開 | `/api/bio-link`、`/r/{id}` | 120 次／分 | 兩次 D1 讀取，加上每位訪客每天最多一次的去重寫入 |
| 公開 | `/images/{folder}/{file}`、`/bio-link-assets/{file}`、`/shop-assets/{file}` | 240 次／分 | 每次一筆 R2 讀取。額度較寬，因為一間教室共用一個對外位址，而 admin 的縮圖一次就抓八張 |

分開宣告不只是整理：公開站台被打爆時，不會連帶吃掉管理者的登入額度。

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

匯出清單在 workflow 的 `TABLES`：bio link 三張、`folder_print_settings`、商城的 `products`／`product_variants`／`product_images`／`shipping_methods`，以及交易相關的 `customers`／`orders`／`order_items`／`payment_attempts`／`order_audit_log`。刻意排除的是：

- `admin_sessions`、`admin_oauth_states`、`customer_sessions`、`customer_oauth_states` — 裡面是**有效的憑證**，備份等於把祕密多存一份，而且重登入就能重建
- `ibon_print_cache` — 24 小時就過期，重跑一次上傳即可

**新增資料表時要同步加進 `TABLES`。** 缺表檢查是照同一個變數迭代的，所以漏掉的表不會被抓到——備份會照常成功，直到真的要用的那天才發現裡面沒有它。

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

schema 定義在 [backend/src/migrations.py](backend/src/migrations.py)，由**管理 Worker** 在每個 isolate 首次收到請求時自動套用，並以 `schema_migrations` 表記錄。所有敘述都必須可重複執行，因為多個 isolate 會同時啟動。手動執行 `wrangler d1 execute` 已不再需要。

公開 Worker 不套用任何 migration，`/api/health` 只讀取 `schema_migrations` 回報現況。因此部署順序是管理端先、公開端後；公開端回報的清單短少，代表部署順序出了問題，該被看見而不是被隨手修掉。

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

3. 把 D1 輸出的 `database_id` 同時填入 [backend/wrangler.toml](backend/wrangler.toml) 與 [backend/wrangler.admin.toml](backend/wrangler.admin.toml)。兩個 Worker 必須指向同一個資料庫，填錯會安靜地把資料切成兩份。

4. 部署後端。**管理 Worker 要先部署**，因為只有它會套用 migration，公開 Worker 只讀不寫：

   ```powershell
   uv --directory backend run pywrangler deploy -c wrangler.admin.toml
   uv --directory backend run pywrangler deploy
   ```

   secret 是 per-Worker 的，`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_OAUTH_REDIRECT_URI` 要在兩個 Worker 上各設一次，不會互相共用。

5. 部署前端。兩個站台各自建置、各自部署：

   ```powershell
   cd frontend
   npm ci
   npm run build
   npx wrangler deploy -c wrangler.admin.jsonc
   npx wrangler deploy
   ```

   `npm run build` 會跑型別檢查再依序建置兩份。API 網址來自 [.env.production](frontend/.env.production) 與 [.env.admin](frontend/.env.admin)，不是環境變數——兩份建置需要不同的值，用同一個 shell 變數餵兩邊，後台就會安靜地連到公開 API。

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
| `luma-studio-admin` | `admin.luma-studio.tw` |
| `luma-studio` | `api.luma-studio.tw` |
| `luma-studio-admin-api` | `admin-api.luma-studio.tw` |

DNS 記錄與憑證由 Cloudflare 自動建立。**綁定前不要手動加 A/CNAME**，已存在的記錄會讓綁定失敗。

### Worker secrets

只有後端 Worker 需要。用指令設定，不要寫進 `wrangler.toml` 的 `[vars]`——那份設定會進版控。

**secret 是 per-Worker 的**，而且兩個 Worker 需要的**不一樣**。

| Worker | Secret | 內容 |
| --- | --- | --- |
| `luma-studio` | `GOOGLE_CUSTOMER_CLIENT_ID` | 顧客那組 OAuth client |
| `luma-studio` | `GOOGLE_CUSTOMER_CLIENT_SECRET` | 同上 |
| `luma-studio` | `GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI` | `https://api.luma-studio.tw/auth/callback` |
| `luma-studio` | `VISITOR_SALT` | 任意隨機字串，雜湊 bio link 訪客識別 |
| `luma-studio-admin-api` | `GOOGLE_CLIENT_ID` | 店主那組 OAuth client |
| `luma-studio-admin-api` | `GOOGLE_CLIENT_SECRET` | 同上 |
| `luma-studio-admin-api` | `GOOGLE_OAUTH_REDIRECT_URI` | `https://admin-api.luma-studio.tw/auth/callback` |

```powershell
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_CLIENT_ID
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_CLIENT_SECRET
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI
uv --directory backend run pywrangler secret put VISITOR_SALT

uv --directory backend run pywrangler secret put GOOGLE_CLIENT_ID -c wrangler.admin.toml
uv --directory backend run pywrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.admin.toml
uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI -c wrangler.admin.toml
```

管理 Worker **不需要** `VISITOR_SALT`（只有 `bio_link.record_event` 讀它，而記錄瀏覽是公開端的事），也不需要任何 `IBON_*`（後台只讀 D1 的列印設定，不跑上傳流程）。

兩組 OAuth client 而不是一組配兩個 redirect URI：店主那組可以在 Google Cloud Console 上設得更嚴，而顧客那組的 client secret 外洩也不會波及後台。

從舊架構搬過來時，公開 Worker 上原有的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_OAUTH_REDIRECT_URI` 已經沒有程式碼在讀——管理登入搬走了。留著只是三個沒有用途的憑證，用 `pywrangler secret delete` 移除。

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

後端兩個 Worker、前端兩個站台，各自獨立啟動，只跑正在改的那些就好：

```powershell
uv --directory backend run pywrangler dev
uv --directory backend run pywrangler dev -c wrangler.admin.toml
```

```powershell
cd frontend
npm run dev          # 商店前台，port 5173
npm run dev:admin    # 管理後台，port 5174
```

前端預設打正式環境的 API。要改打本機後端，寫進 gitignore 過的本機覆寫檔：

```text
# frontend/.env.local — 商店前台（npm run dev 是 development 模式）
VITE_API_BASE=http://localhost:8787
VITE_PUBLIC_API_BASE=http://localhost:8787
```

```text
# frontend/.env.admin.local — 管理後台
VITE_API_BASE=http://localhost:8788
VITE_PUBLIC_API_BASE=http://localhost:8787
```

後台要用 `.env.admin.local` 而不是 `.env.local`：Vite 的優先序是 `.env` < `.env.local` < `.env.[mode]` < `.env.[mode].local`，所以 `.env.admin` 會蓋掉 `.env.local`。

後端的本機來源設定放在 `backend/.dev.vars`（見 [backend/.dev.vars.example](backend/.dev.vars.example)），**不要**把 localhost 寫進 `wrangler.toml` 的 `[vars]`——那份設定會上到 production，等於讓任何在該埠上的程式取得正式環境的寫入權。

注意本機為 http，瀏覽器不會接受 `Secure` cookie，因此需要登入的流程要對著已部署的後端測試。

## Admin 與 Google OAuth

管理介面：

```text
https://admin.luma-studio.tw
```

舊網址 `https://luma-studio.tw/admin` 會 301 轉過來。

**未登入的訪客只會看到一頁登入畫面**，沒有分頁列、沒有卡片、沒有表單（[AdminGate](frontend/src/admin/components/AdminGate.tsx)）。先渲染介面、再讓各頁的 401 把人踢去 Google，等於讓路過的人看完整份功能清單——分頁名稱、卡片標題、每個表單的形狀。單獨看都不是什麼機密，合起來就是一份寫給不該讀的人看的營運說明。

這是**揭露面**的處理，不是授權本身。真正的邊界在管理 Worker：沒有 session 的請求一律 401，這件事有測試守著（`test_admin_routing.py`）。前端的閘門讓人看不到，後端的閘門讓人拿不到。

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

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 在 `main` 有新 commit 時部署四個站台，但只有**兩個 job**：

```text
後端 Worker（測試 → 管理 API → 公開 API）
        ↓
網站（測試 → 建置 → 管理後台 → 商店前台）
```

四個部署但只有兩條真正的依賴：**schema 要先於讀它的東西**，**API 要先於呼叫它的頁面**。那是一條線，不是一張圖。job 內部的先後就是普通的步驟順序，比一堆 `needs:` 好讀，而且不用多付一份冷環境的成本——兩個後端 Worker 共用同一份原始碼和同一個 token。

**測試跟它守護的部署放在同一個 job。** 拆成四個 job 時，測試只跑在其中兩個，另外兩個靠 `needs` 假設上游測過了——那是一個沒有東西在強制的約定，改動依賴關係就會讓測試安靜地不再擋住部署。

商店前台放在管理後台之後，只是為了讓 `/admin` 的 301 一上線就有地方可去。這是步驟順序，不是 job 依賴：顧客看得到的商店，不該被內部工具的建置擋住。

所有 job 都綁在名為 `production` 的 GitHub Environment，請先建立該 environment，再於 repository 的 **Settings → Secrets and variables → Actions**（或該 environment）設定：

- `CLOUDFLARE_API_TOKEN`：具此帳號 Workers 部署權限的 API token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID。

前端的 API 網址不再由 CI 變數提供，改放在 [frontend/.env.production](frontend/.env.production) 與 [frontend/.env.admin](frontend/.env.admin)。兩份建置需要不同的值，一個 shell 變數同時餵兩邊會讓後台連錯 API，而那是一種不會報錯的壞法。

Google OAuth secrets 只留在 Cloudflare，GitHub Actions 不需要也不應持有它們。

## 商城

設計文件在 [docs/superpowers/specs/2026-07-28-shopping-cart-design.md](docs/superpowers/specs/2026-07-28-shopping-cart-design.md)。目前完成的是**目錄、後台管理與前台展示**；購物車、結帳與金流是後續階段。

| 位置 | 網址 |
| --- | --- |
| 商品列表 | `luma-studio.tw/shop` |
| 單一商品 | `luma-studio.tw/shop/{slug}` |
| 購物車 | `luma-studio.tw/cart` |
| 結帳 | `luma-studio.tw/checkout` |
| 我的訂單 | `luma-studio.tw/orders` |
| 商品管理 | `admin.luma-studio.tw/products` |
| 運費設定 | `admin.luma-studio.tw/shipping` |

後台可以新增商品、編輯規格與庫存、上傳照片、切換上架狀態，以及設定每種配送方式的運費與免運門檻。

前台**只看得到 `active` 的商品**。草稿即使有人猜中 slug 也解不開，已下架的則會停止販售——兩者都回 404，因為對顧客而言那就是同一件事。

### 購物車

購物車只存在瀏覽器的 localStorage，內容只有 `variantId` 和數量。**價格、名稱與是否還買得到，每次都由伺服器從資料庫重算**（`POST /api/cart/validate`）。放了一週的分頁不會顯示過期價格，手動改 localStorage 也只換得到一個被拒絕的請求。

重算的結果分三種，都會回報給顧客而不是默默處理掉：

| 情況 | 回報 |
| --- | --- |
| 商品下架、規格停用、資料列消失 | `unavailable`，整行移除 |
| 庫存為 0 | `out_of_stock`，整行移除 |
| 庫存不足以滿足數量 | `reduced`，數量下修並附上實際可買數 |

免運門檻是**每種配送方式各自設定**。宅配與超商的成本差很多，共用一個門檻會逼你把它訂在最貴的那個。門檻是「達到就免運」而不是「超過才免運」——宣傳滿 1,000 免運卻對剛好 1,000 元的訂單收費，那不是規則，是客訴。

### 結帳與庫存

逛商品和加購物車**不需要登入**，按下結帳才要求 Google 登入。顧客的登入與店主的登入是兩套完全獨立的東西：不同的 OAuth client、不同的資料表、不同的 cookie 名稱，而且兩邊的 cookie 都是 host-only。

**庫存在建立訂單時就扣，不是付款成功才扣。** 等付款代表兩個人可以同時買到最後一件；永遠保留代表沒完成的購物車會讓商品永久離架。所以保留有期限：訂單建立時扣庫存並記下 `reserved_until`（15 分鐘），Cron Trigger 每 5 分鐘把逾期未付款的訂單轉成 `expired` 並把庫存放回去。

D1 **沒有互動式交易**，所以防超賣靠的是條件式更新與它的影響列數：

```sql
UPDATE product_variants SET stock = stock - ?2 WHERE id = ?1 AND stock >= ?2
```

檢查寫在 `WHERE` 裡，所以兩個請求搶最後一件時，不可能兩邊都讀到「剩 1」然後都成功——後到的那個 UPDATE match 不到任何列。這是這家店和超賣之間唯一的防線，所以只寫在 `orders.take_stock` 一個地方。

訂單建立途中若有一行賣完，**先前已扣的庫存會被放回去**。少了這一步，某個顧客結帳失敗會安靜地把其他商品從架上拿走。

### 金流還沒串

`POST /api/orders/{id}/fake-payment` 可以把訂單標記成已付款，不經過任何金流。它存在的目的是在 PAYUNi 接上之前先驗證庫存、狀態機與稽核軌跡。

**它預設是關閉的**，只有在部署明確設定 `ALLOW_FAKE_PAYMENT = "1"` 時才存在，其餘情況一律回 404。正式環境永遠不要設定它。

### 幾個刻意的決定

**金額是整數新台幣元。** PAYUNi 的 `TradeAmt` 是整數，台幣零售也沒有小數。多一層換算只會多一個讓四捨五入出錯的地方。

**價格驗證拒絕型別不對的值，而不是轉型。** `int("0300")` 和 `int(300.7)` 都會成功，而兩者都代表某個人即將被收取一個沒有人輸入過的金額。價格上限 20,000 對齊 PAYUNi 的單筆上限，所以單一品項不可能自己超過閘道能接受的範圍；下限是 1 而不是 0，免費品項不是這家店在賣的東西。

**庫存數字不完整公開。** 剩 5 件以下才顯示確切數量，其餘只回「有貨」。「剩 2 件」在結帳頁有用，但把完整庫存公開等於讓任何人靠輪詢算出銷量。這條規則在 `shop.public_variant`。

**商品照片的 key 從資料表查，不從網址組。** `/shop-assets/{file}` 會先在 `product_images` 找到對應的列才去 R2 取物件，所以一個舊連結沒辦法拿來探測 bucket 裡還有什麼。R2 前綴是 `_shop/`，底線讓它落在 `IDENTIFIER_PATTERN` 之外，因此永遠不會被當成 ibon 資料夾，`/images/` 也搆不到。

**沒有用 D1 的 `batch` API。** 這個 codebase 還沒有從 Python 呼叫過它，而一串 prepared statement 要跨進 JavaScript 才到得了那裡。排序寫到一半是外觀問題，下次儲存就會自己修正；在寫入目錄的路徑上賭一個沒驗證過的綁定不值得。真正需要原子性的是之後的庫存扣減，那時會用實際部署驗證過再用。

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
