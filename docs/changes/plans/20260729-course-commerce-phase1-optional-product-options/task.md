# Phase 1 工作項目：商品規格選配

## 1. Migration 與 Domain

- [ ] 新增 `is_default` 欄位與必要索引。
- [ ] 撰寫既有單一 variant 商品的 backfill。
- [ ] 驗證多 variant 商品不被標記 default。
- [ ] 在 shop domain 引入 Offer 命名或 adapter，避免新增程式繼續假設「每筆都是規格」。
- [ ] 新增取得 default Offer、計算 sales mode、檢查 enabled Offer 的函式。
- [ ] 保留既有 variant id，不重新產生 id。

## 2. 管理 API

- [ ] 擴充建立商品 request，接受售價、SKU 與庫存。
- [ ] 建立 Product 與 default Offer，處理中途失敗。
- [ ] 擴充商品詳情回傳 `salesMode` 與 `defaultOffer`。
- [ ] 更新單一商品時同步更新 default Offer。
- [ ] 實作 `Single -> Multi` 的明確操作，不靠前端自行新增第二筆後猜測狀態。
- [ ] 上架前驗證至少一筆 enabled Offer。
- [ ] 保護 default Offer，避免一般刪除造成商品無方案。

## 3. 管理前端

- [ ] ProductCreatePage 增加銷售資訊欄位。
- [ ] ProductEditPage 在 single mode 隱藏規格列表。
- [ ] 新增「增加規格選項」操作與確認文案。
- [ ] 切換多方案時將 default Offer 帶入第一列。
- [ ] 多方案沿用現有排序、啟用、價格、SKU 與庫存操作。
- [ ] 儲存錯誤保留輸入，不提前切換 UI 狀態。
- [ ] 移除所有暗示「商品必須新增規格」的文案與空狀態。

## 4. 公開 API 與商城

- [ ] 商品詳情回傳 `requiresOfferSelection`。
- [ ] 單一 default Offer 不公開內部名稱。
- [ ] ProductPage 在一筆 Offer 時自動選取。
- [ ] ProductPage 只在需要選擇時渲染方案區。
- [ ] 單一 Offer 售完時顯示正確狀態。
- [ ] CartPage 與 localStorage 維持既有 `variantId` 相容。

## 5. 測試

- [ ] 擴充 `backend/tests/test_shop.py`：建立、更新、backfill、上架驗證。
- [ ] 擴充 `backend/tests/test_cart.py`：default Offer 價格與庫存。
- [ ] 擴充 `ProductPage.test.ts`：單一、多方案、售完。
- [ ] 新增 ProductCreatePage／ProductEditPage 的 single mode 測試。
- [ ] 驗證現有商品、購物車與訂單測試不因欄位增加而失敗。
- [ ] 執行 migration 後比對商品數、Offer 數與既有 variant id。

## 6. 部署與驗收

- [ ] 先部署可讀新舊 shape 的後端。
- [ ] 再部署新版管理端與商城。
- [ ] 建立一筆無規格實體商品並完成購買流程。
- [ ] 驗證一筆既有多規格商品。
- [ ] 驗證舊 localStorage 購物車可以正常驗算。
- [ ] 確認 phase2 前不允許無限庫存課程上架。
- [ ] 記錄 rollback：前端可回退；migration 不移除舊欄位。
