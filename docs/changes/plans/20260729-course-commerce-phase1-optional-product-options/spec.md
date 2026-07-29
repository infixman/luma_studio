# Phase 1 規格：商品規格選配

## 目標

讓管理員在不手動建立規格的情況下完成單一商品建立與販售，同時保留現有
`variantId` 購物車及多規格商品的相容性。

## 後端規格

### Migration

- `product_variants` 增加 `is_default INTEGER NOT NULL DEFAULT 0`。
- 建立 partial unique index 或由 API 保證每商品最多一筆 default。
- 對只有一筆 variant 的既有商品標記為 default。
- 多筆 variant 的既有商品全部維持公開方案，不自動猜測哪筆是 default。
- 不搬移 `price`、`sku`、`stock`；phase2 才處理 inventory。

### 建立商品

管理端建立商品 request 增加：

```text
price: integer
sku: string
trackStock: boolean
stock: integer
```

API 建立 Product 後立即建立 default Offer。回應必須包含兩者。建立中任何一步失敗，
不得回傳成功。

### 更新單一商品

`PUT /api/products/{id}` 更新 Product 展示欄位；銷售欄位可以：

1. 同一 request 內提供並由 service 同時更新 default Offer；或
2. 使用明確的 `/offers/{id}` endpoint。

介面雖然顯示在同一頁，領域函式仍要分開驗證 Product 與 Offer。

### 公開商品

Public product response 必須提供：

- `requiresOfferSelection`
- 可購買 Offer 清單
- 單一 default Offer 的 title 回傳 `null` 或省略
- 不回傳 `is_default` 的內部實作細節也可以，但不得靠文案判斷

## 前端規格

### 管理端

- ProductCreatePage 預設呈現一組「銷售資訊」。
- ProductEditPage 單一模式編輯 default Offer。
- 只有多方案時才呈現方案列表。
- 「增加規格選項」需要清楚說明會把目前價格轉成第一個方案。
- 儲存失敗不得在本地假設 mode 已切換。

### 商城

- 一筆可購買 Offer：載入後自動選取。
- 兩筆以上：顯示選項並要求選擇。
- 零筆：購買按鈕停用。
- 單一 Offer 售完：顯示售完，不顯示規格容器。
- 加入購物車仍保存既有 `variantId`，phase1 不更改 localStorage shape。

## 驗證規則

| 欄位 | 規則 |
| --- | --- |
| price | 整數，沿用現有 PAYUNi 金額上下限 |
| sku | 選填，清除首尾空白，長度沿用現有規則 |
| stock | 整數且大於等於 0 |
| title | default Offer 不要求；公開 Offer 必填 |
| enabled | 商品上架前至少一筆為 true |

`trackStock` 在 phase1 可先只作介面預留，不得用巨大數字模擬 unlimited。若現有 schema
尚無法表達無限庫存，純課程商品在 phase2 前不得上架。

## 狀態轉移

```mermaid
stateDiagram-v2
    [*] --> Single: 建立商品
    Single --> Multi: 增加規格選項
    Multi --> Multi: 新增/停用方案
    Multi --> Single: 後續版本，選定保留方案
```

phase1 必須完成 `Single -> Multi`；`Multi -> Single` 可以列為後續項目，但 API 不得
讓管理員透過刪除操作意外進入無 Offer 狀態。

## 測試範圍

### 後端

- 建立商品會自動建立一筆 default Offer。
- 建立失敗不留下孤兒 Product。
- 單一既有 variant backfill 正確。
- 多 variant 商品不被錯誤隱藏。
- default Offer 不要求 title。
- 上架無 enabled Offer 的商品被拒絕。
- Cart validate 仍接受既有 `variantId`。

### 前端

- 單一 Offer 不渲染規格列表。
- 單一 Offer 可以直接加入購物車。
- 多 Offer 必須選擇。
- 單一售完商品顯示售完。
- Product create 不要求規格名稱。
- 從單一模式開啟多方案時保留售價與庫存輸入。

## 驗收標準

- 新增單一實體商品不需要進入規格編輯器。
- 前台不出現「預設規格」或「標準方案」。
- 現有多規格商品的價格、庫存與購物車流程不變。
- 不新增 Product 層的第二份 price 或 stock。
- phase1 部署後可以安全回滾前端；資料仍是現有 variant 結構的超集。
