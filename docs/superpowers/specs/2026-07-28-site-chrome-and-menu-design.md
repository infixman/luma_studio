# 站台外框與選單

日期：2026-07-28

## 這是哪一塊

「在後台自訂前台頁面」的第三個子系統。前兩個是[商品分類](2026-07-28-product-categories-design.md)與[自訂頁面](2026-07-28-pages-and-blocks-design.md)。

| 順序 | 子系統 | 狀態 |
| --- | --- | --- |
| 1 | 商品分類 | 完成 |
| 2 | 頁面 + 區塊骨架 | 完成 |
| 3 | **站台外框（header / footer）+ 選單** | 這份文件 |
| 4 | 其餘區塊（輪播、商城、介紹） | 待議 |
| 5 | 媒體庫 + 作品集 | 待議 |

原本第 3、4 塊分開。**合併了**：header 上最主要的東西就是選單，分開做等於先放一個臨時的扁平連結列，下一塊再換成三層的。那是白做一次。

## header 與 footer 不是區塊

考慮過三種模型：

| | 做法 | 為什麼沒選 |
| --- | --- | --- |
| A | 共用頁面：一組區塊，其他頁面用「插入」區塊引用 | 你會忘記插。不是偶爾，是一定 |
| B | 共用區塊：單一區塊被標記為共用 | 粒度不對。header 是 logo、選單、購物車三四件事，硬塞成一個區塊，它的設定會變成一坨什麼都有的 JSON |
| C | **站台設定**：編輯一次，每頁自動套用 | 選這個 |

參考站每一頁的 header 與 footer 都一樣，從來不會不同。「插入」是頁面建構器的呈現方式，不是真實需求——真實需求是「每頁都有這兩個」。

彈性由**每頁的顯示開關**補上（預設開），所以某一頁想全螢幕、不要 header，仍然做得到。

之後若要共用一段內容（例如「關於我們」同時出現在兩頁），那才是模型 A，屆時再加。那是不同的需求。

## 樣式是有界的旋鈕，不是自由值

這個 codebase 已經回答過一次。[bio_link.py](../backend/src/bio_link.py) 的外觀設定：

> Appearance is chosen from fixed sets, never typed. Nothing an owner enters becomes CSS, so a curated palette can guarantee readable contrast.

沿用同一條規則。自由填色遲早會做出一個自己看得到、客人看不清楚的 header，而且那種錯誤不會在建立當下出現，是在別人的手機上出現。

| 項目 | 可選 |
| --- | --- |
| 背景 | 透明／純色／圖片 |
| 純色與 footer 底色 | 五色調色盤 |
| 背景圖 | 上傳一張，**自動加深色遮罩** |
| 高度、logo 大小 | 小／中／大 |
| 文字色 | 深／淺 |

高度給三個尺寸而不是自由數值：自由數值會讓人花二十分鐘微調一個像素，而且手機上得再調一次。三個尺寸各自在桌機與手機都調校過。

**做不到的事，講清楚**：不能填 hex 色碼、不能把 header 設成 137px、不能上下不對稱的間距。

## 資料模型

新增 migration `0012_create_site_chrome`。

### 站台設定：單列

沿用 `bio_link_settings` 的形狀——`CHECK (id = 1)`，因為站台只有一個。

```sql
site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  header_background TEXT NOT NULL DEFAULT 'solid',   -- transparent | solid | image
  header_colour     TEXT NOT NULL DEFAULT 'cream',
  header_image_key  TEXT,
  header_height     TEXT NOT NULL DEFAULT 'medium',
  header_text       TEXT NOT NULL DEFAULT 'dark',
  header_logo_size  TEXT NOT NULL DEFAULT 'medium',
  header_sticky     INTEGER NOT NULL DEFAULT 1,
  header_show_cart  INTEGER NOT NULL DEFAULT 1,
  header_show_login INTEGER NOT NULL DEFAULT 1,
  header_cta_label  TEXT NOT NULL DEFAULT '',
  header_cta_url    TEXT NOT NULL DEFAULT '',
  footer_colour     TEXT NOT NULL DEFAULT 'ink',
  footer_text       TEXT NOT NULL DEFAULT 'light',
  footer_copyright  TEXT NOT NULL DEFAULT '',
  footer_columns    TEXT NOT NULL DEFAULT '[]',      -- JSON
  footer_socials    TEXT NOT NULL DEFAULT '[]',      -- JSON
  updated_at        INTEGER NOT NULL
)
```

