# 後端 API

端點清單以路由檔為準，不在這裡複製一份：
[api/front/routes.py](../backend/src/api/front/routes.py) 與
[api/admin/routes.py](../backend/src/api/admin/routes.py)。
這裡寫的是讀了路由檔也看不出來的部分。

## 跨來源與 CSRF

前端與 API 是不同來源（雖然同屬一個站台），session cookie 為 `SameSite=Lax; Secure; HttpOnly`。跨來源的部分由兩件事補上：

1. 所有非 GET 請求必須帶 `x-luma-app: 1`。自訂標頭會強制觸發 CORS 預檢，跨站表單無法偽造。
2. 同時檢查 `Origin` 在 `ALLOWED_ORIGINS` 清單內，否則 403。

兩個閘門都在 [router.py](../backend/src/shared/router.py) 的 `serve` 裡，兩個 Worker 共用同一份 —— 各留一份副本會漂移，而會漂移的那一份就是沒人在看的那一份。

`ALLOWED_ORIGINS` 與 `FRONTEND_ORIGIN` 各自定義在該 Worker 的設定檔 `[vars]`。兩份清單刻意不重疊：公開 API 不接受管理網域的來源，管理 API 也不接受公開站台的來源。

瀏覽器端有對應的一半：`_headers` 裡的 CSP `connect-src` 也是各站只放行自己的 API。這份檔案由 [vite.config.ts](../frontend/vite.config.ts) 依 build mode 產生，而不是放在 `public/` —— `public/` 會被複製進兩份建置，共用一份就代表 `connect-src` 必須是兩邊需求的聯集，而聯集正好是我們不想要的東西。政策的來源是 `.env` 裡那組網址，跟 client 讀的是同一份，兩者不會各說各話。

## 速率限制

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

## 備份

[.github/workflows/backup.yml](../.github/workflows/backup.yml) 每天台北時間清晨三點把 D1 匯出、壓縮後上傳到 R2 的 `_backups/YYYY-MM-DD.json.gz`。也可以在 Actions 頁面手動觸發。

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

[scripts/restore-d1.py](../scripts/restore-d1.py) 產生的是 `INSERT OR REPLACE`：主鍵相同的列會被覆蓋，備份之後才新增的列保持不動，所以還原不會安靜地刪掉較新的資料。要讓資料庫完全等同備份時加 `--replace-tables`，它會先清空各表。也可以用 `--table` 只還原其中幾張。

備份不會自動清理。要限制數量的話，在 R2 → `luma-ibon-images` → Settings 加一條 lifecycle rule，讓 `_backups/` 前綴的物件在 90 天後過期。

**R2 裡的圖檔本身沒有備份。** 客人的作品圖只有一份，這是已知的缺口。

## 監測

[.github/workflows/canary.yml](../.github/workflows/canary.yml) 每天台北時間早上七點半跑兩件事。失敗時 GitHub 會寄信給 repo 擁有者。

**ibon 取件流程**：向 `zz_canary` 這個資料夾請求取件編號，確認拿到的 pincode 真的是 8–12 位數字、有列印期限、有圖檔清單。

這條流程走的是 ibon 的一般消費者網頁介面，不是官方 API——ibon 隨時可能改欄位或開始擋 Cloudflare 的流量。沒有這個監測的話，你會在客人站在超商裡打不開連結時才知道。

執行前會先刪掉該資料夾的 24 小時快取。少了這步，canary 第二天起就只是在讀自己的資料庫，會在真正的流程壞掉時天天顯示正常。

**公開路徑**：確認 `/`、`/admin`、`/card`、`/ibon_print/{id}`、`/api/health`、`/api/bio-link` 都回 200，而且 `/card` 帶著分享預覽標籤。`/admin` 曾經因為前端 Worker 的一行錯誤而 307 導回首頁，這類檢查就是為了讓那種問題自己現形。

建立 `zz_canary` 資料夾時放一張小圖即可。它會出現在 admin 的資料夾清單裡（底線開頭的 id 無法通過 `IDENTIFIER_PATTERN`，所以不能藏起來），排在最後。

**這會每天在 ibon 產生一組真實的取件編號。** 量很小，但那是真的在使用 ibon 的服務。

## D1 migration

schema 定義在 [backend/src/migrations.py](../backend/src/shared/migrations.py)，由**管理 Worker** 在每個 isolate 首次收到請求時自動套用，並以 `schema_migrations` 表記錄。所有敘述都必須可重複執行，因為多個 isolate 會同時啟動。手動執行 `wrangler d1 execute` 已不再需要。

公開 Worker 不套用任何 migration，`/api/health` 只讀取 `schema_migrations` 回報現況。因此部署順序是管理端先、公開端後；公開端回報的清單短少，代表部署順序出了問題，該被看見而不是被隨手修掉。

migration 除了現有的字串檢查，另外會**用真正的 SQLite 引擎重跑一次**（[backend/tests/test_migrations_sqlite.py](../backend/tests/test_migrations_sqlite.py)）。
只檢查 SQL 字串長得對不對，連「這句話資料庫肯不肯收」都測不出來，也測不出一個
parse 得過但其實什麼都沒約束的索引。D1 就是 SQLite，所以這是可用的替身 ——
但它不是 D1 本身，證明不了線上資料庫目前裝著什麼。

## 功能開關

課程相關功能由環境變數控制，**沒設定就是關閉**，而且**只有 `"1"` 算開啟**：

| 變數 | 控制什麼 |
| --- | --- |
| `COURSE_CATALOG_ENABLED` | 課程在商城的曝光 |
| `COURSE_CHECKOUT_ENABLED` | 含課程的商品能不能結帳 |
| `COURSE_LEARNING_ENABLED` | 會員課程中心 |
| `VIDEO_UPLOAD_ENABLED` | 影片的 presign、上傳與註冊 |

旗標讀在伺服器（[backend/src/shared/flags.py](../backend/src/shared/flags.py)）。前端可以用它決定畫不畫按鈕，
但擋下請求的是後端 —— 藏起按鈕從來沒有阻止過任何人直接呼叫底下那支 API。

`/api/health/reconciliation`（管理端，需登入）會回報目前所有旗標狀態，
以及「該發生卻沒發生」的事：付了款沒開通的訂單、逾期還佔著庫存的訂單、卡住的轉檔、
所有來源都撤銷了但權限還在的會員、以及孤兒購買鎖。**它只回報，不修復** ——
修復留給本來就知道怎麼修的程式碼，同一個修復寫兩遍就會有兩種行為。
