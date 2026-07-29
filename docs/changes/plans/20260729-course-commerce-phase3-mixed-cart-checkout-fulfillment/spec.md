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

存取身份為 `(customer_id, course_id)`，unique。同一會員同一門課只有一筆。

| 欄位 | 說明 |
| --- | --- |
| `id` | PK |
| `customer_id` | 會員 |
| `course_id` | 課程 |
| `granted_at` | 生效 |
| `access_days` | NULL 為永久；正整數為首次觀看後的天數 |
| `first_viewed_at` | 期限型第一次成功取得播放授權的時間；NULL 表示尚未啟動 |
| `expires_at` | NULL 為永久或尚未啟動；由 `first_viewed_at + access_days` 導出 |
| `revoked_at` | NULL 為有效 |
| `revoke_reason` | 管理與稽核 |

`expires_at` 不在付款時計算。provision 只寫入 `access_days`；期限倒數由 phase6 的
播放授權以條件 UPDATE 啟動一次，不得重設。

### `course_entitlement_sources`

每一個授與來源各一筆，供稽核與退款撤銷。

| 欄位 | 說明 |
| --- | --- |
| `entitlement_id` | 對應 entitlement |
| `source_kind` | `purchase` / `manual` / `gift` |
| `source_order_fulfillment_id` | 購買來源；manual/gift 為 NULL |
| `actor` | manual/gift 的操作者 |
| `reason` | manual/gift 必填 |
| `revoked_at` / `revoked_by` / `revoke_reason` | 撤銷紀錄 |
| `created_at` | 建立時間 |

unique `(source_kind, source_order_fulfillment_id)`，此唯一鍵即付款事件的 provision key。
manual/gift 不可偽造 order fulfillment。

### `course_offer_purchase_locks`

阻止同一會員重複購買已擁有的 Course。

| 欄位 | 說明 |
| --- | --- |
| `customer_id` | 會員 |
| `offer_id` | 方案 |
| `order_id` | 目前佔用的訂單 |
| `state` | `pending` / `paid` |
| `expires_at` | pending 的保留到期時間 |
| `created_at` / `updated_at` | 時間 |

unique `(customer_id, offer_id)`。pending 取消或逾期即釋放；paid 保留到 entitlement
到期或所有相關 source 撤銷。

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
4. 驗證含 course 的 Offer 數量固定為 1。
5. 對登入會員檢查每個 course component 是否已有 active entitlement，或同 Offer 是否已有未過期 pending lock。
6. 彙總每個 InventoryItem 所需總量。
7. 一次讀取庫存並產生 per-line 或 cart-level problem。
8. 計算 subtotal、shippingSubtotal 與能力旗標。
9. 只有 requiresShipping 時回傳 shipping options。

`shippingSubtotal` 只加總 `requiresShipping=true` 的 line subtotal；混合 Offer 以整筆
售價計入免運門檻，純數位 Offer 不計入。

Problem reason 至少包含：

```text
unavailable
out_of_stock
reduced
quantity_not_allowed
component_unavailable
already_owned
purchase_in_progress
```

`already_owned` 表示會員對該 Offer 的某個 course component 已有有效 entitlement；
`purchase_in_progress` 表示同 Offer 已有未過期的 pending 訂單。兩者都不是庫存問題，
訊息必須指向「已擁有／訂單處理中」而非「售完」。未登入時不做此檢查，改由 checkout
取得 lock 時攔截。

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
- 含 Course 的 line 必須先取得 `course_offer_purchase_locks` 的 `(customer_id, offer_id)`
  pending lock，再檢查各 component Course 的 active entitlement。取不到 lock 或已擁有
  時回 409，不建立訂單。

### Response

回傳 Order、OrderItems、能力旗標與下一步付款資料。純數位訂單的 shipping label 應為
「無需配送」，不能顯示空白或 `—` 讓會員誤以為資料遺失。

## Order Domain

### 建立順序

1. 重新取得 CartQuote。
2. 取得所有含 Course line 的 purchase lock，並複查 active entitlement。
3. 彙總並保留 InventoryItem。
4. 建立 Order。
5. 建立 OrderItems。
6. 建立 OrderFulfillments。
7. 寫 audit。
8. 回傳可付款訂單。

任何步驟失敗都要回補已保留庫存並釋放已取得的 purchase lock。不可讓缺少 fulfillment
的 pending order 進入付款。lock 與庫存採同一套「記錄成功清單、失敗逐筆補償」策略。

### 付款 Provision

`mark_paid` 成功後呼叫：

