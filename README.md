# Luma Studio ibon 列印

從 R2 讀取指定資料夾的圖片，走 ibon 一般網頁上傳流程，將取件編號快取 24 小時於 D1，並提供公開取件頁與受 Google OAuth 保護的圖檔管理介面。

本專案不使用 ibon 僅供企業客戶使用的 Open API。

公開端與管理端是各自獨立的部署：

| 部署 | 內容 | 網址 |
| --- | --- | --- |
| `luma-studio-web-api` | Cloudflare Python Worker，公開 JSON API 與圖檔 | `https://api.luma-studio.tw` |
| `luma-studio-admin-api` | Cloudflare Python Worker，管理 API | `https://admin-api.luma-studio.tw` |
| `luma-studio-web` | Vite + Preact 靜態站台，公開取件頁與 bio link | `https://luma-studio.tw` |
| `luma-studio-admin` | Vite + Preact 靜態站台，管理介面 | `https://admin.luma-studio.tw` |

兩個 Worker 共用 `backend/src/` 的程式碼，只是進入點不同（[main.py](backend/src/main.py) 與 [admin_main.py](backend/src/admin_main.py)），設定檔分別是 [wrangler.toml](backend/wrangler.toml) 與 [wrangler.admin.toml](backend/wrangler.admin.toml)。

拆開的理由是 cookie 隔離。兩邊的 session cookie 都沒有設 `Domain`，所以是 host-only —— 管理者的 session 只會被送到 `admin-api.luma-studio.tw`，公開站台上的任何腳本都碰不到它。四個網域仍同屬 `luma-studio.tw`，因此 `SameSite=Lax` 不受影響。

管理 Worker 是**唯一會套用 D1 migration 的部署**。公開 Worker 只讀取 `schema_migrations` 回報狀態，不修改 schema：結帳是熱路徑，不該為 schema 檢查付出冷啟動成本，而公開得到的 Worker 也沒有理由具備 `ALTER TABLE` 的能力。因此部署順序固定為管理端先、公開端後。

管理介面搬到 `admin.luma-studio.tw` 之後，前台 Worker 會把舊的 `/admin` 與 `/admin/bio-link` 等舊路徑以 301 永久轉向新網址（去掉 `/admin` 這一段，因為新主機上每一頁都是管理頁）。搬遷期間公開 Worker 上曾有一層 `/api/admin/*` 轉接，現已移除——那些路徑在公開 Worker 上回 404 而不是 401，因為 401 代表處理器還接著，只差一道 session 檢查。

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
    rate_limit.py     以 D1 計數的節流，登入與結帳都走這裡
    auth_core.py      session cookie 的簽章與驗證，兩種身分共用
    auth_admin.py     Google OAuth 與管理者 session
    auth_customer.py  顧客的 Google 登入與 session
    admin_api.py      圖檔與列印設定管理
    ibon.py           ibon 上傳流程、D1 快取、列印規格
    bio_link.py       Bio link 的設定、連結、匿名點擊記錄
    bio_link_api.py   管理端 /api/bio-link* 端點
    ics.py            名片頁行事曆訂閱的 .ics 產生
    shop.py           商品、規格、庫存與照片
    categories.py     商品分類與 AND/OR 篩選
    cart.py           購物車：內容、上限與庫存檢查
    shipping.py       運送方式與運費級距
    orders.py         訂單本身：建立、狀態、稽核記錄
    paging.py         page/perPage 的解讀、LIMIT/OFFSET 與回應外層
    pages.py          自訂頁面與區塊、分享資訊、一次性預覽 token、草稿與發行版
    block_data.py     區塊設定的驗證與正規化，頁面與預覽共用
    pages_admin_api.py 管理端頁面端點
    site_chrome.py    頁首頁尾設定與三層選單
    site_admin_api.py 管理端外框端點
    media.py          媒體庫：上傳的圖片、標題、標籤與誰在用它
    media_admin_api.py 管理端媒體端點
    orders_admin_api.py 管理端訂單端點
    customers.py      會員名單、封鎖與個資清除
    mail.py           通知信樣板、佇列與寄送
    customers_admin_api.py 管理端會員端點
    shop_admin_api.py 管理端商品端點
    dashboard.py      後台首頁的四個數字：待出貨、待付款、近 30 天收款、低庫存
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
    storefront.ts     供應前台 SPA、為分享出去的頁面注入預覽標籤、轉走舊的 /admin
    admin.ts          供應後台 SPA
    legacy.ts         只做一件事：把發出去的 workers.dev 舊網址轉到正式網域
  public/assets/      logo 與教學圖
  src/
    shared/           兩邊共用：api、types、markdown、money、dates、srcset、
                      區塊元件、SiteChrome、SocialIcon、base.css
    storefront/       main、app、PrintPage、BioLinkPage、商城、訂單、自訂頁、預覽頁
    admin/            main、app、ibon、名片頁、商城、運費、頁面編輯器、外框、
                      媒體庫、儀表板
      components/ui/  後台自己的元件庫，見下方「後台的設計系統」
      styles/tokens.css 顏色、間距、圓角，深淺兩套共用一組名字
      lib/            不碰 DOM 的小工具：storage、theme、latest、slug、
                      mediaFacts、mediaResize、blockClipboard、menu-tree、printSpec
