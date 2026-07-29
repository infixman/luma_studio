# Phase 7 工作項目：整合補強與正式上線

## 1. 商品建立體驗

- [ ] 建立「實體商品」範本。
- [ ] 建立「線上課程」範本。
- [ ] 建立「課程＋材料包」範本。
- [ ] 建立進階組合入口。
- [ ] Wizard 儲存前顯示實際 Offer components 摘要。
- [ ] 建立失敗不留下無法辨認的孤兒資料。
- [ ] 所有範本底層使用同一個 Offer/Component API。

## 2. 訂單與履約營運

- [ ] 後台同時呈現 payment、digital fulfillment、physical fulfillment。
- [ ] 純數位訂單不顯示出貨操作。
- [ ] 混合訂單允許課程已授權、實體仍待出貨。
- [ ] 實作補寄流程，不重複 entitlement。
- [ ] 實作退貨庫存回補的人工確認。
- [ ] `refund-record` 帶明確 scope 與 `courseFulfillmentIds`，不由金額推測受影響課程。
- [ ] 全額退款／已付款取消自動撤銷該訂單 course sources 並釋放 purchase lock。
- [ ] 記錄退款結果與授權處置。
- [ ] 確認 chargeback 走與全額退款相同的授權撤銷路徑，庫存維持人工。
- [ ] 純數位訂單自動 completed 的顯示與 audit。

## 3. Entitlement 管理

- [ ] 建立會員 entitlement 列表。
- [ ] 建立人工補發、撤銷與恢復。
- [ ] 撤銷以 source 為單位；顯示「是否連帶停權」的推導結果。
- [ ] 建立 gift 授與（actor／recipient／course／reason），不建立零元 OrderItem。
- [ ] 每次操作要求 reason 並寫 audit。
- [ ] 顯示每筆 source 的來源 order fulfillment、`source_kind` 與撤銷狀態。
- [ ] 顯示 `access_days`／`first_viewed_at`／`expires_at` 三種期限狀態。
- [ ] 防止重複補發或 restore 造成意外延長；延長須為獨立操作。
- [ ] 建立 purchase lock 查詢與人工釋放（要求 reason）。
- [ ] 建立過期與即將到期查詢，若產品沒有期限方案則保持隱藏。

## 4. 封存、引用與清理

- [ ] Product/Offer/InventoryItem/Course/VideoAsset 都提供 references。
- [ ] 有引用時以 archive/disable 取代硬刪。
- [ ] VideoAsset 替換流程先更新 Lesson，再允許封存。
- [ ] 建立舊 encode version rollback 保留期。
- [ ] 建立 source video retention policy。
- [ ] 清理工作先輸出 dry-run report，再允許正式刪除。
- [ ] 所有永久刪除寫 audit 並記錄 object 數量與 bytes。

## 5. Reconciliation

- [ ] 建立 paid order entitlement reconciliation（含純數位補完 completed）。
- [ ] 建立逾期 reservation reconciliation，同時釋放 purchase lock。
- [ ] 建立孤兒 purchase lock 檢查。
- [ ] 建立 entitlement／source 撤銷一致性檢查（全撤未停權、期限欄位只寫一半）。
- [ ] 建立 stuck transcode job reconciliation。
- [ ] 建立 ready VideoAsset object integrity check。
- [ ] 建立 CourseLesson/OfferComponent target integrity check。
- [ ] 管理後台顯示異常數與安全重試入口。
- [ ] 連續失敗進告警，不無限重試永久錯誤。

## 6. Observability 與成本

- [ ] 統一 request/job/order correlation id。
- [ ] 建立付款後授權延遲指標。
- [ ] 建立 transcode queue age、成功率、OOM 與時間指標。
- [ ] 建立 playback 5xx、401/403 與 cache hit 指標。
- [ ] 建立 R2 source/output bytes 與 operations 報表。
- [ ] 建立 Container CPU/memory/disk 成本報表。
- [ ] 設定合理告警門檻。
- [ ] 驗證 logs 不含 cookie、token、presigned query 或 secrets。

## 7. 備份與 Runbook

- [ ] 更新 D1 備份與還原，涵蓋新增表。
- [ ] 決定 R2 source 與 HLS 的第二份保存策略。
- [ ] 實際演練從備份還原 Course、Entitlement 與 Video metadata。
- [ ] 撰寫付款成功但未授權 runbook。
- [ ] 撰寫誤撤銷 entitlement 的 restore runbook。
- [ ] 撰寫 purchase lock 卡住導致無法購買的排除 runbook。
- [ ] 撰寫影片轉檔卡住 runbook。
- [ ] 撰寫誤封存 Course/Video rollback runbook。
- [ ] 撰寫 R2 object 遺失的影響判斷與恢復流程。
- [ ] 撰寫 feature flag 緊急關閉流程。

## 8. 相容程式清理

- [ ] 建立舊 shape request 的計數指標，作為 90 天觀察期的證據來源。
- [ ] 觀察 production 是否仍收到舊 `variantId` request，連續 90 天為零才可清理。
- [ ] 確認至少兩個已發布前端版本都寫入新 shape。
- [ ] 確認所有 stock 寫入都在 InventoryItem。
- [ ] 移除不再使用的 variant.stock compatibility write。
- [ ] 評估舊欄位保留或 migration 移除；無實際收益則保留。
- [ ] 更新 TypeScript contracts，移除已停止支援的雙 shape。
- [ ] 更新測試 fixture、README 與架構文件。

## 9. 完整驗收

- [ ] 單一實體商品完整購買。
- [ ] 多規格實體商品完整購買。
- [ ] 純課程完整付款、授權、播放與進度。
- [ ] 課程＋材料包完整付款、授權、出貨。
- [ ] 多課程組合建立多筆 entitlement。
- [ ] pending 取消與逾期回補。
- [ ] 付款通知重送。
- [ ] 庫存不足與 component 停用。
- [ ] entitlement failure/reconciliation。
- [ ] 重複購買被擋：已擁有、pending 進行中、併發結帳。
- [ ] 期限型授權：付款後未啟動、首次播放啟動、再播放與 refresh 不延長。
- [ ] 全額退款撤銷觀看權且保留進度；多來源時不誤撤。
- [ ] 只退實體不影響課程；部分退款需點名 course fulfillment。
- [ ] gift 授與與 restore。
- [ ] Course、VideoAsset、Product 封存後既有會員行為。
- [ ] 無權會員即使取得 m3u8 路徑仍無法播放。

## 10. 上線

- [ ] 所有 feature flag 預設關閉。
- [ ] 先建立內部測試課程與測試會員。
- [ ] Soft launch 一個純課程商品。
- [ ] Soft launch 一個課程＋材料包商品。
- [ ] 觀察付款、授權、播放、庫存、出貨與成本。
- [ ] 確認告警與 reconciliation 實際可用。
- [ ] 通過觀察期後開啟課程分類與正式商品。
- [ ] 最後才移除已確認無流量的相容程式。
