# Phase 3 規格：Cart、Checkout、Order 與 Fulfillment

## 目標

將商城交易流程改為依 Offer components 驗算，使純課程、實體與混合商品共享同一個
Cart、Checkout 與 Order 管線。

## 資料庫規格

### `order_items` additive 欄位

建議增加：

| 欄位 | 說明 |
| --- | --- |
| `product_id` | 商品 id 快照來源 |
| `offer_id` | 可購買方案 id；過渡期可沿用 variant_id |
| `requires_shipping` | 建立訂單時衍生結果 |
| `contains_course` | 建立訂單時衍生結果 |

既有 `variant_id` 在相容期保留。不可用目前 Product/Offer 狀態重算歷史欄位。

### `order_fulfillments`

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `id` | TEXT PK | 履約 id |
| `order_id` | TEXT | 訂單 |
| `order_item_id` | TEXT | 來源 line |
| `fulfillment_type` | TEXT | `course` / `inventory` |
| `target_id` | TEXT | Course 或 InventoryItem |
| `target_title` | TEXT | 不可變快照 |
| `sku` | TEXT | 實體快照，可空 |
| `quantity` | INTEGER | 實體數量；課程固定 1 |
| `access_days` | INTEGER NULL | 課程期限 |
| `status` | TEXT | pending/ready/fulfilled/cancelled |
| `created_at` / `updated_at` | INTEGER | 時間 |

索引：

- `(order_id, fulfillment_type, status)`
- `(target_id, fulfillment_type)`
- unique course provision key依 entitlement 規格

### `course_entitlements`

| 欄位 | 說明 |
| --- | --- |
| `id` | PK |
| `customer_id` | 會員 |
| `course_id` | 課程 |
| `source_order_item_id` | 來源 |
| `granted_at` | 生效 |
| `expires_at` | NULL 為永久 |
| `revoked_at` | NULL 為有效 |
| `revoke_reason` | 管理與稽核 |

## Cart Domain

### 輸入相容

過渡期接受：

```json
{"variantId": "id", "quantity": 1}
```

新版可改用：

```json
{"offerId": "id", "quantity": 1}
```

服務端先正規化為 Offer id。若 request 同時提供兩者且不同，回 400。

### 驗算演算法

1. 合併相同 Offer 的數量。
2. 讀取 active Product 與 enabled Offer。
3. 使用 `resolve_offer` 展開 components。
4. 驗證含 course 的 Offer 數量上限。
5. 彙總每個 InventoryItem 所需總量。
6. 一次讀取庫存並產生 per-line 或 cart-level problem。
7. 計算 subtotal、shippingSubtotal 與能力旗標。
8. 只有 requiresShipping 時回傳 shipping options。

Problem reason 至少包含：

```text
unavailable
out_of_stock
reduced
quantity_not_allowed
component_unavailable
```

## Checkout API

### Request

純數位：

```json
{
  "lines": [],
  "recipientName": "姓名",
  "recipientEmail": "mail@example.com"
}
```

需要配送：

```json
{
  "lines": [],
  "shippingMethod": "home",
  "recipientName": "姓名",
  "recipientPhone": "0900000000",
  "recipientEmail": "mail@example.com",
  "address": "地址"
}
```

### 驗證

- 所有訂單都需要登入會員與有效 email。
- 純數位不要求 shippingMethod、phone、address。
- 宅配要求 phone 與 address。
- 超商依既有門市流程要求 store 資料。
- API 忽略或拒絕 client 提交的 subtotal、shippingFee、requiresShipping。

### Response

回傳 Order、OrderItems、能力旗標與下一步付款資料。純數位訂單的 shipping label 應為
「無需配送」，不能顯示空白或 `—` 讓會員誤以為資料遺失。

## Order Domain

### 建立順序

1. 重新取得 CartQuote。
2. 彙總並保留 InventoryItem。
3. 建立 Order。
4. 建立 OrderItems。
5. 建立 OrderFulfillments。
6. 寫 audit。
7. 回傳可付款訂單。

任何步驟失敗都要回補已保留庫存。不可讓缺少 fulfillment 的 pending order 進入付款。

### 付款 Provision

`mark_paid` 成功後呼叫：

```text
provision_paid_order(order_id)
```

此函式：

- 查詢 course fulfillment。
- 以 order customer 建立 entitlement。
- 計算 `expires_at = paid_at + access_days`。
- 永久授權使用 NULL。
- 每筆成功後更新 fulfillment status。
- 全部成功才將 digital fulfillment 視為完成。

需要一個 reconciliation 入口供排程或管理員重試 paid 訂單中的 pending digital
fulfillment。

## 公開前端

### CartPage

- 顯示「此購物車包含數位課程」提示。
- 只有 `requiresShipping` 才顯示配送選項與費用。
- 課程或混合 Offer 不顯示可大於 1 的數量輸入。
- component unavailable 需指出受影響商品。

### CheckoutPage

- 純課程：姓名、Email、付款摘要。
- 有實體：沿用收件人、電話、配送方式與地址／門市。
- 從 quote 決定表單，不從 Product 標籤判斷。
- quote 改變時重新驗證目前配送選擇。

### OrderPage

- 顯示數位與實體履約摘要。
- 純數位不顯示空的配送卡。
- 付款後提供「前往我的課程」，phase6 完成前由 feature flag 隱藏。

## 管理前端

- Order detail 分離 purchase lines、digital fulfillment、physical fulfillment。
- 純數位訂單不提供「標記出貨」。
- 課程授權失敗顯示可重試狀態。
- 實體履約保留現有 shipped/completed 操作。

## 測試矩陣

| 情境 | 配送 | 庫存 | Entitlement |
| --- | --- | --- | --- |
| 純實體 | 必須 | 保留／扣減 | 無 |
| 純課程 | 不需要 | 不動 | paid 後建立 |
| 混合 | 必須 | 只扣實體 | paid 後建立 |
| 多課程 | 不需要 | 不動 | 每門一筆 |
| 課程＋獨立實體 line | 必須 | 只扣實體 | paid 後建立 |

另測：

- 同 InventoryItem 跨兩個 line 的總量不足。
- 建立訂單中途失敗的回補。
- pending 逾期。
- 付款通知重送。
- paid 後 entitlement 寫入失敗及 reconciliation。
- 商品或 component 在 cart 與 checkout 間被停用。

## 驗收標準

- 純課程結帳完全不要求配送。
- 有任何實體 component 時不能繞過收件驗證。
- 庫存只存在 InventoryItem 一個權威來源。
- 訂單內容在 Offer 後續變更後保持不變。
- 付款成功與 entitlement 最終一致。
- phase6 完成前，課程 Offer 保持 draft 或 feature flag 關閉。