design/               logo 原始檔，非公開路徑
scripts/              本機診斷與 R2 同步腳本
docs/superpowers/specs/  設計文件
.github/workflows/    main branch 自動部署
```

`src/` 底下只有三個目錄，規則很簡單：東西放在**用到它的那一邊**，兩邊都用到才進 `shared/`。
方向是單向的：`shared/` 不可以 import `admin/` 或 `storefront/`，否則前台的 bundle 會被
後台的程式碼拖進去。

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
| GET | `/api/site` | 頁首頁尾設定與選單，一次取回 |
| GET | `/site-assets/{file}` | 頁首背景圖 |
| GET | `/media-assets/{file}` | 媒體庫圖片，key 必須在 `media` 表裡 |
| GET | `/api/pages/home` | 目前設為首頁的那一頁，沒有就 404 |
| GET | `/api/pages?path=/about` | 依路徑取頁面與其區塊，只有 `published` 解得開 |
| GET | `/api/pages/preview/{token}` | 兌換一次性預覽票，草稿也看得到；用過即失效 |
| GET | `/api/categories` | 分類清單，含上架商品數量 |
| GET | `/api/categories/{slugs}` | 分類頁。`a,b` 是任一、`a+b` 是兩者皆是 |
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
| GET | `/api/dashboard` | 後台首頁的四個數字、低庫存規格與最近編輯過的頁面 |
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
| GET / POST | `/api/categories` | 分類列表與新增 |
| PUT | `/api/categories/order` | 排序，必須排在 `{id}` 路由之前 |
| PUT / DELETE | `/api/categories/{id}` | 單一分類 |
| GET / POST | `/api/pages` | 頁面列表與新增 |
| PUT | `/api/pages/order` | 排序，必須排在 `{id}` 路由之前 |
| GET / PUT / DELETE | `/api/pages/{id}` | 單一頁面與其區塊、發布狀態與發布紀錄 |
| POST | `/api/pages/{id}/preview-token` | 換一張一次性預覽票，見「真實預覽（iframe）」 |
| POST | `/api/pages/{id}/publish` | 把草稿存成新的發行版並上線。沒有區塊時 409 |
| POST | `/api/pages/{id}/unpublish` | 從網站上撤下，發布紀錄保留 |
| GET | `/api/pages/{id}/versions/{vid}` | 這一版點名的商品與圖片有哪些已經不在 |
| POST | `/api/pages/{id}/versions/{vid}` | 還原到這一版——寫進草稿，不會直接上線 |
| POST | `/api/pages/{id}/blocks` | 新增區塊 |
| PUT | `/api/pages/{id}/blocks/order` | 區塊排序 |
| PUT / DELETE | `/api/blocks/{id}` | 單一區塊 |
| GET / PUT | `/api/site` | 頁首頁尾設定 |
| POST / DELETE | `/api/site/header-image` | 頁首背景圖 |
| GET / POST | `/api/menu` | 選單項目 |
| PUT | `/api/menu/order` | 排序與改層級，必須排在 `{id}` 之前 |
| PUT / DELETE | `/api/menu/{id}` | 單一項目 |
| GET / POST | `/api/media` | 媒體庫清單（`?q=` 搜尋、`?page=` 分頁）與上傳（原圖 + 瀏覽器產生的縮圖） |
| GET | `/api/media/tags` | 現有標籤，給自動完成 |
| GET | `/api/media/usage?ids=` | 一次問多張圖被哪些頁面使用 |
| GET | `/api/media/{id}` | 單張圖與使用它的頁面 |
| PUT | `/api/media/{id}` | 改標題、替代文字與標籤 |
| DELETE | `/api/media/{id}` | 刪除。還被使用時回 409，加 `?force=1` 才真的刪 |
| POST | `/api/media/delete` | 批次刪除，規則同上 |
| GET | `/api/orders?status=&q=&page=&perPage=` | 訂單列表與各狀態筆數，分頁 |
| GET | `/api/orders/{id}` | 單筆訂單、品項、付款嘗試與稽核紀錄 |
| POST | `/api/orders/{id}/paid` | 手動標記已付款（匯款先到時用） |
| POST | `/api/orders/{id}/shipped`、`/completed` | 往前一步，不能跳過也不能倒退 |
| POST | `/api/orders/{id}/cancel` | 取消並退回庫存 |
| POST | `/api/orders/{id}/note` | 店家備註，顧客看不到 |
| GET | `/api/customers?q=&page=&perPage=` | 會員列表，含訂單數與已付金額，分頁 |
| GET | `/api/customers/{id}` | 單一會員與他的訂單 |
| POST | `/api/customers/{id}/blocked` | 封鎖／解除封鎖結帳 |
| POST | `/api/customers/{id}/anonymise` | 清除個人資料，保留訂單 |

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

匯出清單在 workflow 的 `TABLES`：bio link 三張、`folder_print_settings`、商城的 `products`／`product_variants`／`product_images`／`shipping_methods`／`product_categories`／`product_category_links`、自訂頁的 `pages`／`page_blocks`，以及交易相關的 `customers`／`orders`／`order_items`／`payment_attempts`／`order_audit_log`。刻意排除的是：

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

**公開路徑**：確認 `/`、`/admin`、`/card`、`/ibon_print/{id}`、`/api/health`、`/api/bio-link` 都回 200，而且 `/card` 帶著分享預覽標籤。`/admin` 曾經因為前端 Worker 的一行錯誤而 307 導回首頁，這類檢查就是為了讓那種問題自己現形。

建立 `zz_canary` 資料夾時放一張小圖即可。它會出現在 admin 的資料夾清單裡（底線開頭的 id 無法通過 `IDENTIFIER_PATTERN`，所以不能藏起來），排在最後。

**這會每天在 ibon 產生一組真實的取件編號。** 量很小，但那是真的在使用 ibon 的服務。

### D1 migration

schema 定義在 [backend/src/migrations.py](backend/src/migrations.py)，由**管理 Worker** 在每個 isolate 首次收到請求時自動套用，並以 `schema_migrations` 表記錄。所有敘述都必須可重複執行，因為多個 isolate 會同時啟動。手動執行 `wrangler d1 execute` 已不再需要。

公開 Worker 不套用任何 migration，`/api/health` 只讀取 `schema_migrations` 回報現況。因此部署順序是管理端先、公開端後；公開端回報的清單短少，代表部署順序出了問題，該被看見而不是被隨手修掉。

migration 除了現有的字串檢查，另外會**用真正的 SQLite 引擎重跑一次**（[backend/tests/test_migrations_sqlite.py](backend/tests/test_migrations_sqlite.py)）。
只檢查 SQL 字串長得對不對，連「這句話資料庫肯不肯收」都測不出來，也測不出一個
parse 得過但其實什麼都沒約束的索引。D1 就是 SQLite，所以這是可用的替身 ——
但它不是 D1 本身，證明不了線上資料庫目前裝著什麼。

### 功能開關

課程相關功能由環境變數控制，**沒設定就是關閉**，而且**只有 `"1"` 算開啟**：

| 變數 | 控制什麼 |
| --- | --- |
| `COURSE_CATALOG_ENABLED` | 課程在商城的曝光 |
| `COURSE_CHECKOUT_ENABLED` | 含課程的商品能不能結帳 |
| `COURSE_LEARNING_ENABLED` | 會員課程中心 |
| `VIDEO_UPLOAD_ENABLED` | 影片的 presign、上傳與註冊 |

旗標讀在伺服器（[backend/src/shared/flags.py](backend/src/shared/flags.py)）。前端可以用它決定畫不畫按鈕，
但擋下請求的是後端 —— 藏起按鈕從來沒有阻止過任何人直接呼叫底下那支 API。

`/api/health/reconciliation`（管理端，需登入）會回報目前所有旗標狀態，
以及「該發生卻沒發生」的事：付了款沒開通的訂單、逾期還佔著庫存的訂單、卡住的轉檔、
所有來源都撤銷了但權限還在的會員、以及孤兒購買鎖。**它只回報，不修復** ——
修復留給本來就知道怎麼修的程式碼，同一個修復寫兩遍就會有兩種行為。

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
| `luma-studio-web-api` | `api.luma-studio.tw` |
| `luma-studio-admin-api` | `admin-api.luma-studio.tw` |

DNS 記錄與憑證由 Cloudflare 自動建立。**綁定前不要手動加 A/CNAME**，已存在的記錄會讓綁定失敗。

### 從 `luma-studio` 改名到 `luma-studio-web-api`

**改 `wrangler.toml` 的 `name` 不會改名，會長出第二個 Worker。** 舊的那個還在，而且 `api.luma-studio.tw` 還綁在它身上。所以順序不能顛倒：

1. **先 push**。deploy 會建立 `luma-studio-web-api`——沒有 secrets、沒有網域。此時線上完全不受影響，客人還是走舊的那個。
2. **設 secrets**（secret 不會跟著搬）：`GOOGLE_CUSTOMER_CLIENT_ID`、`GOOGLE_CUSTOMER_CLIENT_SECRET`、`GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI`、`VISITOR_SALT`、`RESEND_API_KEY`。

   `VISITOR_SALT` **一定要用原本那一組**。換了，bio link 的訪客雜湊就變了，同一個人會被算成新訪客——而且不會有任何錯誤訊息，統計只是從那天起悄悄失真。
3. **搬網域**：舊 Worker → Settings → Domains & Routes 移除 `api.luma-studio.tw`，然後在新 Worker 加回去。一個 Custom Domain 同時只能綁一個 Worker，所以中間會有幾十秒打不開。挑沒人的時間做。
4. **驗證**：`https://api.luma-studio.tw/api/health` 回得出 migration 清單就對了。順手開一次前台跟結帳。
5. **把舊的 `luma-studio` 換成跳轉 Worker**（見上一節），不要刪掉它——那個名字撐著已經發出去的 workers.dev 網址。這一步不是收尾，是必要的：舊的那個身上還有 `crons = ["*/5 * * * *"]`，不換掉就會有兩個 Worker 同時掃逾期訂單、同時排空信件佇列。跳轉 Worker 沒有 cron，蓋上去等於把排程拿掉。

Google OAuth 那邊**不用動**。redirect URI 綁的是網域不是 Worker 名字，`https://api.luma-studio.tw/auth/callback` 從頭到尾沒變。D1、R2 與速率限制的 binding 都寫在 `wrangler.toml` 裡，跟著部署走。

### 已經發出去的 workers.dev 網址

`https://luma-studio.infixman.workers.dev/ibon_print/20260721_soda` 印出去過。

**workers.dev 的主機名就是 Worker 的名字**，所以那個網址只在有一個叫 `luma-studio` 的 Worker 時才存在。改名之後如果把舊的刪掉，那條連結就永遠救不回來——`luma-studio-web-api.infixman.workers.dev` 是另一個網址。

所以 `luma-studio` 這個名字留著，但裡面換成一個只會跳轉的小 Worker（[frontend/worker/legacy.ts](frontend/worker/legacy.ts)、[frontend/wrangler.legacy.jsonc](frontend/wrangler.legacy.jsonc)）。它沒有 D1、沒有 R2、沒有 secrets，**也沒有 cron**——兩個 Worker 共用同一個排程會讓逾期訂單被掃兩次、信件佇列被排空兩次。

只有 `/ibon_print/{id}` 會帶著路徑過去，其他一律送到首頁：舊主機是 API，它的其他路徑在網站上意義不同，照著轉會落在一個看起來像我們壞掉的 404。

用 302 不用 301。這是**臨時**的——等到沒有人手上還拿著印了舊網址的紙就可以撤掉——而 301 會被瀏覽器快取到你改變主意也沒用。

⚠️ **`api.luma-studio.tw` 搬到 `luma-studio-web-api` 之前不要部署它。** 用這個名字部署會蓋掉目前叫 `luma-studio` 的東西，而在網域搬走之前，那就是線上的公開 API。

```powershell
cd frontend
npx wrangler deploy -c wrangler.legacy.jsonc
```

刻意沒有放進 CI，就是為了不讓它在搬移完成前被自動部署出去。搬完之後要不要加進 `deploy.yml` 隨你——它幾乎不會再改。

### Worker secrets

只有後端 Worker 需要。用指令設定，不要寫進 `wrangler.toml` 的 `[vars]`——那份設定會進版控。

**secret 是 per-Worker 的**，而且兩個 Worker 需要的**不一樣**。

