# 購物車與商城設計

日期：2026-07-28

## 目標

在 luma-studio.tw 上開一個自營商城：商品展示、購物車、結帳、訂單管理。
客單價約 300 元，實體小物，個人賣家（無商業登記）。

金流選定 **PAYUNi 統一金流**，只開信用卡（含 Apple Pay、Google Pay）。
物流用 **7-11 店到店 C2C** 與宅配。

## 為什麼自己寫而不用現成電商

購物車本身沒有難度：商品清單、數量、小計、一張訂單表。難的是金流、發票、
對帳、PCI，那些一律交給金流商。專案已經有 Cloudflare Worker、D1、R2 與
Google OAuth，多裝一套現成電商系統反而多一層要維護的東西。

## 已確定的商業決策

### 付款方式只開卡類

客單價 300 元，下限（最低手續費）比費率重要。以綠界的公開費率為例，
實際手續費是 `max(費率 × 金額, 下限)`，每種方式都有一個下限失效點：

| 付款方式 | 費率 | 下限 | 下限失效點 |
| --- | --- | --- | --- |
| 信用卡 | 2.75% | 5 元 | 182 元 |
| ATM 虛擬帳號 | 1% | 15 元 | 1,500 元 |
| 超商代碼 | — | 31 元固定 | — |

交叉點在 545 元。**客單價低於 545 元時，信用卡是最便宜的付款方式**，
ATM 與超商在 300 元的有效費率是 5% 與 10.3%。因此不開 ATM、不開超商代碼。

LINE Pay 放棄：需先向 LINE Pay 台灣申請商家、再到金流商後台綁定，兩邊各一套
審核；且若其下限為 10~15 元，300 元訂單的有效費率是 3.3%~5%。

### 電子發票這一版不做

台灣營業稅門檻是三段式，與有無登記無關：

| 月銷售額（貨物） | 稅籍登記 | 開發票 | 營業稅 |
| --- | --- | --- | --- |
| < 10 萬 | 否 | 否 | 免 |
| 10 萬 ~ 20 萬 | 是 | **否**（免用統一發票之小規模營業人） | 1%，每季 |
| ≥ 20 萬 | 是 | 是 | 5%，每兩月 |

起徵點自 2025-01-01 起為貨物 10 萬、勞務 5 萬。換算 300 元客單價：
每天約 11 筆到稅籍登記門檻，每天約 22 筆才需要開發票。

Schema 預留 `invoice_no` 與 `invoice_status` 欄位但不寫入。
後台提供「本月累計營業額」以監控 10 萬門檻。

### 只做 UPP，不預留 UNi Embed

PAYUNi 有三種整合方式：

| 模式 | 卡號在哪 | 外觀可客製 | 需自有 PCI-DSS | 需 IP 白名單 |
| --- | --- | --- | --- | --- |
| UPP 整合式支付頁 | PAYUNi 頁面 | 只能換 logo 主色 | 否 | **否** |
| UNi Embed（iframe） | 自家頁面的 iframe | 是 | 否 | **是** |
| 幕後 credit API | 自家 server | 是 | **是** | 是 |

UNi Embed 的 `iframe/token_get` 與 `iframe/merchant_trade` 都是伺服器對伺服器
呼叫，而 PAYUNi 要求設定固定 IP。**Cloudflare Worker 沒有固定出口 IP**，
因此 UNi Embed 這條路目前走不通。

UPP 是瀏覽器 Form Post，正常流程上零筆對外伺服器呼叫，從結構上繞開 IP 限制。

### UPP 內建物流，不串物流幕後 API

從 UPP 錯誤碼表可知 UPP 支援物流參數（`UPP02054` 啟用物流開關、
`UPP02061` 7-ELEVEN 店到店、`UPP02062` 黑貓宅配、`UPP03023` 未有選擇物流地圖、
`UPP03025`~`UPP03034` 收件人欄位）。消費者在 PAYUNi 支付頁上一次完成
「選門市 + 填收件資料 + 刷卡」，物流單隨交易建立。

