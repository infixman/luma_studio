# Phase 2 工作項目：可組合商品內容與庫存分離

## 1. Migration

- [ ] 建立 `inventory_items`。
- [ ] 建立 `courses` 最小骨架。
- [ ] 建立 `offer_components` 與索引。
- [ ] 撰寫既有 variant 到 InventoryItem 的可重跑 backfill。
- [ ] 為每筆既有 Offer 建立 inventory component。
- [ ] 加入 migration 後資料數量與 stock 對照檢查。
- [ ] 保留舊 `sku`、`stock` 欄位供回滾，不立即刪除。

## 2. Domain

- [ ] 建立 InventoryItem row mapper、驗證與 CRUD。
- [ ] 建立 Course skeleton row mapper、驗證與 CRUD。
- [ ] 建立 OfferComponent row mapper 與完整集合更新。
- [ ] 實作 `resolve_offer`，集中推導能力與 component 數量。
- [ ] 實作 `requiresShipping`、`containsCourse`、`digitalOnly`、`isBundle`。
- [ ] 實作 target 引用查詢與封存保護。
- [ ] 確保程式不接受 component 指向 Offer。
- [ ] 將庫存調整集中到 Inventory domain，停止新增 variant.stock 寫入。

## 3. 管理 API

- [ ] 新增 InventoryItem list/create/detail/update/archive/reference endpoints。
- [ ] 新增 Course skeleton endpoints。
- [ ] 新增 Offer components get/put endpoints。
- [ ] components 更新先完整驗證再寫入。
- [ ] 只有管理 Worker 可寫入上述資料。
- [ ] 回傳後端計算的能力摘要，不接受前端覆寫。
- [ ] 庫存調整保存操作原因與前後值。

## 4. 管理前端

- [ ] 新增庫存品列表與編輯頁。
- [ ] Offer 編輯新增商品內容 Panel。
- [ ] 新增 Course picker 與 InventoryItem picker。
- [ ] 顯示 component quantity、觀看期限與引用摘要。
- [ ] 顯示「純數位／需要配送／含課程」衍生摘要。
- [ ] 防止同一 target 重複加入。
- [ ] 被引用資料的刪除按鈕改為封存並說明原因。

## 5. 相容層

- [ ] 現有 shop/public API 在 phase3 前仍能取得正確 stock。
- [ ] 現有管理端變更庫存時只更新 InventoryItem。
- [ ] 必要時提供短期 read adapter，不建立永久雙寫。
- [ ] 記錄切換到 phase3 後可移除的 compatibility code。

## 6. 測試

- [ ] 新增 migration/backfill 測試。
- [ ] 新增 InventoryItem CRUD、調整與引用保護測試。
- [ ] 新增 Course skeleton 狀態與 slug 唯一測試。
- [ ] 新增 OfferComponent 驗證與完整集合替換測試。
- [ ] 新增 `resolve_offer` 四種組合測試。
- [ ] 新增管理 API 權限與錯誤 shape 測試。
- [ ] 前端測試 picker、重複阻擋、數量與摘要。

## 7. Phase Gate

- [ ] 所有既有商品都有一筆有效 inventory component。
- [ ] 新舊 stock 比對完全一致。
- [ ] 課程與混合 Offer 維持 draft，不得從公開商城購買。
- [ ] phase3 可以只依 `resolve_offer` 實作 Cart 與 Order。
- [ ] rollback 不需要刪除新表；舊商城仍可讀取保留欄位。