| Worker | Secret | 內容 |
| --- | --- | --- |
| `luma-studio-web-api` | `GOOGLE_CUSTOMER_CLIENT_ID` | 顧客那組 OAuth client |
| `luma-studio-web-api` | `GOOGLE_CUSTOMER_CLIENT_SECRET` | 同上 |
| `luma-studio-web-api` | `GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI` | `https://api.luma-studio.tw/auth/callback` |
| `luma-studio-web-api` | `VISITOR_SALT` | 任意隨機字串，雜湊 bio link 訪客識別 |
| `luma-studio-admin-api` | `GOOGLE_CLIENT_ID` | 店主那組 OAuth client |
| `luma-studio-admin-api` | `GOOGLE_CLIENT_SECRET` | 同上 |
| `luma-studio-admin-api` | `GOOGLE_OAUTH_REDIRECT_URI` | `https://admin-api.luma-studio.tw/auth/callback` |
| `luma-studio-web-api` | `RESEND_API_KEY` | 寄信用。**只有公開 Worker 需要**——排空信件佇列的排程在那邊 |

沒有設 `RESEND_API_KEY` 或 `MAIL_FROM` 時整套通知信是關的：不會排入、不會寄出，也不會累積一堆之後突然全部寄出去的舊信。

`MAIL_FROM` 與 `MAIL_OWNER` 不是 secret（不是憑證），寫在兩個 Worker 的 `[vars]` 裡：

```toml
MAIL_FROM = "苒光繪誌 <shop@luma-studio.tw>"   # 網域要先在 Resend 驗證過
MAIL_OWNER = "你的信箱"                        # 收「有新訂單」的通知
```

管理 Worker 也要 `MAIL_FROM`——它會排入「已出貨」這類信，而 `MAIL_FROM` 是那個開關。它不需要 `RESEND_API_KEY`，因為它不負責寄。

```powershell
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_CLIENT_ID
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_CLIENT_SECRET
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI
uv --directory backend run pywrangler secret put VISITOR_SALT

# 課程播放授權的簽章金鑰。沒有它，播放 session 端點會回 503 而不是發出
# 一張沒有簽章的 token。輪替時把舊值放進 PLAYBACK_SECRET_PREVIOUS，
# 驗證會同時接受兩把、簽發只用新的那把，正在上課的人不會被踢出去。
uv --directory backend run pywrangler secret put PLAYBACK_SECRET
uv --directory backend run pywrangler secret put PLAYBACK_SECRET_PREVIOUS

uv --directory backend run pywrangler secret put GOOGLE_CLIENT_ID -c wrangler.admin.toml
uv --directory backend run pywrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.admin.toml
uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI -c wrangler.admin.toml

# R2 的 S3 API 金鑰，用來簽出上傳影片的短效 URL。只有管理 Worker 有它 ——
# 公開 Worker 不簽任何東西，桌面工具拿到的是簽好的 URL 而不是金鑰。
# 缺它的時候 presign 會回 503，而不是發出一張到了 R2 才失敗的 URL。
uv --directory backend run pywrangler secret put R2_ACCESS_KEY_ID -c wrangler.admin.toml
uv --directory backend run pywrangler secret put R2_SECRET_ACCESS_KEY -c wrangler.admin.toml

# 桌面工具配對碼的來源。每個管理者的 TOTP seed 是這個值和他的 email 導出的，
# 所以**沒有任何 seed 存在資料庫裡** —— 不用遷移、不用「只顯示一次」、
# D1 被 dump 也拿不到東西。換掉這個值就等於一次撤銷所有已配對的機器。
uv --directory backend run pywrangler secret put DESKTOP_PAIRING_SECRET -c wrangler.admin.toml

# 桌面工具 token 的簽章金鑰。跟配對碼分開，因為兩者的壽命和撤銷方式不同：
# 換配對 secret 只是讓新的配對要重做，換這一把是立刻讓所有已發出的 token 失效。
uv --directory backend run pywrangler secret put DESKTOP_TOKEN_SECRET -c wrangler.admin.toml
```

`wrangler.admin.toml` 裡的 `R2_S3_ENDPOINT` 要填成
`https://<account-id>.r2.cloudflarestorage.com`。它不是秘密（每張簽好的 URL 裡都有），
但是帳號專屬的，所以放設定而不是程式。留空的話 presign 一律 503。

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

**`/` 是總覽，不是 ibon 列印**（ibon 移到 `/ibon`）。後台開起來第一眼該回答的是「今天有什麼事等我」——已付款還沒出貨幾筆、什麼快賣完、近三十天收了多少、上次在改哪一頁。ibon 是工具，工具不是首頁。

總覽的每個數字都是資料庫自己算的（[dashboard.py](backend/src/dashboard.py)），不是把資料列讀進 Python 再加總：這一頁開的次數最多，不能隨著生意變好而變慢。

兩個容易搞混的定義寫在測試裡：**營收從 `paid_at` 算不是 `created_at`**（三月下單、四月付款算四月的錢），**庫存警示的門檻不是零**（等到零的時候才補已經來不及了）。

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

# 課程播放授權的簽章金鑰。沒有它，播放 session 端點會回 503 而不是發出
# 一張沒有簽章的 token。輪替時把舊值放進 PLAYBACK_SECRET_PREVIOUS，
# 驗證會同時接受兩把、簽發只用新的那把，正在上課的人不會被踢出去。
uv --directory backend run pywrangler secret put PLAYBACK_SECRET
uv --directory backend run pywrangler secret put PLAYBACK_SECRET_PREVIOUS
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

## 後台的設計系統

後台原本是原生 HTML 元素加上散在各頁的樣式：每個列表自己排版、每個對話框是 `confirm()`、
每個下拉是 `<select>`。改成一組共用元件，參考的是 Strapi 的排版與 Payload 的編輯體驗——
抄的是 UI/UX，不是功能。

### 顏色與間距

[styles/tokens.css](frontend/src/admin/styles/tokens.css) 是唯一的來源。名字說的是**用途**不是長相
（`--surface` 換了配色還活著，`--grey-100` 換配色那天要全站改名）。

間距、圓角、排版比例抄 Strapi，**顏色不抄**。原本連配色一起抄了（靛藍 `#4945ff`、頁面
`#181826`），結果就是長得跟每一個自動產生的後台一樣，而且跟它服務的那間工作室毫無關係。

現在是暖灰，取自前台自己的墨色，主色是**近黑的暖墨色不是彩色**——填色按鈕、目前頁面、選取
狀態都是「紙上的墨」。這樣畫面上唯一有飽和度的東西就剩下 danger / warning / success / info
四種狀態色，紅色徽章才會真的有意義，因為旁邊沒有藍色側欄和紫色按鈕在跟它搶。

深淺兩套共用同一組名字：

```text
:root                        淺色，也是預設
prefers-color-scheme: dark   系統偏好，僅在沒有 data-theme 時生效
[data-theme="dark"|"light"]  店主自己選的，蓋過系統
```

系統那條被 `:not([data-theme])` 擋著。少了這個保護，系統設深色時會贏過店主剛選的淺色，
切換鈕就只有單向有效。三態不是兩態：「跟隨系統」是真的選項，也是沒碰過切換鈕的人的現況。
存取在 [lib/theme.ts](frontend/src/admin/lib/theme.ts)，在 render 之前就套用，否則會先閃一下淺色。

顏色對比全部量過，AA 以上。`--on-danger` / `--on-success` / `--on-warning` 這幾個存在的原因是
深色主題的紅綠橘都比較亮，白字踩在上面只有 2.6～3.3:1。

深色主題的主色是**反過來的**：淺色是紙上的墨，深色就是墨上的紙（`--primary: #e9e3da`）。但
`--primary-text` 不能跟著——近白的「連結」跟內文分不出來——所以那是唯一一處讓工作室自己的
赭色透出來的地方。

### 一條寫在 admin.css 裡的規則

「還沒搬到元件庫的裸控制項」那一段全部包在 `:where()` 裡，這是承重的。寫成
`body.admin button` 是 (0,1,2)，而任何用單一 class 描述自己的元件是 (0,1,0)——所以那條規則
會贏過 `.ui-icon-button`、`.picker-tile`、`.nav-group`。後台每一個 ghost 圖示按鈕都變成實心
方塊：拖曳把手、`⋯` 選單、網址鎖、複製、開啟，全部。

一個一個把元件的權重拉高這招已經做過兩次，下次再冒出一條 blanket rule 就要做第三次。降到
(0,0,0) 之後順序永久反轉：說得出自己長什麼樣的元件一定贏，什麼都沒寫的裸 `<button>` 還是有
一個合理的預設。

### 元件

`import { ... } from '../components/ui'` 一次拿到全部，樣式也是在那支 barrel 裡引入的。

| 元件 | 用途 |
| --- | --- |
| `Button` / `IconButton` / `ButtonRow` | 四種 tone：primary、neutral、ghost、danger |
| `Field` / `TextField` / `TextArea` | 標籤、說明、錯誤訊息的固定排法 |
| `Select` | 自繪下拉。方向鍵、Home/End、輸入字首跳選、Enter 選定、Escape 還原 |
| `Choice`：`Checkbox` / `RadioGroup` / `Toggle` | |
| `TagInput` | 媒體庫的標籤，含既有標籤的自動完成 |
| `Modal` / `useConfirm` | 對話框與 `await ask({...})`；焦點進得去、出不來、關掉會還回去 |
| `Bits`：`Panel` / `Badge` / `EmptyState` / `Spinner` / `TableWrap` / `Truncated` | |
| `DataTable` / `Toolbar` / `BulkBar` | 列表、工具列與「已選 N 筆」的批次列 |
| `ColumnChooser` | 顯示哪些欄，選擇記在 localStorage |
| `FilterBar` | 疊加式篩選規則，AND 相接 |
| `Menu` / `MenuItem` / `MenuGroup` | 區塊列尾端的 `⋯` |