因此不需要 `logistics/trade`（幕後，受 IP 限制）、不需要 `ship_map`（前景轉址）。

會員資格限制：**7-11 店到店 C2C 商業與個人會員皆可使用**；大宗寄倉 B2C 與
退貨便 C2B 僅限商業會員，本專案用不到。退貨需請客人自行寄回。

### 收件資料在自家結帳頁收

UPP 有「固定」版本的參數（`UPP02120` 收件人姓名(固定)、`UPP02121` 收件人手機(固定)、
`UPP02079` 收件人地址(固定)），可在自家結帳頁收好帶過去，PAYUNi 頁面上只剩
選門市與刷卡。保留大部分結帳頁的設計空間。

## 架構

### 四個部署

| 部署 | 內容 | 網域 |
| --- | --- | --- |
| `luma-studio` | 公開 API（Python Worker） | `api.luma-studio.tw` |
| `luma-studio-admin-api` | 管理 API（Python Worker） | `admin-api.luma-studio.tw` |
| `luma-studio-web` | 商店前台（Vite + Preact） | `luma-studio.tw` |
| `luma-studio-admin` | 管理後台（Vite + Preact） | `admin.luma-studio.tw` |

公開 Worker 沿用既有的 `luma-studio` 名稱而不改成 `luma-studio-api`：改名會建出一個新 Worker、留下一個孤兒，還要把 custom domain 搬過去，換來的只是名字好看一點。

拆分的理由是 cookie 隔離。現有 cookie 沒有設 `Domain`，是 host-only，
所以拆開後管理者 session cookie 只會送到 `admin-api`，前台任何 XSS 都碰不到它。
四個網域都在 `luma-studio.tw` 底下，仍是 same-site，`SameSite=Lax` 不需改變。

`admin.luma-studio.tw` 可整站掛 Cloudflare Access，不影響顧客端。

### 後端：一份程式碼，兩個 Worker

```text
backend/
  wrangler.toml         luma-studio            main=src/main.py
  wrangler.admin.toml   luma-studio-admin-api  main=src/admin_main.py
  src/
    router.py         共用 entrypoint（OPTIONS / CSRF / migration / dispatch）
    main.py           公開入口
    admin_main.py     管理入口
    auth_admin.py     admin session + ALLOWED_ADMIN_EMAILS
    auth_customer.py  customer session + customers upsert
    shop.py           商品、購物車驗算、庫存
    orders.py         訂單狀態機、庫存扣減與回補
    payuni.py         加密、UPP 表單、Notify 處理
    shipping.py       運費計算
    mailer.py         Cloudflare Email
    shop_admin_api.py 管理端商品／訂單／會員
```

原先規劃再抽一個 `auth_core.py` 給兩種登入共用。實作時沒有抽：目前只有一個使用者，抽出來的共用層會是憑空猜測的形狀。等 `auth_customer.py` 真的存在時再抽，那時才知道哪些東西真的共用。

### 前端：一個專案，兩個建置

```text
frontend/
  wrangler.jsonc        luma-studio-web    assets ./dist/storefront  main worker/storefront.ts
  wrangler.admin.jsonc  luma-studio-admin  assets ./dist/admin       main worker/admin.ts
  index.html  admin.html
  .env.production  .env.admin
  src/
    storefront/  admin/  shared/
```

`vite build` 與 `vite build --mode admin`（前台就是預設的 production 模式，
不另立 storefront 模式）。兩邊都要沿用現有 `html_handling: "none"` 與
`not_found_handling: "none"`——預設值會讓 SPA 路由被導回首頁。

三件實作時才浮現的事：

**Vite 依來源檔名命名輸出的 HTML**，所以後台的 shell 是 `dist/admin/admin.html`
而不是 `index.html`。改用建置後重新命名或第二個 Vite root 都不值得，後台
Worker 直接知道自己的 shell 叫什麼（`worker/admin.ts` 的 `SHELL`）。

