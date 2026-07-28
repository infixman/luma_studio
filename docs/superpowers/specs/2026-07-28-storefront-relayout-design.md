# 前台版面重整 — 修掉重複的外框，並改用蝦皮那種「卡片式」排版

2026-07-28

## 起因

商城頁上同時看得到兩個 LOGO、兩個購物車連結，頁首的「登入」和「購物車」還沒對齊；`/orders`
則整頁沒有頁首。三件事看起來像三個獨立的版面問題，實際上是同一件事的三種症狀：**站台外框
（`SiteHeader`）是後來才加的，而在它之前每一頁都自己畫了一份頁首。**

### 沒對齊的真正原因

不是 flex 沒設好。頁首的購物車連結是 `class="action cart"`（[SiteChrome.tsx](../../../frontend/src/shared/components/SiteChrome.tsx)），
而 `shop.css` 裡的 `.cart` 是**購物車「頁面」的容器**：

```css
.cart { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1.1rem 4rem; }
```

每一頁的 CSS 都進同一個 bundle，所以頁首那個連結吃到了頁面容器的 padding。線上量到的結果是
「登入」高 20.7px、「購物車」高 108.7px（撐滿整個頁首）。

`shop.css` 開頭寫著每頁樣式靠 body class 隔開，但只有 `body.cart { background }` 這種規則照做了，
`.shop` / `.product` / `.cart` 這三個容器選擇器是全域的。這次把它們收成 `main.shop` 之類，
根因才不會換個地方再長出來。

## 決定

### 1. 頁首只有一份，頁面不再自己畫

`ShopPage`、`CategoryPage` 的 `shop-head`（LOGO + 購物車）與 `ProductPage` crumb 裡的購物車連結全部刪掉，
`CartLink.tsx` 一併移除——它只剩這三個呼叫點。頁面只留自己的標題。

`isBare()` 拿掉 `/orders` 與 `/orders/*`：訂單頁不是結帳流程，客人在那裡本來就是在逛，
把導覽藏起來沒有理由。`/checkout` 維持無外框（付款途中不該提供離開的路），`/card`、`/ibon_print/*` 也是。

頁首回來之後，`OrdersPage` 的「← 商品列表」是重複的，刪。訂單詳情頁保留一個返回連結——
那是回上一層清單，不是回首頁，頁首取代不了。

### 2. 購物車改成 icon ＋ 浮起來的數量泡泡

文字「購物車」換成線條購物車圖示，數量做成絕對定位的圓形徽章疊在圖示右上角。
`aria-label` 帶出「購物車，N 件」，所以讀螢幕的人拿到的資訊沒有變少。

頁首那個連結的 class 從 `cart` 改為 `cart-action`，跟頁面容器不再撞名。

### 3. 版面參考蝦皮

參考的是**排版**，不是配色。蝦皮的橘紅套在苒光繪誌的暖米色上會打架，所以沿用站上既有的
暖色系，只把「價格／主要動作」這個角色獨立成一個 accent 色。

蝦皮排版真正值得抄的是三件事：

- **一筆訂單就是一張白卡**，卡內由上到下是「賣場列 → 品項列 → 金額列 → 動作列」，卡與卡之間用底色隔開，
  而不是靠框線。目前的訂單列表是一列一行文字，掃不出來哪筆是哪筆。
- **狀態是分頁籤，不是每列一個標籤**。全部／等待付款／已出貨…，客人找「那筆還沒到的」是用狀態找的。
- **金額永遠靠右、同一欄對齊**，小計／運費／總計是右對齊的三行，總計放大。

套用範圍：訂單列表、訂單詳情、商城列表、商品頁、購物車。

購物車**只改視覺**。蝦皮購物車那種「勾選部分商品結帳」是功能，不在這次範圍。

### 4. 訂單卡片需要品項與圖，後端得先給

`/api/orders` 現在只回訂單摘要，沒有品項；`order_items` 也只有標題快照，沒有商品圖。
沒有這兩樣就做不出蝦皮那種卡片。

不加資料表欄位。`order_items` 留著 `variant_id`，順著它 join 回 `products` 與 `product_images`
就拿得到 slug 與封面圖：

```sql
SELECT oi.*, p.slug AS product_slug,
       (SELECT r2_key FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS cover_key
FROM order_items oi
LEFT JOIN product_variants pv ON pv.id = oi.variant_id
LEFT JOIN products p ON p.id = pv.product_id
WHERE oi.order_id IN (SELECT id FROM orders WHERE customer_id = ?1)
```

一次查詢拿完整份清單的品項，不是每筆訂單各查一次。

三個 LEFT JOIN 是刻意的：商品可以被刪除，被刪掉的商品其訂單仍然要看得到——**標題與價格是下單當下的
快照，圖片是現在的**。這不是不一致，是兩種東西：收據上的字不能被改名改價追溯竄改，
而縮圖只是幫人認出「喔是那個」，沒有圖就留空位。

`OrderItem` 因此多了 `slug` 與 `coverPath`，兩者都可為 null。列表回的型別是
`OrderCard`（`Order` 加上 `items`），管理端的 `Order`／`AdminOrder` 不動。

## 沒有做的事

- `HomePage` 也有自己的 LOGO（連到 `/admin` 的那道暗門），套上頁首後同樣是兩個 LOGO。
  沒有一併處理，因為刪掉它等於拿掉唯一的管理入口，該怎麼換得另外決定。
- 購物車的部分結帳、訂單的「再買一次」「聯絡賣家」——蝦皮有，這裡沒有對應功能，不畫空按鈕。