不碰 DOM 的部分（[columns.ts](frontend/src/admin/components/ui/columns.ts)、
[filters.ts](frontend/src/admin/components/ui/filters.ts)）獨立成模組，所以測得到。

### 排版

一欄 248px 的選單，加上會跟著捲動的標題列。[AdminShell](frontend/src/admin/components/AdminShell.tsx)
把兩者包起來，每一頁只交出內容與標題列上的按鈕。

選單是風琴摺疊的：

```text
官網    頁面 / 頁首頁尾 / 媒體庫
商城    訂單 / 商品 / 運費
會員    （沒有子項，本身就是連結）
工具    ibon / 名片
```

原本是兩欄——一排圖示，加上目前那一組的頁面清單。兩欄花 288px 顯示四個字，而且不在目前那一組
的頁面不只是收起來，是根本看不到：你沒辦法在不先猜「運費在購物車後面」的情況下知道它存在。

摺疊狀態記在 localStorage，但目前所在的那一組一定會展開——側欄上什麼都沒標記的話，它就沒在
告訴你人在哪裡，而那是側欄大部分的用途。

每一列都有 icon，子項也有。只有群組標題有而子項沒有，讀起來像兩種清單疊在一起。icon 是字符
不是「框裡裝東西」：一整排同樣大小的圓角矩形讀起來是同一個形狀重複，真正用來分辨的東西被留在
18px 裡做苦工。

### 幾條規則

- **CSS 選擇器要指明是誰。** `.cart`、`.custom-page`、`body.admin li` 這三次都出過事：
  為某一頁寫的樣式，套到了每一個穿著那個 class 的東西上。容器一律寫成 `main.x` 這種形式。
- **localStorage 的 key 只有一種取法**，[lib/storage.ts](frontend/src/admin/lib/storage.ts) 的
  `key()`。同一天長出三種命名法就是第四種出現的原因。
- **長清單一律分頁**，後端 [paging.py](backend/src/paging.py)、前端
  [ui/Pagination.tsx](frontend/src/admin/components/ui/Pagination.tsx)。訂單、會員與媒體庫
  以前是「只給最新的 200 筆，還有更多喔」——那不是清單，是一個「其餘的存在於你到不了的地方」
  的承諾。總數來自真正的 `COUNT(*)`，不是「這次回了幾筆」。
- **會被覆蓋的請求要記票號**，[lib/latest.ts](frontend/src/admin/lib/latest.ts) 的 `useLatest()`。
  搜尋框輸入很快時，先發的慢答案會蓋在後發的快答案上面。

## 商城

設計文件在 [docs/superpowers/specs/2026-07-28-shopping-cart-design.md](docs/superpowers/specs/2026-07-28-shopping-cart-design.md)。
目錄、購物車、結帳、訂單與履約都已完成；正式金流閘道尚未接上，付款目前只有管理員手動標記與開發用的假付款。

商城同時賣實體商品與線上課程，兩者走同一條購物車與結帳流程 —— 見下方「線上課程」。

| 位置 | 網址 |
| --- | --- |
| 商品列表 | `luma-studio.tw/shop` |
| 單一商品 | `luma-studio.tw/shop/{slug}` |
| 分類頁 | `luma-studio.tw/shop/c/{slugs}` |
| 購物車 | `luma-studio.tw/cart` |
| 結帳 | `luma-studio.tw/checkout` |
| 我的訂單 | `luma-studio.tw/orders` |
| 我的課程 | `luma-studio.tw/account/courses` |
| 課程學習頁 | `luma-studio.tw/learn/{slug}` |
| 商品管理 | `admin.luma-studio.tw/products` |
| 庫存品 | `admin.luma-studio.tw/inventory` |
| 線上課程 | `admin.luma-studio.tw/courses` |
| 運費設定 | `admin.luma-studio.tw/shipping` |

後台可以新增商品、編輯售價與庫存、上傳照片、切換上架狀態，以及設定每種配送方式的運費與免運門檻。

前台**只看得到 `active` 的商品**。草稿即使有人猜中 slug 也解不開，已下架的則會停止販售——兩者都回 404，因為對顧客而言那就是同一件事。

### 草稿、發行版、發行版歷史

一頁有兩份內容。`pages` + `page_blocks` 是**草稿**，也就是後台正在編輯的東西；顧客讀到的是
`page_versions` 裡 `is_current = 1` 那一列的快照。按下發布才會把草稿序列化成一列快照。

改一個已經上線的頁面，因此不再是顧客即時看著發生的事。

狀態有三種，第三種是這套東西出現之前完全看不出來的：

| 狀態 | 意思 |
| --- | --- |
| 草稿 | 從來沒發布過，`page_versions` 裡沒有它的列 |
| 已發布 | 草稿與現行版本一致 |
| 有未發布的修改 | 兩者不一致——改完沒發布，以前畫面上沒有任何地方會講 |

編輯頁比對的是內容本身。頁面列表比的是 `updated_at` 與 `published_at` 兩個時間戳——二十列
的清單要精確答案就得讀每一頁的每個區塊。兩者只會在一個方向上不同調（改了又手動改回去，
列表會說「有未發布的修改」而編輯頁說「已發布」），而那是對徽章來說安全的那一邊。

**快照存的是區塊的 `type` 與 `config`，不是 hydrate 過的回應。** 後者會把當下的價格與庫存
一起冰進版本裡，而版本記錄的是版面，不是商品狀態。也不存 block id：還原寫的是新的列。

**還原是還原到草稿，不是直接上線。** 你會想先看一眼，而且第二條上線路徑就是第二個會出錯的
地方——已經存在的發布按鈕負責收尾。還原前會先問伺服器這一版點名的東西有多少已經不在，
對話框直接講出來：平常少一張圖只是內容變了，但還原是刻意翻舊帳，安靜地少一件商品會被
當成還原失敗。

**歷史留最近 20 份，不是無限。** 每次發布寫一整頁的 JSON，沒有上限就是無限成長。目前這一版
永遠不會被清掉，不管它多舊——清掉它等於這一頁沒東西可以給顧客。

預覽 token 讀的是**草稿**，那正是預覽的意義：已發布的那一份在頁面自己的網址就看得到。

**不做自動存草稿。** 一次編輯產生幾百個版本，要找回昨天的樣子反而更難。

### 自訂頁面

後台可以建頁面、設定路徑，並由多個區塊組成。公開與否由上面的發布流程決定。目前有六種區塊：

| 區塊 | 內容 |
| --- | --- |
| 純文字 | Markdown，適合條款與說明 |
| 輪播圖 | 一次一張，每張可以有圖說與連結 |
| 相簿 | 格狀排列，2／3／4 欄，點開看原圖 |
| 商城 | 指定商品（照你排的順序）或整個分類。版面可選**格線**或**精選**（一大兩小，放大的是清單第一件） |
| 介紹 | 照片＋文字＋連結，關於我／聯絡我 |
| 聯絡 | 聯絡方式在一側、圖片或一段話在另一側。**沒有表單**——CSP 是 `form-action 'none'`，也沒有接收端點，那是另一件事 |

商城的精選版面可以把商品名與價格疊在圖上，**預設關閉**。示範用的是純黑太空底圖，字放上去乾淨；這裡賣的是滿版構圖的插畫，蓋上去很可能正好壓到重點。開啟時字固定在左上角並加背景模糊。

加一種區塊要動四個地方：`pages.py` 的驗證器、`Blocks.tsx` 的一個 case、`BlockEditors.tsx` 的一個編輯器，以及 `PageEditPage.tsx`——那裡有一個 per-type 的編輯器條件式**和**一個 per-type 的預覽 case。第四處是可以消掉的（把條件式換成 dispatcher、把預覽搬進 `BlockEditors.tsx`），還沒做。

| 位置 | |
| --- | --- |
| 頁面清單 | `admin.luma-studio.tw/pages` |
| 頁面編輯器 | `admin.luma-studio.tw/pages/{id}` |
| 前台 | 頁面設定的路徑，例如 `luma-studio.tw/about` |

**首頁由「設為首頁」旗標接管**，不是把路徑填成 `/`。只有一頁能是首頁，由部分唯一索引（`WHERE is_home = 1`）在資料庫層保證。前台沒有另一份寫死的首頁：沒有任何一頁勾首頁時，`/` 只會說首頁還沒建立，並給一條去商城的路。頁面系統剛上線時曾有一個內建歡迎頁接在後面，留著等於前門有兩個可以編輯的地方，而只有一個地方會有人想到要去看。