**API 網址放在 `.env.production` 與 `.env.admin`，不放 CI 環境變數。** 兩份建置
需要不同的值，一個 shell 變數同時餵兩邊，後台就會安靜地連到公開 API——那是
一種不會報錯的壞法。這些是公開網址，本來就會內嵌進 bundle，沒有機密問題。

**前端有三個 base 而不是一個。** `API_BASE` 是這份建置驗證的對象（前台是公開
API，後台是管理 API）；`PUBLIC_API_BASE` 是圖檔、頭像與點擊轉址，後台也要用，
因為那些永遠由公開 Worker 提供；`STOREFRONT_ORIGIN` 是後台複製給客人的連結，
用 `location.origin` 會產生 `https://admin.luma-studio.tw/bio_link` 這種只有
擁有者登入時才打得開的網址。

### 路徑不再有 admin/ 與 shop/ 前綴

主機拆開之後，`admin-api` 上每一支都是管理端點，前綴是多餘的。

**admin-api.luma-studio.tw**

| Method | Path |
| --- | --- |
| GET | `/api/session` |
| GET | `/auth/login`、`/auth/callback` |
| POST | `/auth/logout` |
| — | `/api/products`、`/api/products/{id}/variants`、`/api/products/{id}/images` |
| GET | `/api/orders?status=&q=`、`/api/orders/{id}` |
| PATCH | `/api/orders/{id}` |
| POST | `/api/orders/{id}/cancel`、`/api/orders/{id}/resend-email` |
| GET | `/api/customers?q=`、`/api/customers/{id}` |
| PATCH | `/api/customers/{id}`（只允許改 `blocked`） |
| POST | `/api/customers/{id}/anonymize` |
| GET / PUT | `/api/shipping-methods` |
| GET | `/api/stats/revenue?month=` |
| — | `/api/bio-link*`、既有資料夾與列印設定端點 |

**api.luma-studio.tw**

| Method | Path |
| --- | --- |
| GET | `/api/session` |
| GET | `/auth/login`、`/auth/callback` |
| POST | `/auth/logout` |
| GET | `/api/products`、`/api/products/{slug}` |
| POST | `/api/cart/validate` |
| GET | `/api/shipping-methods` |
| POST | `/api/checkout` |
| GET | `/api/orders`、`/api/orders/{id}` |
| POST | `/api/orders/{id}/retry-payment` |
| GET / PATCH | `/api/profile` |
| POST | `/api/payuni/notify`、`/api/payuni/return` |
| GET | `/api/bio-link`、`/api/bio-link/calendar`、`/r/{id}` |
| GET | `/api/print/{id}`、`/ibon_print/{id}` |
| GET | `/images/*`、`/bio-link-assets/*` |

兩台主機的 `/api/session`、`/auth/login`、`/api/orders` 路徑重疊但語意不同，
這是刻意的：`auth_core.py` 兩邊共用時路由形狀一致，前端 `shared/api.ts` 可以
是同一個 client 只差 base URL。打錯主機會安全地失敗，因為 cookie 是 host-only。

### 環境設定

| 項目 | api | admin-api |
| --- | --- | --- |
| Cookie 名 | `luma_customer_session` | `luma_admin_session` |
| `ALLOWED_ORIGINS` | `https://luma-studio.tw,https://www.luma-studio.tw` | `https://admin.luma-studio.tw` |
| `FRONTEND_ORIGIN` | `https://luma-studio.tw` | `https://admin.luma-studio.tw` |
| Google OAuth client | 顧客用（新開一組） | 管理用（沿用現有） |
| Migration | 不執行 | **執行** |

速率限制器：

| Worker | 限制器 |
| --- | --- |
| admin-api | `LOGIN`(1001) |
| api | `PRINT`(1002)、`PUBLIC`(1003)、`ASSET`(1004)、`CUSTOMER_LOGIN`(1005)、`SHOP`(1006)、`CHECKOUT`(1007)、`NOTIFY`(1008) |

