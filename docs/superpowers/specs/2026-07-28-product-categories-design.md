# 商品分類

日期：2026-07-28

## 這是哪一塊

店主想要一套可在後台自訂前台頁面的系統：新增頁面與路徑、自訂多層選單、每頁由多個區塊組成（輪播、商城、介紹、純文字、header、footer、作品集），header 與 footer 可共用。參考站是 [gusartstudio.com](https://gusartstudio.com/)。

那不是一個功能，是六個子系統。這份文件只涵蓋**第一個**：

| 順序 | 子系統 | 狀態 |
| --- | --- | --- |
| 1 | **商品分類** | 這份文件 |
| 2 | 頁面 + 區塊骨架（先只做純文字區塊） | 待議 |
| 3 | 共用 header / footer | 待議 |
| 4 | 選單編輯器（三層） | 待議 |
| 5 | 其餘區塊（輪播、商城、介紹） | 待議 |
| 6 | 媒體庫 + 作品集 | 待議 |

分類排第一，因為選單項目和商城區塊都要指向它。沒有分類，那兩者做不出參考站的樣子。

## 從參考站讀到的

- 選單是三層：課程介紹 → 療癒材料包 → 奶油雕花
- 選單項目幾乎都指向商品分類頁（`/shop-category/art-kits/`）
- **同一個商品出現在多個區塊**——「奶油雕花砂肌理畫實體創業班」同時在「創業班｜證照班」和「奶油雕花肌理畫課程」底下。這是多對多的證據
- 「風水畫廊」不是相簿，是有標題、標籤、日期與內頁的作品集。列在第 6 塊

## 決定

**扁平，不做階層。** 分類像 tag。

因此**選單的層次與分類無關**：三層選單是店主在選單編輯器裡自己疊的，每一項指向一個分類頁。這比參考站更自由——選單想怎麼分組就怎麼分組，不被分類結構綁住——但那是兩件獨立的事，不會互相長出來。

**多對多。** 一張 join 表。成本比單一分類欄位高不了多少，而參考站已經證明需要。

**分類有自己的網址。** 選單可以直接連過去，不必為每個分類手動建一個自訂頁。

## 資料模型

新增 migration `0010_create_product_categories`。

```sql
product_categories (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,                     -- UNIQUE，網址用
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',   -- 單一分類頁最上方的一段說明
  position INTEGER NOT NULL,              -- 後台排序，也是前台籤列順序
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

product_category_links (
  product_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY (product_id, category_id)
)
```

主鍵 `(product_id, category_id)` 服務「這個商品有哪些分類」。反方向——「這個分類有哪些商品」，也就是分類頁真正要問的——需要另一個 `(category_id, product_id)` 索引，否則得掃全表。

`slug` 沿用 `shop.validate_slug`：小寫、數字、單一連字號，不可頭尾。與商品 slug 同一組規則，店主不用記兩套。

## 網址

分類頁支援多個 slug，並以分隔符號表示運算子：

| 網址 | 意思 |
| --- | --- |
| `/shop/c/candles` | 這個分類 |
| `/shop/c/candles,art-kits` | 任一（OR） |
| `/shop/c/candles+gift` | 兩者皆是（AND） |

`/c/` 這一段是刻意的：分類 slug 與商品 slug（`/shop/{slug}`）從此不可能相撞。

`+` 在 path 中是字面字元——只有在 query string 裡才代表空格——逗號在 path 中也合法。兩者都不需要跳脫。

**不支援混用。** `a,b+c` 一旦允許，就得定義優先順序、寫解析器，並在後台介面上讓店主表達那個優先順序。那不是篩選，是查詢語言。遇到混用回 404。

**上限五個 slug。** 沒有上限的話，一個手工構造、帶兩百個 slug 的網址就是一次大查詢。速率限制擋得住持續濫用，但上限更便宜也更明確。

### 同一組 tag 的多個網址

`/shop/c/a,b` 與 `/shop/c/b,a` 是同一批商品的兩個網址。程式產生連結時一律排序 slug；手打的亂序仍然可用。

現在整站是 `noindex`，重複網址沒有代價。**決定讓商城被收錄時**，這裡要補 canonical 標籤或在 Worker 做 301。記在 backlog，現在不做。

## 查詢

```sql
-- OR：任一
SELECT DISTINCT p.* FROM products p
  JOIN product_category_links l ON l.product_id = p.id
  WHERE p.status = 'active' AND l.category_id IN (...)

-- AND：全部
SELECT p.* FROM products p
  JOIN product_category_links l ON l.product_id = p.id
  WHERE p.status = 'active' AND l.category_id IN (...)
  GROUP BY p.id HAVING COUNT(DISTINCT l.category_id) = ?
```

AND 用 `COUNT(DISTINCT ...)` 而不是 `COUNT(*)`：主鍵理論上擋住了重複連結，但一個依賴主鍵才正確的計數，會在主鍵哪天變動時安靜地開始放行不該通過的商品。

**這個篩選器會被用兩次。** 之後自訂頁的商城區塊要的正是同一件事：選幾個分類、選 AND 或 OR。所以篩選寫成一個函式，區塊設定存 `{categoryIds, mode}`，網址解析出來的也是同一組值。分類頁與商城區塊不會各算各的。

## API

### 公開 — `api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/categories` | 分類清單，含上架商品數量 |
| GET | `/api/categories/{slugs}` | 分類（或組合）與其上架商品 |

### 管理 — `admin-api.luma-studio.tw`

| Method | Path | 說明 |
| --- | --- | --- |
| GET / POST | `/api/categories` | 列表與新增 |
| PUT / DELETE | `/api/categories/{id}` | 編輯與刪除 |
| PUT | `/api/categories/order` | 排序，必須排在 `{id}` 路由之前 |

商品的分類歸屬**不另開端點**，併進現有的 `PUT /api/products/{id}`，多帶一個 `categoryIds`。分類與商品一起存，不會出現「商品存好了但分類沒存到」的半套狀態。

## 規則

**分類頁只顯示 `active` 商品**，數量也只算 `active`。與 `/shop` 同一條規則：草稿被人從分類頁看到，跟被人猜中 slug 看到是同一個問題。

**空分類仍有頁面**，顯示「這個分類還沒有商品」。不回 404——店主可能正要往裡面放東西，而 404 會讓人以為分類建壞了。

**刪除分類只斷連結，不動商品。** 分類是貼在商品上的標籤，撕掉標籤不該把東西丟掉。

## 標題與說明

單一分類用自己的 `title` 與 `description`。組合沒有現成標題，因此：

- OR → 「分類A、分類B」
- AND → 「分類A ＋ 分類B」
- 說明不顯示——沒有哪一個分類的說明適用於組合

## 前台

- `/shop` 商品列表上方加一排分類籤
- `/shop/c/{slugs}` 分類頁：標題、說明（單一時）、商品格
- `/shop/{slug}` 商品頁顯示所屬分類，可點回

## 後台

**不加第五個分頁。** 選單已有四個（名片頁／ibon 列印／商城／運費），再加會開始難掃。

- 分類的新增、改名、排序、刪除 → **商城頁的第二張卡片**
- 商品的分類勾選 → **商品編輯頁**

分類是商品的屬性，跟商品放在一起比另開一頁合理。

## 備份

`product_categories` 與 `product_category_links` 要加進 `.github/workflows/backup.yml` 的 `TABLES`。缺表檢查照同一個變數迭代，漏掉的表不會被抓到——備份會照常成功。