**保留路徑不能被佔用**：`/shop`、`/cart`、`/checkout`、`/orders`、`/card`、`/ibon_print`、`/admin`、`/api`、`/images`、`/r` 及其子路徑。不擋的話，一個 path 是 `/shop` 的頁面會安靜地蓋掉整個商城。

**草稿在公開端一律 404，沒有例外。** 前台 Worker 認不出店主——管理者的 cookie 是 host-only 綁在 `admin-api`，那是刻意的隔離。所以預覽做在後台裡：區塊的渲染元件放在 `shared/`，編輯器和前台用**同一份**，你在編輯器看到的就是公開後的樣子。考慮過預覽權杖（`?preview=xxx`），沒有採用——那會在公開 API 上多一條會回傳草稿的路徑，而那裡出一次錯就是草稿外流。

**Markdown 在前端轉換**（[shared/markdown.ts](frontend/src/shared/markdown.ts)），**先把整段輸入逃脫，再套用規則**。原始碼裡的 `<script>` 只可能變成文字 `&lt;script&gt;`——安全性來自那個順序，不是來自一份要維護的黑名單。連結只接受 `http`、`https`、`mailto` 與站內路徑；`javascript:` 會被丟掉但保留文字，因為弄丟字比弄丟連結更讓人意外。

**區塊設定存 JSON**，所以驗證做兩次：寫入時擋掉壞的，讀取時擋掉舊版本寫進去的。讀取時解不開的區塊會被跳過而不是拋錯——少一段文字比整頁空白好——但後台仍然看得到它，因為看不到的區塊等於刪不掉。

**`config` 存 id，`data` 存查出來的東西。** 區塊的設定裡是圖片 id、商品 slug、分類條件；把它們變成照片和價格要查資料庫，所以查詢的結果放在 `data`，跟 `config` 並排回傳（[block_data.py](backend/src/block_data.py)）。編輯器原封不動把 `config` 送回來，所以**一張被刪掉的圖只會少一格，不會弄壞整頁**：id 還在設定裡等著被修，渲染時單純少一張。

一頁的所有區塊**共用一次圖片查詢**。五個輪播不會變成五次查詢。

商品是逐個區塊查的：指定商品的區塊照店主排的順序（那正是逐個指定的意義），分類區塊照商城本身的順序（不然就多了第二個地方排同一批商品）。條件字串照原樣存，`,` 是任一、`+` 是兩者皆是——跟分類頁網址同一套文法。條件裡有已刪除的分類時**回空的**，不會安靜地放寬成剩下那些。

**外觀一樣是從固定清單選**：比例（寬／方／直）、每列張數（2／3／4）、照片在左或在右。輪播的自動播放預設關閉，而且後台直接寫出理由——會動的東西會在讀者還在看的時候把頁面帶走。

後台預覽的圖片是用編輯器手上那份媒體庫在本機接起來的，所以剛加的一張立刻看得到；商品不是，價格與庫存在伺服器上，所以商城區塊預覽的是上次儲存的結果。這件事寫在預覽卡上，不是留給人自己發現。

### 分享預覽

**貼到 LINE 或 Facebook 的卡片是前台 Worker 貼上去的，不是 app。** 那些爬蟲不會執行 JavaScript，所以在瀏覽器裡用 JS 設好的 `og:` 標籤，它們一個都看不到。[storefront.ts](frontend/worker/storefront.ts) 在送出 HTML 之前先向公開 API 問一次，把標籤寫進 `<head>`：`/card` 問 bio link、`/` 與自訂頁路徑問頁面、`/shop/{slug}` 問商品。

只有爬蟲會等這一次查詢（`isLinkPreviewer`）。一般訪客的瀏覽器本來就會自己抓內容，讓每個人多等一趟只會延後第一次繪製。

**查不到就照常出頁面，不出卡片。** 少一張預覽卡是可惜，因為 API 慢而打不開的連結是壞掉——後者糟得多，所以每一條路徑上的失敗都當作「沒有預覽」處理，包含回應格式不對的情況。

每一頁可以自己填分享文案與分享圖（`pages.share_description`、`pages.share_image_key`），沒填就用網站的預設卡片。商品不用填：標題用商品名稱、圖用第一張照片，所以一個什麼都沒設定的商品貼出去仍然像它自己。

**存的是媒體物件的 key，不是媒體 id。** 每一次爬取都要一個網址，而 key 離網址只差一個前綴。編輯器手上只有網址，所以儲存時不提 `shareImageId` 就代表「沒有動過」——否則改個標題就會把分享圖洗掉。

### 真實預覽（iframe）

後台會用區塊的同一份元件畫預覽，但那是畫在**後台的面板裡**，用的不是前台的樣式與底色。所以編輯器另外提供「看真實畫面」：在 iframe 裡開真的前台，由前台自己渲染。

**預覽頁不穿頁首頁尾**，這是刻意的。它是全站唯一允許被 iframe 的路徑，而允許的理由是「這一頁沒有東西值得被騙著點」——頁首上有購物車、登入連結和店主自訂的行動按鈕，穿上去這個理由就不成立了。所以看到的是「前台怎麼畫這些區塊」，不是「發布後的完整照片」；外框每一頁都一樣，在任何一頁都看得到。判斷寫在 `isBare()`，有測試。

草稿在公開 API 上是 404，所以要交換一張通行證：

| | |
|---|---|
| 發放 | `POST /api/pages/{id}/preview-token`，只在管理主機上，也就是登入閘門後面 |
| 兌換 | 前台 `/__preview/{token}` → `GET /api/pages/preview/{token}` |
| 範圍 | **一頁**、**十分鐘**、**用一次就沒了** |

**用資料表而不是簽章**（`preview_tokens`）。兩個 Worker 本來就共用同一個 D1，所以不需要再發一把共享密鑰，也不用自己寫 HMAC 與常數時間比較——而且簽章做不到的兩件事這裡都要：**可撤銷**、**只能用一次**。兌換時先刪再檢查效期：遲到的請求也是一次使用，留著它等於讓人拿同一張票去賭時鐘。

**framing 的放寬只在 `/__preview/*`，不是全站。** 這是這件事唯一危險的地方：`/*` 維持 `X-Frame-Options: DENY` 與 `frame-ancestors 'none'`，因為 `/cart`、`/checkout`、`/orders` 上有值得騙人點的按鈕。預覽路由本身**只渲染**——沒有購物車、沒有結帳、不讀 session——所以就算被框住也沒有東西可以被騙著點，何況要先有一張一次性通行證才打得開。

`X-Frame-Options` 是**移除**不是放寬：它的允許清單最多只到 `SAMEORIGIN`，講不出「我們另一台主機」，留著還會蓋掉講得出來的 CSP。這條規則由 [vite.config.ts](frontend/vite.config.ts) 產生，測試在 [csp.test.ts](frontend/src/shared/csp.test.ts)。

頁面路徑不可能撞到 `/__preview`：頁面路徑只允許字母、數字與單一連字號，底線根本進不去。

### 站台外框與選單

頁首與頁尾是**站台設定**，不是頁面插入的區塊。每一頁自動套用，`pages` 上有 `show_header` 與 `show_footer` 兩個開關（預設開）給例外情況。

考慮過讓它們成為「可插入的共用頁面」。沒有採用的理由只有一個：**你會忘記插**，而且不是偶爾。忘了插頁尾的那一頁就是客人看到的那一頁。

**外觀是從固定清單選，不是填值** —— 與名片頁同一條規則、同一個理由。背景（透明／純色／圖片）、底色（五色調色盤）、高度與 logo 大小（小／中／大）、文字色（深／淺）。做不到的事講清楚：不能填 hex 色碼、不能把頁首設成 137px。自由填色遲早會做出一個自己看得到、客人看不清楚的選單，而那種錯誤不會在建立當下出現，是在別人的手機上出現。

**頁尾左邊是品牌欄**：logo、一句話介紹（`site_settings.footer_blurb`）、社群連結與版權，右邊才是可編輯的連結欄。社群放在品牌欄不是第六個連結欄——那是店本身的地址，不是站內的頁面。沒有任何連結欄時品牌欄佔滿寬度。

**選單存「指向什麼」而不是完成的網址。** `target_kind` 是 `page` 時存頁面 id，`category` 時存分類 slug，`url` 時才是絕對網址。所以改頁面路徑時選單會跟著走，不用回頭改。

公開回應**不包含**指向草稿頁、已刪除頁面或消失分類的項目 —— 一個通往 404 的選單項目比少一個選單項目糟。但後台看得到它們，因為看不到的項目就是刪不掉的項目。

**三種頁面不穿外框**，理由是兩種不同的：`/checkout` 是因為付款途中的導覽列只提供離開的方法；`/card` 與 `/ibon_print/{id}` 是因為它們本來就不是商店的頁面——一個是單獨發出去的連結，一個是在超商櫃檯用手機打開、只為了讀一組號碼。兩者都已經有自己的 logo，套上站台頁首會變成兩個 logo 疊在一起，還在想列印的人面前擺一個購物車。判斷寫在 `isBare()`（[storefront/app.tsx](frontend/src/storefront/app.tsx)），有測試。