`CHECKOUT` 比一般讀取嚴格（會扣庫存、寫多張表）。`NOTIFY` 反而要寬，
因為來源集中在 PAYUNi 的少數 IP，用現有 per-IP 邏輯會擋掉自己的付款通知。

## 資料模型

金額一律**整數新台幣元**。PAYUNi 的 `TradeAmt` 是 Int，台幣零售沒有小數，
多一層換算只會製造捨入 bug。

新增 migration `0007_create_shop`，沿用 `migrations.py` 既有慣例。

### 商品

```sql
products (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | active | archived
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)

product_images (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
  r2_key TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL
)

product_variants (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
  title TEXT NOT NULL,          -- 「M / 藍」，單一字串
  sku TEXT, price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
)
```

規格不做 option/value 矩陣，`title` 一個字串。品項數量少時矩陣只會讓後台難用。

實作時定下的幾條規則：

- **價格驗證拒絕型別不對的值而不轉型。** `int("0300")` 與 `int(300.7)` 都會成功，
  而兩者都代表某人即將被收取沒有人輸入過的金額。上限 20,000 對齊 PAYUNi 單筆
  上限；下限是 1，免費品項會在結帳時表現得像捨入誤差。
- **庫存只在剩 5 件以下才對外顯示數字**（`shop.public_variant`）。完整庫存公開
  等於讓人靠輪詢算出銷量。
- **商品照片的 R2 key 從 `product_images` 查，不從網址組。** 前綴 `_shop/` 讓它
  落在 `IDENTIFIER_PATTERN` 之外，`/images/` 搆不到，舊連結也無法用來探測 bucket。
- **沒有用 D1 `batch`。** 這個 codebase 還沒從 Python 呼叫過它，一串 prepared
  statement 要跨進 JavaScript 才到得了那裡。目錄排序半途中斷只是外觀問題，下次
  儲存自己修正。真正需要原子性的是庫存扣減，到那時再以實際部署驗證。

### 顧客

```sql
customers (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,   -- 穩定 ID，不用 email（email 可變）
  email TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
  default_recipient_name TEXT NOT NULL DEFAULT '',
  default_recipient_phone TEXT NOT NULL DEFAULT '',
  default_address TEXT NOT NULL DEFAULT '',
  blocked INTEGER NOT NULL DEFAULT 0,
  anonymized_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)

customer_sessions (session_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, expires_at INTEGER NOT NULL)
customer_oauth_states (state TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, next_url TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL)
```

訂單數與累計消費不存欄位，讀取時聚合查詢。

### 訂單：編號分兩層

PAYUNi 對 `MerTradeNo` 有兩條限制：`UPP01007 已存在相同商店訂單編號`，
且「10 分鐘內不可重複」。付款失敗後重試不能重送同一個編號，因此**對外訂單編號**
與**每次付款嘗試送給 PAYUNi 的編號**分開。

```sql
orders (
  id TEXT PRIMARY KEY,               -- LS20260728A7K2QX9，顧客看到的
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  subtotal INTEGER NOT NULL, shipping_fee INTEGER NOT NULL, total INTEGER NOT NULL,
  shipping_method TEXT NOT NULL,     -- home | cvs_c2c
  recipient_name TEXT NOT NULL, recipient_phone TEXT NOT NULL, recipient_email TEXT NOT NULL,
  shipping_address TEXT NOT NULL DEFAULT '',
  store_id TEXT, store_name TEXT, store_addr TEXT,   -- C2C，由 Notify 回填
  trade_no TEXT, ship_trade_no TEXT, payment_type INTEGER,
  invoice_no TEXT, invoice_status TEXT,              -- 預留，不寫入
  reserved_until INTEGER,            -- 庫存保留到期
  paid_at INTEGER, cancelled_at INTEGER,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)

payment_attempts (
  mer_trade_no TEXT PRIMARY KEY,     -- 送給 PAYUNi 的，每次重試都是新的
  order_id TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL,              -- pending | success | failed | expired
  created_at INTEGER NOT NULL
)
```

