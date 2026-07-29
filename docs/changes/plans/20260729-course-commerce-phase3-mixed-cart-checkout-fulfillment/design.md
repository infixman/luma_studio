# Phase 3：混合購物車、條件式結帳與履約設計

日期：2026-07-29

## 原始需求

商城必須能正確販售純課程、純實體與課程加材料包：

- 純課程不要求填地址或選物流。
- 只要訂單內有實體品，就需要收件資料與配送方式。
- 實體品扣庫存，課程不使用假庫存。
- 付款成功後才授予課程。
- 混合商品付款後可以立即觀看課程，實體部分繼續等待出貨。
- 付款通知重送、付款逾期與取消不能造成重複授權或錯誤庫存。

## 現況問題

目前購物車逐筆讀取 `product_variants.stock`，所有商品都必須有正數庫存。結帳也固定
要求 `shippingMethod`。訂單只保存 variant 快照，沒有保存展開後要交付的課程或
實體內容。

因此本階段不是在既有流程加幾個 if，而是讓 Cart 與 Order 共用 phase2 的
`resolve_offer`，把交易與履約內容拆開。

## CartQuote 設計

CartQuote 必須同時回傳顧客畫面與結帳所需的伺服器判斷：

```json
{
  "lines": [],
  "problems": [],
  "subtotal": 4980,
  "shippingSubtotal": 3980,
  "requiresShipping": true,
  "containsCourse": true,
  "shipping": []
}
```

### 金額規則

- `subtotal`：所有 Offer 的售價乘數量。
- `shippingSubtotal`：只加總含任何 inventory component 的 Offer line。
- 純課程 Offer 不計入免運門檻。
- 混合 Offer 無法再拆售價，因此整筆 line 計入 shippingSubtotal。
- 運費不由前端計算。

### 數量規則

- 純課程與包含課程的混合 Offer，第一版購買數量上限為 1。
- 純實體 Offer 可以依現有購物車規則購買多件。
- Inventory component 的需求量為 component quantity × cart quantity。
- 同一 InventoryItem 被多個 line 引用時，必須先彙總後再檢查庫存。
- 同一 Course 被多個 line 包含時，付款後只授予一次，但訂單快照保留每個來源。

## 結帳流程

```mermaid
flowchart TD
    A["伺服器重新驗算購物車"] --> B{"是否有問題"}
    B -->|"有"| C["409 回購物車確認"]
    B -->|"無"| D{"requiresShipping"}
    D -->|"否"| E["只驗證會員姓名與 Email"]
    D -->|"是"| F["驗證配送方式與收件資料"]
    E --> G["建立訂單"]
    F --> G
    G --> H["保留所有實體庫存"]
    H --> I["寫入 order_items"]
    I --> J["寫入 order_fulfillments"]
    J --> K["前往付款"]
```

前端送來的 `requiresShipping`、subtotal、運費及 component 清單全部不可信。API 每次
都由 Offer id 重新解析。

## 訂單快照

### `order_items`

保留顧客看到的交易內容：

- Product 與 Offer id。
- 商品與方案名稱。
- 單價、數量、小計。
- 是否含課程、是否需要配送的當下結果。

### `order_fulfillments`

保存每個 component 的當下內容：

| 類型 | 快照 |
| --- | --- |
| course | course id、課程名稱、access days、來源 order item |
| inventory | inventory item id、SKU、名稱、所需數量、出貨狀態 |

後續改動 Offer components 不得重寫這些資料。

## 庫存保留

延續現有「建立訂單時保留、逾時回補」原則，但扣減目標改為 InventoryItem。

```mermaid
stateDiagram-v2
    [*] --> Available
    Available --> Reserved: 建立 pending order
    Reserved --> Sold: 付款成功
    Reserved --> Available: 逾期或取消
    Sold --> Returned: 退款且實體退回
```

D1 沒有互動式長交易，實作使用帶條件的原子 UPDATE：

```sql
UPDATE inventory_items
SET stock = stock - ?quantity
WHERE id = ?id AND enabled = 1 AND stock >= ?quantity;
```

多項內容中途失敗時，必須按已扣清單逐筆補償，與目前 order reserve 的防超賣策略一致。

## 付款與課程授權

```mermaid
sequenceDiagram
    participant Payment as PAYUNi/管理員
    participant OrderSvc as Order Domain
    participant FulfillmentSvc as Fulfillment Service
    participant EntitlementStore as Entitlement Store

    Payment->>OrderSvc: mark paid
    OrderSvc->>OrderSvc: conditional pending to paid
    OrderSvc->>FulfillmentSvc: provision paid order
    FulfillmentSvc->>EntitlementStore: idempotently create course grants
    FulfillmentSvc->>FulfillmentSvc: update digital fulfillment status
```

授權必須可重試。若訂單已標記 paid 但授權步驟失敗，背景 reconciliation 必須找出
`paid + digital fulfillment pending` 並補做，不能只依賴一次付款 callback。

## 配送與地址

| Cart 組成 | 配送 UI | 訂單欄位 |
| --- | --- | --- |
| 全部純課程 | 不顯示 | `shipping_method = none`，地址空 |
| 任一實體 | 顯示 | 使用現有宅配或超商流程 |
| 混合 Offer | 顯示 | 同一訂單同時有 digital 與 physical fulfillment |

會員 profile 中既有地址仍可保存，但純課程結帳不強迫填寫，也不應用空字串覆蓋既有
預設地址。

## 訂單後台

訂單詳情分為：

```text
購買項目
  水彩完整套組 × 1  NT$3,980

數位內容
  水彩花卉入門  已開通

待出貨內容
  水彩材料包 × 1  待出貨
```

只有存在 physical fulfillment 的訂單才能進入 shipped。純數位訂單付款且授權成功後
可直接 completed，或由系統自動完成；實際策略需在 phase0 決策中定案。

## 錯誤與補償

| 失敗點 | 處理 |
| --- | --- |
| 一項庫存不足 | 回補先前已保留項目，訂單不建立成功 |
| 寫 order_items 失敗 | 回補所有保留庫存 |
| 寫 fulfillment 失敗 | 不得留下可付款的半成品訂單 |
| 付款成功後授權失敗 | 訂單維持 paid，標記 pending 並重試 |
| 重複付款通知 | mark_paid 不重複轉移；provision 可安全重跑 |
| pending 逾期 | 只回補 physical fulfillment |
| entitlement 已存在 | 視為成功，不延長期限，除非方案明確定義累加 |

## 本階段不做

- 不提供影片上傳或播放。
- 不公開完整課程頁。
- 不支援贈送課程與多人席次。
- 不做部分出貨、多包裹或拆單。
- 不做自動退款；只定義授權與庫存的後續接口。