**每一頁可以自己關掉頁首或頁尾**（`pages.show_header` / `show_footer`，預設都開）。用在只想呈現自己內容的落地頁。知道要不要外框的是那一頁，而那一頁是渲染在外框裡面的，所以它是透過 `ChromeControl` 這個 context 往外說一聲，而不是讓外層再抓一次頁面。載入失敗時不會關掉任何東西——沒抓到頁面就照常顯示外框，比讓整個網站看起來壞掉好。離開那一頁時它要求的一切會被還原。

**頁首背景圖的上傳控制項只在背景選「圖片」時出現。** 放在純色旁邊的上傳框，是一個看起來沒有作用的控制項。上傳成功後只把回應裡的 `headerImagePath` 套進畫面——回應帶的是**已儲存**的設定，整包套用會把還沒儲存的修改洗掉，包括讓這個控制項出現的那個「背景：圖片」。

模組叫 `site_chrome.py` 而不是 `site.py`：`site` 是 Python 直譯器啟動時就載入的標準函式庫模組，`import site` 永遠會拿到那一個。

**選單編輯器有兩套操作，不是一套。** 拖拉改上下位置，按鈕改層級（⇤ 升一層、⇥ 降一層），兩者在所有裝置上都在。用拖拉同時做兩件事，就得從像素位置猜對角線的移動是「移過去」還是「變成子項目」，猜錯的代價是使用者只想越過某一項、結果變成它的子項目。按鈕是底線而不是小螢幕的退路：拖拉用鍵盤做不到，也最容易在別人的裝置上行為不同。

選單在編輯器裡是**一條有縮排的扁平清單**，不是巢狀清單。這樣「一個項目」和「它的位置」是同一件事，移動就是陣列的 splice 而不是樹的搬移。算術抽在 `frontend/src/admin/lib/menu-tree.ts`，因為會出錯的是算術，而算術才測得動（`menu-tree.test.ts`）。幾個藏在裡面的規則：移動會**連同子項目一起走**、越過鄰居時是越過它**整棵子樹**（否則會掉進它的子項目中間）、⇥ 檢查的是**整塊的最深層**而不是自己那一層（一個已經有孫項目的項目不能再往下降）。

後台的預覽用的是前台**同一份** `SiteHeader` / `SiteFooter`。預覽卡片裡只覆蓋兩件跟「卡片不是視窗」有關的事：sticky 關掉，以及不要因為卡片寬度觸發手機版而顯示漢堡選單。

### 媒體庫

商品照片屬於商品、頁首背景圖屬於頁首，所以那兩個各自存自己的 R2 key。輪播圖不一樣：同一張照片會同時出現在輪播、相簿和介紹區塊裡，傳三次就等於之後要改三次。

**區塊存的是 media id，不是網址。** id 撐得過檔案之後發生的任何事，而且頁面可以被告知「這張圖不見了」，而不是安靜地畫出一張破圖。

刪除一張還在用的圖**允許，但不會不小心發生**：第一次刪會拿到 409 和「哪些頁面在用」，加上 `?force=1` 才真的刪。完全擋掉的話，一張圖就只能先把每個用到它的頁面都編輯過才刪得掉。

「誰在用」是把每個區塊的 config 讀出來在 JSON 裡找，不是對著 JSON 跑 LIKE：`LIKE '%id%'` 會把「id 剛好是某個更長字串的一部分」也算進去。而且這個找法是照 JSON 的形狀寫的，不是照區塊類型寫的，所以之後新增的區塊類型不用回來這裡補一筆。

公開路由 `/media-assets/{file}` 會先確認這個 key 真的在 `media` 表裡才去讀 R2。同一個 bucket 也放 ibon 的列印檔——網址不是權威。

後台有兩個入口：媒體庫頁（上傳、改替代文字、看誰在用、刪除）與 `MediaPicker`（區塊編輯器裡跳出來選圖，也能當場上傳）。兩者共用同一個 `MediaGrid`——同一批圖，差別只在點下去代表什麼。

**替代文字留白是一個真的答案。** 純裝飾的圖，空的 alt 讓讀螢幕的人跳過它，比讀出「IMG_2831.jpg」好。所以後台在格子上標「沒有替代文字」提醒你想一下，但不會擋著不讓存。

API 回的是 `path`，不是完整網址，前端用 `apiUrl()` 補上 API 主機——與商品照片、名片頁頭像同一條規則。圖片是 API 供應的，不是站台。

**縮圖是在瀏覽器產生的，上傳時就一起送。** Python Worker 裡沒有影像函式庫，Cloudflare 的 Image Resizing 是 zone 層級的付費功能——所以縮放只能在上傳的那台機器上做。這反而是對的：成本落在上傳的那一個人身上，而不是每一個顧客身上。480／960／1600 三個寬度，永不放大（600px 的圖只會有一個變體），存進 `media_sizes`。

用的是 `createImageBitmap(file, { imageOrientation: 'from-image' })`，所以**EXIF 方向是順帶解決的**，沒有另外寫一段旋轉。手機拍的照片躺著上傳，是這一行處理掉的。

**這批之前上傳的圖沒有變體**（`width/height` 是 0，`media_sizes` 沒有列）。Worker 產不出來，要補只能從後台重新上傳。沒有變體時 `srcset` 就是空的，照樣顯示原圖。

**找一張圖**靠 `title` 與標籤，不是資料夾。一張圖同時是「插畫」和「首頁用」，資料夾只能二選一。`title` 跟 `alt` 是**兩個不同的欄位**：alt 是給看不到圖的人讀的、取決於圖用在哪；title 是你自己找圖用的標籤。合在一起的下場是為了好找而把 alt 寫成「首頁 banner v3」，然後讀螢幕的顧客就聽到這句。

標籤存**關聯表**不是逗號字串：字串建不了索引、列不出「現有哪些標籤」給自動完成，而且比對會跨界——搜「貓」會中「熊貓」。所以搜尋時標籤那一半是精確比對，`title` 與檔名才是子字串。

### 分類

分類是**扁平的多對多**，也就是 tag。沒有階層——之後選單的三層是在選單編輯器裡手排的，不會從分類長出來。兩者刻意獨立：選單想怎麼分組就怎麼分組，不必先說服目錄同意。

分類頁可以一次指定多個：

| 網址 | 意思 |
| --- | --- |
| `/shop/c/candles` | 這個分類 |
| `/shop/c/candles,art-kits` | 任一（OR） |
| `/shop/c/candles+gift` | 兩者皆是（AND） |

**不支援混用。** `a,b+c` 一旦有意義，就得定義優先順序、寫解析器，並在後台介面上讓人表達那個優先順序。那不是篩選，是查詢語言。遇到混用回 404。上限五個 slug——沒有上限的話，一個手工構造帶兩百個 slug 的網址就是一次大查詢。

`/c/` 這一段是刻意的：分類 slug 與商品 slug 從此不可能相撞。

`/shop/c/a,b` 與 `/shop/c/b,a` 是同一批商品的兩個網址。程式產生連結時一律排序 slug；整站目前是 `noindex`，所以重複網址沒有代價。**決定讓商城被收錄時**，這裡要補 canonical 或在 Worker 做 301。

同一個篩選函式之後會被自訂頁的商城區塊沿用，所以網址解析出來的和後台設定的是同一組值，兩邊不會對「兩者皆是」有不同解釋。

### 購物車

購物車只存在瀏覽器的 localStorage，內容只有 `variantId` 和數量。**價格、名稱與是否還買得到，每次都由伺服器從資料庫重算**（`POST /api/cart/validate`）。放了一週的分頁不會顯示過期價格，手動改 localStorage 也只換得到一個被拒絕的請求。

重算的結果分三種，都會回報給顧客而不是默默處理掉：

| 情況 | 回報 |
| --- | --- |
| 商品下架、規格停用、資料列消失 | `unavailable`，整行移除 |
| 庫存為 0 | `out_of_stock`，整行移除 |
| 庫存不足以滿足數量 | `reduced`，數量下修並附上實際可買數 |

免運門檻是**每種配送方式各自設定**。宅配與超商的成本差很多，共用一個門檻會逼你把它訂在最貴的那個。門檻是「達到就免運」而不是「超過才免運」——宣傳滿 1,000 免運卻對剛好 1,000 元的訂單收費，那不是規則，是客訴。

### 購物車的上限

購物車一次最多 **20 種**不同商品。這條是為了 Worker：一種商品是一次查詢，腳本不該有辦法叫它查一千次。

**同一種商品要買幾個沒有店家設的上限——貨有多少就能買多少。** 數量是一個數字，查詢成本不變，所以真正的界線只有庫存。超過庫存時伺服器把該行降到實際數量，並回一句「只剩 N 件，數量已調整」；瀏覽器**不會**事先知道確切庫存（那等於公開你的存貨帳），只有在真的要不到那麼多時才聽到數字。