`mer_trade_no` 格式 `LS<日期><亂碼>`，落在 `[A-Za-z0-9_-]`、長度 20 以內
（上限 25，留餘裕）。

### 訂單項目：快照

```sql
order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, variant_id TEXT NOT NULL,
  product_title TEXT NOT NULL, variant_title TEXT NOT NULL,
  unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL, subtotal INTEGER NOT NULL
)
```

商品名稱與單價存快照，不 JOIN 回 `products`。改名或調價後，舊訂單明細必須
還是當初的樣子——這是會計正確性。

### 運費

```sql
shipping_methods (
  method TEXT PRIMARY KEY,           -- home | cvs_c2c
  label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  fee INTEGER NOT NULL,
  free_threshold INTEGER,            -- NULL = 不提供免運
  position INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
```

免運門檻每種寄送方式各自設定。宅配與超商成本差很多，共用門檻會逼你訂在最貴的那個。

### 稽核

```sql
payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mer_trade_no TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,   -- 原始 body 的 SHA256，冪等來源
  status TEXT NOT NULL, raw_json TEXT NOT NULL, received_at INTEGER NOT NULL
)

order_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  actor TEXT NOT NULL,               -- system | payuni | admin:<email>
  action TEXT NOT NULL,
  from_status TEXT, to_status TEXT,
  detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
)

order_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL, kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL, error TEXT
)
```

`payment_events.event_hash` 的 UNIQUE 索引是冪等機制。金流商收不到 200 一定會
重送，重複 insert 撞索引即視為已處理，不重複扣庫存、不重複寄信。手法與
`bio_link_events` 相同。

`raw_json` 寫入時用**欄位白名單**，絕不寫入完整卡號或 CVC。`Card6No`、`Card4No`
（前六後四）是允許保存的。

### 訂單狀態機

```text
pending ──付款成功──> paid ──出貨──> shipped ──完成──> completed
   │                    │
   ├─逾時─> expired     └─取消─> cancelled
   └─取消─> cancelled
```

離開 `pending`/`paid` 進入 `expired`/`cancelled` 時回補庫存。這條規則集中在
一個函式，不散落各處。

### 庫存

不開預留表。建立訂單時直接扣，`orders.reserved_until = now + 15 分鐘`。

D1 **沒有互動式交易**，扣減寫成條件式更新，靠影響列數判斷：

```sql
UPDATE product_variants SET stock = stock - ?1 WHERE id = ?2 AND stock >= ?1
```

影響 0 列 = 庫存不足，整筆訂單回滾。多個項目用 `batch()` 取得原子性。

過期回補用 Cron Trigger，每 5 分鐘把 `status='pending' AND reserved_until < now`
轉 `expired` 並回補。15 分鐘保留期與 UPP 的「交易截止秒數」（上限 600 秒）相容。

### 備份

`.github/workflows/backup.yml` 目前硬編碼匯出四張表，要新增：
`products`、`product_variants`、`product_images`、`customers`、`orders`、
`order_items`、`payment_attempts`、`payment_events`、`order_audit_log`、
`shipping_methods`、`order_emails`。

維持排除：`customer_sessions`、`customer_oauth_states`、`admin_sessions`、
`admin_oauth_states`（有效憑證）、`ibon_print_cache`（24 小時過期）。

**缺表檢查的清單必須同步更新**，否則哪天漏匯出 `payment_events`，備份仍會顯示
成功，等到要調帳才發現沒備份到。靜默失效比沒備份更糟。

## 前端流程

### 購物車只活在 localStorage

鍵值只有 `[{variant_id, qty}]`。價格一律後端算。沒有伺服器端購物車表，
因此登入前後不需要合併——少一張表、少一組同步邏輯、少一類 bug。
跨裝置同步在 300 元客單價不值得。

