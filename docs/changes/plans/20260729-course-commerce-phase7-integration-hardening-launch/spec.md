# Phase 7 規格：整合補強與正式上線

## 目標

完成 phase1～phase6 的跨領域整合、管理操作、異常補償、可觀測性與正式上線 Gate，
並移除已確認不再需要的相容程式。

## 商品建立規格

### Template API

前端可以使用本地 template 定義，也可以由後端回傳可用能力。建立 request 最終仍展開為：

```json
{
  "product": {},
  "defaultOffer": {},
  "components": []
}
```

後端不接受 `template = hybrid` 後自行猜測 target；所有 component id 必須明確。

### 建立一致性

Product、default Offer、components 與新 InventoryItem 若在同一 wizard 建立，必須：

- 先完整驗證。
- 使用 D1 batch 或明確補償。
- 不留下沒有 Product 的 InventoryItem，除非管理員原本就選擇建立獨立庫存品。
- 回傳建立結果與可恢復的 draft。

## 營運 API

### Entitlement

```text
GET  /api/customers/{id}/entitlements
POST /api/orders/{id}/reconcile-entitlements
POST /api/entitlements/{id}/revoke
POST /api/entitlements/{id}/restore
POST /api/customers/{id}/entitlements/grant
```

每個 mutation 必須：

- 要求 reason。
- 記錄 actor、before、after、timestamp。
- 冪等。
- 不直接改寫原始 OrderItem。

### Fulfillment

```text
POST /api/orders/{id}/physical-fulfillments/{id}/ship
POST /api/orders/{id}/physical-fulfillments/{id}/return
POST /api/orders/{id}/reship
POST /api/orders/{id}/refund-record
```

第一版退款可以是記錄外部金流結果，不一定自動呼叫退款 API；但授權與庫存處理必須
清楚顯示是自動還是待人工。

### References 與刪除

所有 Product、Offer、InventoryItem、Course、VideoAsset detail API 提供 reference
summary。硬刪 endpoint 必須在引用非零時拒絕，並回傳可封存替代方案。

## Reconciliation Jobs

### Entitlement

查找：

```text
orders.status = paid
AND course fulfillment status != fulfilled
```

重跑 `provision_paid_order`，成功後寫 audit。永久失敗進管理告警。

### Inventory Reservation

查找逾期 pending order，使用既有條件狀態轉移確保只有一個 worker 回補一次。

### Video

- queued/processing 超過 lease。
- ready 但 active master HEAD 失敗。
- orphan output version。
- 過期 multipart session。

### Reference Integrity

定期或管理工具檢查 polymorphic component target、Lesson VideoAsset 與 entitlement Course。

## 舊欄位清理

只有符合以下條件才能移除 `product_variants.stock`／舊 variant API 或 localStorage shape：

1. 所有 InventoryItem backfill 比對完成。
2. production 已無舊前端版本使用舊寫入。
3. 觀察期內沒有舊 request。
4. rollback 版本也已支援新 schema。
5. 備份與還原腳本已更新。

D1 欄位刪除成本較高時，可以停止使用並保留欄位，不為了 schema 好看冒 migration 風險。

## Feature Flags

至少：

```text
COURSE_CATALOG_ENABLED
COURSE_CHECKOUT_ENABLED
COURSE_LEARNING_ENABLED
VIDEO_UPLOAD_ENABLED
```

後端是權威；前端 flag 只控制顯示。即使前端錯誤開啟，後端關閉時仍須拒絕相關 mutation。

## Rate Limit 與防濫用

分開限制：

- Upload session/presign。
- Transcode retry。
- Playback session 建立。
- Progress update。
- Preview playback。
- 管理員 reconciliation。

授權會員正常播放會產生大量 segment request，不可用一般 API 的低 request limit 誤傷；
Gateway 使用有效簽章與 CDN cache 控制，而非每段進 D1 rate limiter。

## Observability

Structured log 至少包含：

```text
request_id
order_id（適用時）
asset_id / job_id（適用時）
course_id / fulfillment_id（適用時）
status_transition
error_code
duration_ms
```

不得包含：

- OAuth/session cookie。
- Playback token。
- Presigned URL query。
- R2 secret。
- 完整付款敏感資料。

Dashboard：

- 付款後授權延遲。
- 未完成 fulfillment 數。
- Transcode success/failure/queue age。
- Playback 5xx 與 cache hit。
- R2 與 Container 用量。

## E2E 驗收矩陣

| 商品 | 購買 | 配送 | 付款後 | 後台 |
| --- | --- | --- | --- | --- |
| 單一實體 | default Offer | 必須 | 待出貨 | 可出貨 |
| 多規格實體 | 選 Offer | 必須 | 待出貨 | 規格快照 |
| 純課程 | default Offer | 無 | 我的課程可看 | 無出貨按鈕 |
| 課程＋材料包 | default/選 Offer | 必須 | 可看＋待出貨 | 兩種 fulfillment |
| 多課程組合 | default Offer | 無 | 每門各有權限 | 一筆商品、多筆授權 |

每列再覆蓋：

- pending 取消。
- 付款成功 callback 重送。
- 逾期。
- 庫存不足。
- entitlement 暫時失敗與重試。
- Course/Video 封存。
- 管理員補發／撤銷。

## 效能與成本驗收

- Product detail 不出現無界 N+1 Course/Component query。
- Cart 最大 20 lines 下 query 數可控。
- Playback segment cache hit 不查 D1。
- Progress write 節流有效。
- 上傳不經 Worker body。
- 轉檔一次性成本與每小時來源影片輸出容量有實測資料。
- 設定 R2 lifecycle 前有 dry run/list report。

## 上線 Gate

- 所有 schema 先於會寫入它的程式部署。
- 管理端、公開 API、商城與 Media Worker 版本相容。
- 測試商品完成真實付款沙盒或既定測試流程。
- 管理員可以從訂單追到 entitlement、Course、Lesson、VideoAsset 與實體 fulfillment。
- 告警、reconciliation、備份、還原與 rollback runbook 可執行。
- 先 soft launch，一次只開少量課程商品。
- 觀察期通過後才清除相容程式與公開所有課程。