`cart.MAX_QUANTITY` 等於 `shop.MAX_STOCK`。那不是政策，是「商店永遠不可能有這麼多貨」的那個點——超過就是壞掉的客戶端，不是想大量採購的客人。

### 結帳與庫存

逛商品和加購物車**不需要登入**，按下結帳才要求 Google 登入。顧客的登入與店主的登入是兩套完全獨立的東西：不同的 OAuth client、不同的資料表、不同的 cookie 名稱，而且兩邊的 cookie 都是 host-only。

**庫存在建立訂單時就扣，不是付款成功才扣。** 等付款代表兩個人可以同時買到最後一件；永遠保留代表沒完成的購物車會讓商品永久離架。所以保留有期限：訂單建立時扣庫存並記下 `reserved_until`（15 分鐘），Cron Trigger 每 5 分鐘把逾期未付款的訂單轉成 `expired` 並把庫存放回去。

D1 **沒有互動式交易**，所以防超賣靠的是條件式更新與它的影響列數：

```sql
UPDATE product_variants SET stock = stock - ?2 WHERE id = ?1 AND stock >= ?2
```

檢查寫在 `WHERE` 裡，所以兩個請求搶最後一件時，不可能兩邊都讀到「剩 1」然後都成功——後到的那個 UPDATE match 不到任何列。這是這家店和超賣之間唯一的防線，所以只寫在 `orders.take_stock` 一個地方。

訂單建立途中若有一行賣完，**先前已扣的庫存會被放回去**。少了這一步，某個顧客結帳失敗會安靜地把其他商品從架上拿走。

### 後台的訂單

| 位置 | |
| --- | --- |
| 訂單列表與明細 | `admin.luma-studio.tw/orders` |

狀態只能往前，而且不能跳過 `paid`：`pending → paid → shipped → completed`，取消是另一條路（`pending`／`paid`／`shipped` 都能取消，庫存會退回）。允許的移動寫成一張表 `orders.FORWARD`，API 和後台的按鈕都讀它——畫出一個伺服器會拒絕的按鈕，等於教人「按鈕會騙你」。

**每一次移動都記名字。** 這個部署只有一個人登得進來，所以稽核紀錄裡寫的是那個 email，不是 `admin`。付款被爭議的那一天不是開始蒐集證據的日子。

移動時把「讀到的狀態」放進 `WHERE`，所以兩個人同時按只會有一次成功、一次 409，不會產生兩筆稽核紀錄。沒有 `shipped_at` 這種欄位——什麼時候發生的在稽核紀錄裡，那份才是必須正確的。

**手動標記已付款**是刻意留的：金流還沒串，匯款先到的時候需要一個入口。對到哪一筆匯款會寫進稽核的 detail，因為「手動標記」單獨看沒有意義。

**店家備註不會出現在顧客的訂單頁。** `orders.order_row` 是交給顧客的形狀，`admin_row` 才多帶 `adminNote` 與 `customerId`。把私人備註加進共用的形狀，就是把它發佈在別人的訂單頁上。

### 通知信

信件是**在決定的地方排隊，在別的地方寄出**（[mail.py](backend/src/mail.py) 與 `email_outbox`）。三個理由都是結構性的：

1. 管理 Worker 可以把訂單標記成已出貨，但它**沒有自己的排程**。寫一列資料兩個部署都做得到，在 cron 上跟寄信服務講話則不然。
2. 顧客的訂單不能因為第三方慢就失敗。結帳寫一列就往下走。
3. 留得住的佇列才能重試，也才是「到底寄出去了沒」的紀錄——而那個問題一定會被問。

顧客會收到：訂單成立、已收到款項、已出貨、已取消、已逾期。**「已完成」刻意不寄**——那封信會在包裹之後才到，而且說的比包裹少。你自己會收到「有新訂單」（設了 `MAIL_OWNER` 的話）。

排空在公開 Worker 既有的 5 分鐘 cron 上。單封結算：服務中斷就留著下次再試，連續五次失敗就放棄——不存在的信箱不會因為多試幾次就存在。

**沒設定寄信服務時，連排隊都不做。** 否則加上金鑰的那一刻，一整個月的舊信會同時寄出，有人會在六月收到四月的出貨通知。

後台的訂單明細看得到這筆訂單排過哪些信、寄出了沒、失敗原因是什麼。

換掉 Resend 只要改 `mail.py` 裡的 `_post` 一個函式，和它讀的兩個設定。

### 後台的會員

| 位置 | |
| --- | --- |
| 會員列表與明細 | `admin.luma-studio.tw/customers` |

沒有註冊流程——顧客第一次用 Google 登入結帳時自動建立。列表帶著訂單數與已付金額，那兩個數字跟名單來自**同一次查詢**：逐筆去問等於每一列多一次往返，而 D1 每一次都算錢。已付金額只算 `paid`／`shipped`／`completed`。

**封鎖只擋結帳。** 不會登出，也不會影響對方查看已經成立的訂單——拒絕一筆生意和沒收一張收據是兩件事。

**清除個人資料不是刪除帳號。** 訂單列必須留下：那是店家的帳，三月的收據不能因為六月有人要求被遺忘就消失。所以覆蓋掉 email、姓名、電話、地址，保留該列並記下 `anonymized_at`。留下的是「（已刪除）」而不是空字串——訂單上空白的名字看起來像 bug，會有人去找「不見的資料」。

`google_sub` 一併覆蓋，所以同一個 Google 帳號之後再登入會建立新的顧客，不會復活舊的那一列。session 也一起刪，否則還活著的 session 會繼續吐出那一列已經不再持有的資料。

**沒有動到的**：已成立訂單上的收件人、電話與地址。那是交易紀錄的快照（國稅局要看的東西），不是個人檔案。要不要連那些一起洗掉，是「帳務保存多久」的決定，屬於店主，不寫死在程式裡。

### 金流還沒串

`POST /api/orders/{id}/fake-payment` 可以把訂單標記成已付款，不經過任何金流。它存在的目的是在 PAYUNi 接上之前先驗證庫存、狀態機與稽核軌跡。

**它預設是關閉的**，只有在部署明確設定 `ALLOW_FAKE_PAYMENT = "1"` 時才存在，其餘情況一律回 404。正式環境永遠不要設定它。

### 幾個刻意的決定

**金額是整數新台幣元。** PAYUNi 的 `TradeAmt` 是整數，台幣零售也沒有小數。多一層換算只會多一個讓四捨五入出錯的地方。

**價格驗證拒絕型別不對的值，而不是轉型。** `int("0300")` 和 `int(300.7)` 都會成功，而兩者都代表某個人即將被收取一個沒有人輸入過的金額。價格上限 20,000 對齊 PAYUNi 的單筆上限，所以單一品項不可能自己超過閘道能接受的範圍；下限是 1 而不是 0，免費品項不是這家店在賣的東西。

**庫存數字不完整公開。** 剩 5 件以下才顯示確切數量，其餘只回「有貨」。「剩 2 件」在結帳頁有用，但把完整庫存公開等於讓任何人靠輪詢算出銷量。這條規則在 `shop.public_variant`。

**商品照片的 key 從資料表查，不從網址組。** `/shop-assets/{file}` 會先在 `product_images` 找到對應的列才去 R2 取物件，所以一個舊連結沒辦法拿來探測 bucket 裡還有什麼。R2 前綴是 `_shop/`，底線讓它落在 `IDENTIFIER_PATTERN` 之外，因此永遠不會被當成 ibon 資料夾，`/images/` 也搆不到。

**四層拆開，沒有「商品類型」欄位。** 商品只管展示，方案（`product_variants`）只管定價，內容（`offer_components`）說明付款後給什麼，交付目標是課程或庫存品。「要不要配送」「有沒有含課程」一律**當下從內容推導**，不存進資料庫，前端提交這些值會被回 400 —— 忽略它會讓呼叫端以為被採納了。存一個會漂移的欄位，代價是把數位商品寄出去或把實體商品搞丟。

**庫存搬到獨立的庫存品。** 一個材料包同時被三個課程方案使用時，數字放在其中一個方案上，對另外兩個就是錯的。舊的 `product_variants.stock` 降級成鏡像，只由 `offers.set_simple_offer_stock` 一處寫入，等 Phase 3 讀取切換完成後刪掉那一行。

**商品編輯頁的庫存欄位只在「唯一且未被共用」時可改。** 其他情況回 409 並導向庫存品管理，因為共用的數量屬於所有使用它的方案。

**沒有用 D1 的 `batch` API。** 這個 codebase 還沒有從 Python 呼叫過它，而一串 prepared statement 要跨進 JavaScript 才到得了那裡。排序寫到一半是外觀問題，下次儲存就會自己修正；在寫入目錄的路徑上賭一個沒驗證過的綁定不值得。真正需要原子性的是之後的庫存扣減，那時會用實際部署驗證過再用。

## 線上課程

實作計畫在 [docs/changes/plans/](docs/changes/plans/)（Phase 0–7），開發過程與所有自行判斷的決定記錄在
[docs/changes/course-commerce-worklog.md](docs/changes/course-commerce-worklog.md)。