`POST /api/cart/validate` 是信任邊界：購物車頁每次載入都打，回傳重算後的
單價、小計、庫存狀態、可用運費方案。商品下架或漲價時當場顯示，而非結帳才失敗。

庫存顯示：低於 5 件才顯示數字，其餘只回有貨／無貨。公開完整庫存等於讓人
算得出銷量。

### 未登入到登入

```text
逛商品 ──> 加購物車 ──> 看購物車 ──> 按「結帳」
 未登入      未登入        未登入          ├─ 已登入 ─> 結帳頁
                                          └─ 未登入 ─> Google 登入 ─> 回結帳頁
```

登入導回沿用現有 `next` 參數與 `safe_return_url` 的允許清單檢查。

### 結帳頁

一頁到底，不分步驟。300 元的東西不值得三步精靈。

表單驗證要在前端就擋住 PAYUNi 的規則，不能等付款頁才失敗：

- 姓名：2~5 個中文字或 4~10 個英文字，**不可含 emoji**（`UPP01015`、`UPP01016`）
- 手機：`09` 開頭半形數字

規則寫在 `shared/validation.ts`，後端用同一組規則再驗一次。

選 7-11 時不在自家頁面選門市——門市在 PAYUNi 支付頁上選。

### 付款

```text
POST /api/checkout
  ↓ 驗價 → 扣庫存 → 建 order(pending) → 建 payment_attempt
  ↓ 回傳 { action, fields: { MerID, Version, EncryptInfo, HashInfo } }
前端組隱藏 form 自動 submit
  ↓
PAYUNi 支付頁：選門市 → 確認收件資料 → 刷卡
  ↓
  ├─ 背景 ─> POST /api/payuni/notify   ← 狀態以此為準
  └─ 前景 ─> POST /api/payuni/return  ─> 302 到 /orders/{id}
```

前景與背景是兩條會競爭的獨立路徑。使用者可能在 Notify 送達前就被導回，
所以訂單頁要能顯示「處理中」並輪詢（每 3 秒，上限 2 分鐘），而非假設已 `paid`。
使用者也可能付完直接關瀏覽器——前景導回從未發生，Notify 照樣完成訂單。

## PAYUNi 串接

### 加密

Pyodide 沒有 `cryptography`，走 WebCrypto。PHP SDK 的四個步驟每一步都有踩點：

```python
async def encrypt_info(env, payload: dict) -> str:
    plaintext = urlencode(payload).encode("utf-8")      # http_build_query 等價
    key = await _aes_key(env)
    iv = Uint8Array.new(env.PAYUNI_HASH_IV.encode("ascii"))
    buf = await crypto.subtle.encrypt(
        to_js({"name": "AES-GCM", "iv": iv}), key, Uint8Array.new(plaintext)
    )
    out = bytes(Uint8Array.new(buf).to_py())
    ciphertext, tag = out[:-16], out[-16:]              # WebCrypto 把 tag 接在尾巴
    joined = base64.b64encode(ciphertext) + b":::" + base64.b64encode(tag)
    return joined.hex()                                  # PHP options=0 已 base64 過
```

```python
def hash_info(env, encrypt_str: str) -> str:
    return hashlib.sha256(
        f"{env.PAYUNI_HASH_KEY}{encrypt_str}{env.PAYUNI_HASH_IV}".encode("ascii")
    ).hexdigest().upper()
```

驗證回應用 `hmac.compare_digest`（SDK 原本是非定時比較）。
解密切分用 `partition(b":::")` 對應 PHP 的 `explode(..., 2)`。

不照抄 SDK 的兩個壞習慣：`CURLOPT_SSL_VERIFYPEER => false`（Workers `fetch`
預設驗證，保持預設）、`!=` 比較 hash。

必須實測確認的四點：`AesType` 設定值（`UPP02068`~`UPP02070` 顯示演算法可能
每商店可設定）、Hash IV 長度、中文 UTF-8 百分比編碼是否逐位元組相同、tag 長度。