`footer_columns` 與 `footer_socials` 存 JSON，理由與 `page_blocks.config` 相同：整組一起編輯、一起儲存，從不需要在裡面查詢。是設定，不是可查詢的資料。因此驗證做兩次——寫入時擋掉壞的，讀取時擋掉舊版本寫進去的。

形狀：

```jsonc
footer_columns: [{ "title": "客服", "links": [{ "label": "服務條款", "url": "/terms" }] }]
footer_socials: [{ "platform": "instagram", "url": "https://..." }]
```

`platform` 沿用名片頁那組（instagram、facebook、threads、youtube、x、tiktok、line、pixnet、email、website），圖示元件 `shared/components/SocialIcon.tsx` 已經存在。

### 選單：三層

```sql
menu_items (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT,                 -- NULL 代表最上層
  label TEXT NOT NULL,
  target_kind TEXT NOT NULL,      -- page | category | url
  target TEXT NOT NULL,
  position INTEGER NOT NULL
)
```

`target_kind` 決定 `target` 怎麼讀：頁面 id、分類 slug（可以是 `a,b` 這種組合），或一個絕對網址。分成兩欄而不是直接存網址，是為了**頁面改路徑時選單跟著走**——存死網址的話，改一次路徑就要記得回來改選單。

深度上限三層，在驗證時擋：一個項目的祖先鏈超過兩層就拒絕。

### 每頁開關

`pages` 加兩欄：

```sql
show_header INTEGER NOT NULL DEFAULT 1
show_footer INTEGER NOT NULL DEFAULT 1
```

預設開，所以既有頁面不會突然掉外框。

## API

### 公開 — `api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/site` | 外框設定與選單，一次取回 |

一支而不是兩支：每一頁都需要這兩樣，分兩次請求只是讓每個頁面多等一個往返。

選單項目在這裡就解析完成——`target_kind` 是 `page` 時回傳該頁**當下的路徑**，前端不需要知道 id 怎麼變成網址。指向草稿頁或已刪除頁面的項目**不出現在公開回應裡**：一個通往 404 的選單項目比少一個選單項目糟。

### 管理 — `admin-api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET / PUT | `/api/site` | 外框設定 |
| POST | `/api/site/header-image` | 上傳背景圖（multipart） |
| DELETE | `/api/site/header-image` | 移除背景圖 |
| GET / POST | `/api/menu` | 選單項目列表與新增 |
| PUT | `/api/menu/order` | 重新排序與改變層級 |
| PUT / DELETE | `/api/menu/{id}` | 單一項目 |

管理端的選單回應**包含**指向草稿頁的項目，並標記出來——後台看不到的項目就是刪不掉的項目。

## 前台

`SiteHeader` 與 `SiteFooter` 放在 `shared/components/`，與區塊同樣的理由：後台的外觀設定頁要能預覽它們，而預覽必須是同一份程式。

外框套用在**所有**前台頁面上，不只自訂頁——商城、購物車、名片頁都在同一個站台裡。`/checkout` 與 `/orders` 例外，結帳過程中一排導覽連結只會增加中途離開的機會。

背景圖走 R2，前綴 `_site`，公開路徑 `/site-assets/{file}`。與商品照片同樣的做法：key 從資料庫查，不從網址組。

## 後台

外觀設定與選單編輯放在**同一個新分頁「外框」**。它們是一起調的東西——改完選單就會想看看 header 長怎樣。

分頁列會變成六個（名片頁／頁面／外框／ibon 列印／商城／運費）。到了要考慮分組的邊緣，但還沒過。

## 不在這一批

其餘區塊（輪播、相簿、商城、介紹）、媒體庫、作品集。

## 備份

`site_settings` 與 `menu_items` 要加進 `.github/workflows/backup.yml` 的 `TABLES`。