課程與商品分離：課程負責「教什麼」，商品負責「賣多少錢、搭配什麼」。同一門課程可以被多個方案授予
（例如「線上版」與「課程＋材料包」），而課程內容只有一份。

### 已完成

- 課程、章節、單元；單元可以只有文字、只有影片，或兩者都有
- 購物車與結帳同時處理實體與課程：**純課程不問配送方式、電話與地址**
- 訂單寫下不可變的交付快照（課程名稱、觀看期限、貨號、數量）
- 付款後開通課程，可安全重送；純數位訂單全部開通成功後自動完成
- 會員的「我的課程」、學習頁與觀看進度
- 播放授權：短效 HMAC 簽章 cookie + 私有 R2 閘道
- 對帳查詢與功能開關

### 影片：在本機轉檔，不在 Cloudflare

Cloudflare 上沒有便宜的轉檔選項 —— Stream 按觀看分鐘計費，Container 要付常駐費用，
Worker 不能跑 FFmpeg。所以轉檔跑在管理員的機器上，由 `desktop/` 的桌面工具負責：

1. 拖進一個高畫質 MP4。工具用 ffprobe 讀真實尺寸，決定不放大來源的畫質階梯。
2. 本機轉出 fMP4 HLS 與 poster。
3. 每個物件向 Admin API 換一張短效 presigned PUT URL，直傳 R2。
4. 呼叫 `POST /api/video-assets/import` 註冊。

**第 4 步不是形式。** 它會讀 master playlist、逐一確認每個被引用的物件真的在 R2 上，
全部齊了才標成 `ready`。一支影片幾百個物件，少傳一個是常態，而少一個分段的影片
會播到那一段才斷 —— 那是最糟的發現時機。缺漏會一次全部回報，讓你補傳一次而不是六次。

輸出路徑帶版本號（`videos/{assetId}/{version}/`），所以重新轉檔可以跟會員正在看的那一版
並存，等新版驗證通過才切換。

**R2 的金鑰不進桌面工具。** 工具拿到的是只能做影片操作的短效 token（在後台讀一組
TOTP 配對碼換來的），簽章一律在 Admin Worker 裡做。工具被拿走的最壞情況是「有人
可以上傳影片」，不是「有人可以改訂單」。

#### 安裝與更新

安裝檔放在 `luma-desktop-tools` 桶的 `releases/` 底下，由 Admin Worker 的公開路由
`GET /releases/{檔名}` 送出（`latest.yml` 與 `*.exe`）。這條路由是公開的，因為更新程式
會在任何人登入之前就去看有沒有新版 —— 而它送的是我們自己發佈的 build，不是機密。

**安裝檔沒有簽章，Windows SmartScreen 會警告。** 沒有買憑證的預算，所以第一次下載和
第一次執行都會跳出「Windows 已保護您的電腦」。要按「其他資訊」→「仍要執行」。
這件事寫在這裡、也寫在後台的桌面工具那一頁，因為它看起來像是出了問題而不是預期行為。

**版本政策在後台可以改。** `minSupported` 以下的工具會停止上傳並要求更新；
`blocked` 讓所有版本立刻停下來，不必等每一台機器自己更新 —— 那是給一個發壞了的版本用的。
判斷在伺服器：工具帶自己的版本去問，拿回一個結論，而不是一份要自己解讀的政策。

更新的 feed 用**回應那次版本檢查的伺服器所回報的網址**，不是打包進 build 的那個。
從 staging 裝的工具如果去看正式環境的 feed，會拿到不屬於它的安裝檔。

**留著原始檔，本機和 R2 各一份。** 重新轉檔需要它，而階梯沒辦法從階梯重建 ——
加一階畫質、修一支轉壞的、補回掉掉的物件，都要回到原始檔。兩邊各一份也才算真的兩份，
因為筆電和 Cloudflare 是兩個不同的失效域。原始檔走 multipart 上傳，一支 4K 課程影片
用單一 PUT 傳等於「傳到 87% 斷線就從頭開始」。

沒有任何依時間刪除的 lifecycle rule。刪除一律由人在後台按下，而**課程還在用的原始檔
沒有刪除入口** —— 不是給警告，是不給按鈕。後台的儲存總覽會一直顯示容量與估算費用，
並分開列出「安全可清」（兩個桶的孤兒、被取代的舊版本）和「要自己判斷」（沒有課程在用
的原始檔，刪了就不能再重新轉檔）。

### 幾條值得先知道的規則

**觀看期限從「第一次觀看」起算，不是從購買日。** 付款時只記天數；`expires_at` 要等會員真的取得
播放權時，用一個帶條件的 UPDATE（`first_viewed_at IS NULL`）寫入，所以只會成功一次。沒有這個條件，
每按一次播放都會重設，三十天的課程就變成永久的。文案一律寫「觀看後 N 天」。

**一個會員一門課只有一筆權限，但可以有多個「來源」。** 買兩次同一門課 = 一筆權限 + 兩個來源。
退掉其中一次只撤銷那個來源；只有在沒有任何未撤銷來源時才收回觀看權。這是退款不會誤傷的關鍵。

**`expires_at` 是 NULL 有兩種意思**：永久，或有期限但還沒開始看。兩種都算有效。

**已擁有的課程不能重複購買。** 購物車會說「你已經擁有」，但購物車是一個畫面不是保證 ——
兩個分頁都會在訂單成立前通過那個檢查。真正的把關是 `course_offer_purchase_locks`，
在扣庫存**之前**搶鎖。過期的鎖可以被接管（結帳到一半跑掉不該讓人再也買不了），
付款後的鎖不再過期（否則十五分鐘後又能買一次）。

**播放權只在發 token 時查一次資料庫。** 一堂課有幾百次分段請求，每次都查的成本高過它保護的東西。
代價是取消觀看權要等目前 token 過期（約十五分鐘）才生效 —— 這是刻意的取捨。
Token 寫明它開哪一支影片、哪一個轉檔版本，過期即失效，用常數時間比對，
換金鑰時驗證接受前一把、簽發只用現在這把。

**這不是 DRM。** 能看的人可以錄下他看到的東西。目標是「不能看的人看不到」，
以及「脫離情境被分享的網址會很快失效」。

**課程商品由 `COURSE_CHECKOUT_ENABLED` 等旗標控制，預設關閉。**
旗標讀在**伺服器**：藏起按鈕從來沒有阻止過任何人直接呼叫底下那支 API，而那支 API 才是收錢的。
只有 `"1"` 算開啟 —— 也接受 `"true"` 會變成兩種拼法，最後有一種在關鍵時刻默默失效。

**HTML 一律在後端清理。** 圖片只接受本站自己的資源路徑（`/media-assets/`、`/shop-assets/`），
外部連結自動加 `rel="noopener noreferrer"`。編輯器的限制是操作上的方便，不是安全邊界。

## 名片頁

公開頁：

```text
https://luma-studio.tw/card
```

編輯介面在 admin 的第二個分頁：

```text
https://admin.luma-studio.tw/card
```

可設定頭像、顯示名稱、簡介，以及兩組連結：主要的連結按鈕，和一排社群 icon。兩者都可排序、可個別停用。頭像未設定時公開頁改用 logo。

限制：連結合計最多 50 筆、標題 80 字、網址 2048 字且只接受 `http`、`https`、`mailto`、`tel`；頭像 2 MB 以內的 jpg、png、gif、webp。頭像存在同一個 R2 bucket 的 `_bio-link/` 前綴下，該前綴刻意不符合 ibon 的資料夾規則，因此不會出現在資料夾清單，`/images/` 也取不到。

連結順序可拖曳調整，也保留上下箭頭按鈕——拖曳在鍵盤上無法操作，手機上也不好按。

### 造訪統計

編輯頁下方有 7／30／90 天的統計：頁面瀏覽、連結點擊、點擊率、每日長條圖、各連結點擊排行，以及國家、來源網站、裝置的前幾名。

公開頁上的每個連結都指向 `/r/{id}`，由後端記錄後再轉出。記錄的是每位訪客每天每個目標一筆，內容包含國家、城市、來源網站、裝置類別與一組每日輪替的匿名雜湊，**無法識別個人，也無法跨日追蹤**。User-Agent 看起來是機器人或連結預覽器時完全不記錄。

因此所有數字都是「不重複訪客」而非原始次數：同一人整天重整也只算一次。這不只是讓數字有意義，更是必要的防護——這兩個端點是公開的，而 D1 的每日寫入額度與 admin session 共用。

### 分享預覽

`/card` 被貼到 LINE、Facebook、Slack 時會顯示標題、簡介與品牌卡片。SPA 在爬蟲眼中是空白的 HTML，所以前端 Worker（[frontend/worker/storefront.ts](frontend/worker/storefront.ts)）會在回傳頁面前，向 API 取得目前內容並把 Open Graph 標籤寫進 `<head>`。爬蟲來得又急又密集，因此那次 API 呼叫在邊緣快取五分鐘。

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