憑證 `PAYUNI_MER_ID`、`PAYUNI_HASH_KEY`、`PAYUNI_HASH_IV` 用 Worker secret，
不是 `[vars]`。`PAYUNI_ENV` 用 var 決定 base URL。

### Notify 處理順序

順序本身是安全設計，不可調換：

```text
1. 驗 HashInfo（compare_digest）        不過就 400，不解密
2. 解密 EncryptInfo
3. 查 payment_attempts[MerTradeNo]      查無就 404 並記 audit
4. 比對 TradeAmt == orders.total        不符就拒絕 + audit 告警
5. INSERT payment_events(event_hash)    撞 UNIQUE = 重送，直接回 200
6. 更新 orders 狀態 + 回填門市／物流序號
7. 寫 order_audit_log
8. 寄信（wait_until，不阻塞回應）
```

第 4 步是關鍵：`HashInfo` 只證明訊息沒被竄改，不證明金額是我們期待的。
少了它，能重放舊通知的人就能用便宜訂單的金額蓋掉貴訂單。

回應一律 200，除驗證失敗外。非 200 會讓 PAYUNi 重試已處理完的東西。

`/api/payuni/return` 只驗 hash、查訂單、302，**不改任何狀態**。前景導回是
使用者可偽造、可中斷、可完全不發生的路徑。

### 已知並接受的廠商風險

Hash IV 是固定值，每筆交易的 GCM nonce 相同。GCM 重複使用 nonce 在密碼學上
是已知的嚴重弱點。這是廠商協定，無法改變。因應方式：`EncryptInfo` 只放交易
必要欄位。

### 既有安全機制的衝突

`main.py` 的 `Default.fetch` 在 dispatch **之前**檢查 `has_csrf_protection()`。
PAYUNi 的 Form Post 既沒有 `x-luma-app: 1`，Origin 也不在允許清單，會直接 403。

`router.serve` 需要 `csrf_exempt` 參數，`/api/payuni/notify` 與
`/api/payuni/return` 走豁免路徑，改用 `HashInfo` 驗證來源。這是刻意打開的
安全邊界，程式裡要寫清楚原因與替代驗證。

## 會員管理

`PATCH /api/customers/{id}` 只允許改 `blocked`。代客修改姓名地址沒有用：
訂單的收件資料是下單當下的快照存在 `orders` 上，改 `customers.default_*`
不影響已成立訂單，只會讓人以為改了有效。

`blocked = 1` 在 `/api/checkout` 回 403。

### 匿名化

個資法有刪除請求權，但訂單同時是交易憑證，因此是匿名化而非刪除：

| 資料 | 處理 |
| --- | --- |
| `customers.email` | `anonymized-{id}@invalid` |
| `customers.google_sub` | `deleted:{id}`（UNIQUE NOT NULL，不能設 NULL） |
| `customers.display_name`、`default_*` | 清空 |
| `orders` 的收件人姓名／電話／信箱／地址 | 清空 |
| `orders` 的金額、品項、時間 | 保留 |
| `payment_events.raw_json` | **保留原文** |

保留 `payment_events` 原文的理由：它是唯一自己掌握的金流稽核證據，遮蔽會直接
抵銷「自己站也要備份支付稽核」這個目標；個資法有「執行職務或業務所必須」的
例外，金流爭議舉證屬於此類。此決定可再議。

## 實作順序

金流先不串，以假結帳驗證整條流程。

1. ~~**後端拆分**：兩個 Worker、`router.py`、migration 歸屬、路徑去前綴~~ 完成
2. ~~**前端拆分**：兩個部署、`storefront` / `admin` / `shared`、舊 `/admin` 轉址~~ 完成
3. ~~**商城後台**：`products` / `product_variants` / `product_images` 與後台 CRUD~~ 完成
4. ~~**商城前台**：`/shop` 列表與 `/shop/{slug}` 商品頁~~ 完成
5. ~~**購物車**：localStorage、`/api/cart/validate`、購物車頁、運費設定~~ 完成
6. ~~**假結帳**：顧客 Google 登入、結帳頁、建立訂單與扣庫存、以 stub 取代 PAYUNi~~ 完成
7. 之後：PAYUNi spike → UPP 串接 → Notify → 通知信 → 會員管理