```text
provision_paid_order(order_id)
```

此函式：

- 查詢 course fulfillment。
- 以 order customer upsert `(customer_id, course_id)` entitlement。
- 寫入 fulfillment 快照的 `access_days`；NULL 為永久。
- **不**計算 `expires_at`。期限倒數由 phase6 首次播放授權啟動，重送 callback 或重播都不得延長。
- 以 `INSERT OR IGNORE` 建立 `course_entitlement_sources`，unique key 為
  `(source_kind='purchase', source_order_fulfillment_id)`；成功或已存在都視為該筆 provision 成功。
- 每筆成功後更新 fulfillment status。
- 全部成功才將 digital fulfillment 視為完成。
- 將該 Offer 的 purchase lock 由 pending 轉為 paid。

需要一個 reconciliation 入口供排程或管理員重試 paid 訂單中的 pending digital
fulfillment。

### 純數位訂單自動完成

所有 digital fulfillment 與 entitlement provision 成功，且訂單沒有任何 physical
fulfillment 時，`orders.status` 直接由 `paid` 轉 `completed` 並寫 audit。任何 provision
失敗都保持 `paid` 等待重試，不得先轉 completed 再補授權。混合訂單不套用此轉移：
課程在 paid 後立即授權，實體部分仍走 `shipped -> completed`。

### 退款與撤銷

- 全額退款、已付款取消、確認 chargeback：撤銷該 order 所有 course fulfillment 對應的
  `course_entitlement_sources`（寫 `revoked_at/revoked_by/revoke_reason`）。
- 僅在該 entitlement 已無其他未撤銷 source 時，才寫 entitlement 的 `revoked_at/revoke_reason`。
- 撤銷只收回 Course／Lesson 存取與影片播放授權；不刪除 Course、Lesson、影片、觀看進度、
  訂單或 audit。
- 只退實體 component 時不得撤銷任何 course source。
- 部分退款必須由呼叫端明確指定受影響的 course fulfillment，不可由訂單金額推測。
- 撤銷後釋放對應的 purchase lock，使會員可以重新購買。

phase3 只需提供上述 domain API 與 audit；完整營運 UI 在 phase7。

## 公開前端

### CartPage

- 顯示「此購物車包含數位課程」提示。
- 只有 `requiresShipping` 才顯示配送選項與費用。
- 課程或混合 Offer 固定數量 1，不顯示數量輸入。
- component unavailable 需指出受影響商品。
- `already_owned` 顯示「你已擁有這門課程」並提供前往我的課程；`purchase_in_progress`
  顯示「已有處理中的訂單」並連到該訂單。兩者都不可顯示為售完。

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
- 建立訂單中途失敗的回補（庫存與 purchase lock 都要釋放）。
- pending 逾期釋放庫存與 lock。
- 付款通知重送。
- paid 後 entitlement 寫入失敗及 reconciliation。
- 商品或 component 在 cart 與 checkout 間被停用。
- 已擁有該 Course 時 cart 回 `already_owned`、checkout 回 409。
- 同 Offer 已有 pending 訂單時第二次 checkout 被 lock 擋下。
- 兩個併發 checkout 只有一個取得 lock。
- provision 只寫 `access_days`，`expires_at` 與 `first_viewed_at` 維持 NULL。
- 重送付款 callback 不新增第二筆 source、不改動 entitlement 期限。
- 純數位訂單全部 provision 成功後自動 `completed`；provision 失敗保持 `paid`。
- 混合訂單 paid 後課程已授權但仍為待出貨，不自動 completed。
- 全額退款撤銷 source；同 Course 另有有效 source 時 entitlement 不被撤銷。
- 只退實體 component 不影響 course source。
- 撤銷後釋放 lock，會員可重新購買。

## 驗收標準

- 純課程結帳完全不要求配送。
- 有任何實體 component 時不能繞過收件驗證。
- 庫存只存在 InventoryItem 一個權威來源。
- 訂單內容在 Offer 後續變更後保持不變。
- 付款成功與 entitlement 最終一致。
- 已擁有的 Course 無法重複購買，且併發結帳不會產生兩筆付款。
- 期限型授權在 phase3 結束時仍未啟動倒數；`expires_at` 由 phase6 首次播放寫入。
- 純數位訂單付款並授權成功後自動 completed，混合訂單不會被誤判完成。
- 退款撤銷可稽核、可還原（restore 在 phase7），且不刪除觀看進度。
- phase6 完成前，課程 Offer 保持 draft 或 feature flag 關閉。
