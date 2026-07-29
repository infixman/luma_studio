# Phase 1 工作項目：商品規格選配

## 1. Migration 與 Domain

- [x] 新增 `is_default` 欄位與必要索引。（`backend/src/shared/migrations.py`：`0027_add_default_product_offers`）
- [x] 撰寫既有單一 variant 商品的 backfill。（同一 migration 只標記 `COUNT(*) = 1` 的商品）
- [ ] 驗證多 variant 商品不被標記 default。部分完成：`backend/tests/test_migrations_sqlite.py` 以真 SQLite 重放 0027，證明只有單一 offer 的商品被標記、0 offer 與多 offer 都不動。仍需在部署前以實際 D1 備份或 staging migration 比對真實資料。
- [x] 確認 partial unique index 在 SQLite 引擎真的生效。（`test_migrations_sqlite.py`：第二筆 default 被 IntegrityError 拒絕，非 default 不受限，跨商品各自可有 default）
- [x] 盤點既有 active 但無可販售 Offer 的商品。（`shop.unsellable_active_products`、`GET /api/products/unsellable`；`can_be_active` 只擋寫入，既有資料需另外查）
- [x] 在 shop domain 引入 Offer 命名或 adapter，避免新增程式繼續假設「每筆都是規格」。（`isDefault`、`sales_mode`）
- [x] 新增取得 default Offer、計算 sales mode、檢查 enabled Offer 的函式。
- [x] 保留既有 variant id，不重新產生 id。（`convert_default_offer_to_multi` 原地更新同一列）

## 2. 管理 API

- [x] 擴充建立商品 request，接受售價、SKU 與庫存。
- [x] 建立 Product 與 default Offer，處理中途失敗。
- [x] 擴充商品詳情回傳 `salesMode` 與 `defaultOffer`。
- [x] 更新單一商品時同步更新 default Offer。
- [x] 實作 `Single -> Multi` 的明確操作，不靠前端自行新增第二筆後猜測狀態。
- [x] 上架前驗證至少一筆 enabled Offer。
- [x] 保護 default Offer，避免一般刪除造成商品無方案。

## 3. 管理前端

- [x] ProductCreatePage 增加銷售資訊欄位。
- [x] ProductEditPage 在 single mode 隱藏規格列表。
- [x] 新增「增加規格選項」操作與確認文案。
- [x] 切換多方案時將 default Offer 帶入第一列。
- [x] 多方案沿用現有排序、啟用、價格、SKU 與庫存操作。
- [x] 儲存錯誤保留輸入，不提前切換 UI 狀態。
- [x] 移除所有暗示「商品必須新增規格」的文案與空狀態。

## 4. 公開 API 與商城

- [x] 商品詳情回傳 `requiresOfferSelection`。
- [x] 單一 default Offer 不公開內部名稱。
- [x] ProductPage 在一筆 Offer 時自動選取。
- [x] ProductPage 只在需要選擇時渲染方案區。
- [x] 單一 Offer 售完時顯示正確狀態。
- [x] CartPage 與 localStorage 維持既有 `variantId` 相容。（未變更格式；`backend/tests/test_cart.py` 通過）

## 5. 測試

- [x] 擴充 `backend/tests/test_shop.py`：建立、更新、backfill、上架驗證。（覆蓋 default Offer 建立、Single → Multi 原地更新、0027 migration SQL、上架拒絕與 default 刪除保護）
- [x] 擴充 `backend/tests/test_cart.py`：default Offer 價格與庫存。（既有 `variantId` 對 default Offer 仍以資料庫價格與庫存驗算）
- [x] 擴充 `ProductPage.test.ts`：單一、多方案、售完。（覆蓋選取、是否顯示 chooser 與購買狀態契約）
- [x] 新增 ProductCreatePage／ProductEditPage 的 single mode 測試。（`happy-dom` + 每檔 `// @vitest-environment happy-dom`，不裝 testing-library；`ProductCreatePage.test.tsx` 驗證不出現規格名稱欄位，`ProductEditPage.test.tsx` 驗證 single/multi 面板切換）
- [x] 加入真 SQLite 的 migration 測試。（`backend/tests/test_migrations_sqlite.py`：整份 MIGRATIONS 可被 SQLite 接受，partial unique index 生效，0027 backfill 只標單一 offer）
- [x] 驗證現有商品、購物車與訂單測試不因欄位增加而失敗。（`test_shop.py`、`test_cart.py`、`test_orders.py` 通過）
- [ ] 執行 migration 後比對商品數、Offer 數與既有 variant id。blocker：不可在本機正式 D1 執行 migration，需 staging/production 部署窗口。部署後至少確認：
      `PRAGMA index_list(product_variants)` 含 `idx_product_variants_one_default`、
      `SELECT COUNT(*) FROM product_variants WHERE is_default = 1` 等於單一 offer 商品數、
      `GET /api/products/unsellable` 的清單已處理完畢。

## 6. 部署與驗收

- [ ] 先部署可讀新舊 shape 的後端。blocker：本次未獲部署授權。
- [ ] 再部署新版管理端與商城。blocker：本次未獲部署授權。
- [ ] 建立一筆無規格實體商品並完成購買流程。blocker：需部署至 staging。
- [ ] 驗證一筆既有多規格商品。blocker：需部署至 staging。
- [ ] 驗證舊 localStorage 購物車可以正常驗算。blocker：需部署至 staging；單元相容測試已通過。
- [ ] 確認 phase2 前不允許無限庫存課程上架。blocker：Phase 2 課程商品尚未實作；Phase 1 未加入 unlimited stock。
- [x] 記錄 rollback：前端可回退；migration 不移除舊欄位。（`is_default` 是新增欄位，既有 `product_variants` 欄位與 id 不變）