假結帳這批的四件事：

- **`auth_core.py` 這時候才抽出來**，因為到這時才真的有兩個使用者。批 1 刻意沒抽，
  當時抽出來的形狀會是憑空猜的。
- **批 1 留下的 `/api/admin/*` 轉接層在這批移除**，因為顧客登入要用的 `/auth/*` 和
  `/api/session` 正好被它佔著。測試改成斷言那些路徑回 **404 而不是 401**——401 代表
  處理器還接著，只差一道 session 檢查。
- **`ALLOW_FAKE_PAYMENT` 預設關閉**，未開啟時 `fake-payment` 路由回 404 而不是 403。
  一個只在測試環境存在的付款捷徑，不該在正式環境留下「這裡有東西但你不能用」的痕跡。
- **`orders.take_stock` 的影響列數是唯一的防超賣機制**，所以只寫在一處，並且有測試
  直接針對「回報 0 列」與「driver 根本不回報」兩種情況。後者被當成失敗處理，因為
  假設它成功的代價是超賣。

購物車實作時定下的兩條：

- **重算的三種結果都要回報給顧客**，不能默默處理。下架／停用／消失一律是
  `unavailable`（對顧客而言是同一件事），庫存為 0 是 `out_of_stock`，數量不足是
  `reduced` 並附上實際可買數。被移除的行也要從 localStorage 刪掉，否則同一則警告
  每次載入都會再出現一次。
- **免運門檻是「達到就免運」**。宣傳滿 1,000 免運卻對剛好 1,000 元的訂單收費，
  那不是規則，是客訴。

`cart.price_lines` 之後會被結帳直接沿用，這樣顧客看到的總額和實際被收的金額不會
由兩段可能不一致的程式各算一次。

前台的兩條規則：**只有 `active` 解得開**（草稿被人猜中 slug 也是 404，已下架的
停止販售，對顧客而言兩者是同一件事），以及**停用的規格完全不出現在 payload 裡**
——不是灰掉，是不存在。

新增資料表時要同步加進 `.github/workflows/backup.yml` 的 `TABLES`。缺表檢查是照
同一個變數迭代的，漏掉的表不會被抓到，備份照常成功。

### 遷移順序（不停機）

先讓新的能用，再拿掉舊的。中間有一段兩邊都能服務 admin 的重疊期，那是安全網。

1. 建 DNS：`admin-api`、`admin`
2. 部署 admin-api（跑 migration）——`api` 上的舊 admin 路由仍在，沒有東西壞掉
3. 部署 admin 前端，實際登入驗證
4. 確認無誤後，`main.py` 移除 admin 路由、加入 shop 路由，部署 api
5. storefront 加 `/admin*` → 301，部署
6. 更新 Google OAuth 的 redirect URI

第 2 步和第 4 步之間，公開 Worker 上的 `main.legacy_admin_response` 把舊的
`/api/admin/*` 改寫成新形狀後交給 `admin_main.dispatch`。用同一張路由表而不是
另寫一份，兩者才不會對「誰可以進來」有不同意見。這段程式碼連同 `admin_main`
的 import 一起，在第 4 步整塊刪除。

CI 部署順序固定為 **admin-api → api → admin → storefront**，schema 永遠先於
使用它的程式。

## 尚待確認

- PAYUNi UPP 的**參數規格頁**（文件站側欄展不開，目前的 UPP 能力是從錯誤碼表
  反推）。串接前必須調出規格頁核對欄位名稱與型別。
- 商店的 `AesType` 設定值。
- 7-11 店到店 C2C 個人會員的開通文件。
