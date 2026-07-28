# 自訂頁面與區塊

日期：2026-07-28

## 這是哪一塊

「在後台自訂前台頁面」的第二個子系統。第一個是[商品分類](2026-07-28-product-categories-design.md)。

| 順序 | 子系統 | 狀態 |
| --- | --- | --- |
| 1 | 商品分類 | 完成 |
| 2 | **頁面 + 區塊骨架** | 這份文件 |
| 3 | 共用 header / footer | 完成 |
| 4 | 選單編輯器（三層） | 完成，與 3 同一批 |
| 5 | 媒體庫 | 完成，提前到區塊之前 |
| 6 | 其餘區塊（輪播、相簿、商城、介紹） | 完成 |
| 7 | 作品集 | 待議 |

第 5 與第 6 對調：輪播和相簿沒有圖片來源就是空的，而這份文件自己也寫過「先做輪播就得同時發明圖片管理」。所以媒體庫先做，區塊接上它。

**目標是把整條路打通，不是把區塊做齊。** 頁面 → 路由 → 區塊 → 渲染 → 後台編輯，全部跑起來，而區塊只做一種：純文字。之後每加一種區塊都是重複同一個模式，風險小得多。反過來先做輪播圖，就得同時發明頁面系統、區塊系統與圖片管理三件事。

## 決定

### 首頁由「設為首頁」旗標接管

某一頁勾了就接管 `/`。比讓人把 path 填成 `/` 清楚：後者「為什麼這頁特別」靠的是一個字串巧合，而且不小心建兩個時沒有明確規則可以擋。

只有一頁能是首頁，由**部分唯一索引**保證：

```sql
CREATE UNIQUE INDEX idx_pages_home ON pages (is_home) WHERE is_home = 1
```

資料庫層的保證，不是「應用程式記得要先清掉別人」。

沒有任何一頁勾首頁時，`/` 落回目前寫死的 HomePage。這也是升級路徑：頁面系統上線後首頁不會突然變空白。

### 草稿預覽在後台，不在前台

店主要能先看草稿長什麼樣。但**前台 Worker 認不出店主**——管理者的 cookie 是 host-only 綁在 `admin-api.luma-studio.tw`，前台只認得顧客 session。那是刻意建立的隔離，不會為了預覽打開。

考慮過的替代方案是預覽權杖（`/about?preview=xxx`，公開 API 認 token）。**沒有採用**：那會在公開 API 上多一條會回傳草稿的路徑，而那裡出一次錯就是草稿外流。

改成**區塊的渲染元件放在 `shared/`，前台與後台用同一份**，編輯器旁邊直接渲染。草稿完全不離開後台，公開 API 完全不知道草稿存在。附帶好處：編輯器裡看到的就是前台會長出來的樣子，因為那真的是同一段程式。

公開端對草稿一律 404。

### 純文字區塊用 Markdown，在前端轉換

服務條款與退換貨政策需要標題與清單，純文字寫起來會很痛苦。富文本編輯器會把任意 HTML 存進資料庫，過濾寫錯就是 XSS。

Markdown 折中，而且轉換放在前端（`shared/markdown.ts`）：

- **先把整段輸入逃脫，再套用 Markdown 規則。** 因為先逃脫過，原始碼裡的 `<script>` 永遠不可能變成標籤——安全性來自順序，不是來自一份要維護的黑名單
- 只支援標題、段落、粗體、斜體、連結、有序與無序清單
- 放在前端而不是 Python：後台預覽與前台渲染是同一份實作，兩者不可能對同一段 Markdown 產生不同結果

連結只接受 `http`、`https` 與 `mailto`。`javascript:` 開頭的連結會被丟掉。

## 資料模型

新增 migration `0011_create_pages`。

```sql
pages (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,                   -- '/about'，UNIQUE
  title TEXT NOT NULL,                  -- <title> 與後台清單的名字
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published
  is_home INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

page_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL,
  type TEXT NOT NULL,                   -- 這一批只有 'text'
  config TEXT NOT NULL,                 -- JSON
  position INTEGER NOT NULL
)
```

`config` 是 JSON 字串而不是每種區塊一張表。每種區塊的欄位差異很大，而我們從不需要在區塊內容裡做查詢——存的是設定，不是可查詢的資料。代價是資料庫層沒有結構驗證，所以驗證在 Python 依 `type` 分派，而且**讀出來時也要驗**：舊版本寫進去的設定不能讓頁面爆掉。

## 路徑

正規化：小寫、開頭一個斜線、結尾不留斜線、每段只允許 `[a-z0-9-]`。

**保留路徑。** 下列前綴不能被頁面佔用：

```
/shop  /cart  /checkout  /orders  /card  /ibon_print
/admin  /api  /images  /r  /shop-assets  /bio-link-assets  /assets
```

不擋的話，建一個 path 是 `/shop` 的頁面就會蓋掉整個商城，而且是安靜地蓋掉。

## API

### 公開 — `api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/pages/home` | 目前設為首頁的那一頁，沒有就 404 |
| GET | `/api/pages?path=/about` | 依路徑取頁面與其區塊。只有 `published` 解得開 |

路徑用 query 參數而不是路徑參數：頁面路徑本身帶斜線，塞進 `/api/pages/about/team` 會需要在兩端各做一次拼接與拆解。

### 管理 — `admin-api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET / POST | `/api/pages` | 列表與新增 |
| GET / PUT / DELETE | `/api/pages/{id}` | 單一頁面與其區塊 |
| PUT | `/api/pages/order` | 排序，必須排在 `{id}` 路由之前 |
| POST | `/api/pages/{id}/blocks` | 新增區塊 |
| PUT | `/api/pages/{id}/blocks/order` | 區塊排序 |
| PUT / DELETE | `/api/blocks/{id}` | 單一區塊 |

## 前台路由

目前不認得的路徑會落到「這個網址沒有對應的頁面」。改成先問 API 有沒有這個頁面：找到就渲染，沒找到才顯示原本的訊息。

每個 404 因此多一次 API 呼叫。可接受——404 本來就不該是熱路徑，而替代方案是把所有頁面路徑塞進 bundle，那會讓每次新增頁面都需要重新部署。

`/` 先問 `/api/pages/home`；沒有設為首頁的頁面時，落回寫死的 HomePage。

## 後台

新增第五個分頁「頁面」。先前為了避免分頁列變長，把分類塞進商城頁；頁面不一樣——它是獨立的東西，不是任何現有頁的屬性。

- 頁面清單：新增、改路徑、公開／草稿、設為首頁、排序、刪除
- 頁面編輯器：加區塊、排序、刪除，以及右側的即時預覽

## 不在這一批

其餘區塊（輪播、相簿、商城、介紹、header、footer）、選單編輯器、共用組件、媒體庫。骨架先通。

## 備份

`pages` 與 `page_blocks` 要加進 `.github/workflows/backup.yml` 的 `TABLES`。缺表檢查照同一個變數迭代，漏掉的表不會被抓到。
