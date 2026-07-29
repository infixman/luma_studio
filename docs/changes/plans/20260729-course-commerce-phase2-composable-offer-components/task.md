# Phase 2 工作項目：可組合商品內容與庫存分離

## 1. Migration

- [x] 建立 `inventory_items`。（`0028_create_offer_components`；非空 SKU partial unique、`(enabled, title)` picker）
- [x] 建立 `courses` 最小骨架。（slug unique）
- [x] 建立 `offer_components` 與索引。（unique `(offer_id, component_type, component_id)`、`(offer_id, position)`、`(component_type, component_id)`）
- [x] 撰寫既有 variant 到 InventoryItem 的可重跑 backfill。（`INSERT OR IGNORE`，item id 沿用 offer id，不需 mapping 表；已調整的 stock 不被覆寫）
- [x] 為每筆既有 Offer 建立 inventory component。（id 為 `'oc0-' || offer_id`，quantity=1）
- [ ] 加入 migration 後資料數量與 stock 對照檢查。blocker：需 staging/production D1；本機已用真 SQLite 覆蓋重跑與不覆寫（`backend/tests/test_migrations_sqlite.py`）。
- [x] 保留舊 `sku`、`stock` 欄位供回滾，不立即刪除。

## 2. Domain

- [x] 建立 InventoryItem row mapper、驗證與 CRUD。（`backend/src/domain/inventory.py`；含條件 `take_stock` 與無條件 `give_back_stock`）
- [x] 建立 Course skeleton row mapper、驗證與 CRUD。（`backend/src/domain/courses.py`；`is_sellable` 只認 published）
- [x] 建立 OfferComponent row mapper 與完整集合更新。（`backend/src/domain/offers.py`：`validate_components` 先驗全體再 `replace_components`）
- [x] 實作 `resolve_offer`，集中推導能力與 component 數量。（`requiredQuantity = component.quantity × purchase_quantity`；course 不帶 requiredQuantity）
- [x] 實作 `requiresShipping`、`containsCourse`、`digitalOnly`、`isBundle`。
- [x] 建立 target 引用查詢。（`offers.references_of`，以 type + id 查詢；backfill 讓 item id 等於 offer id，只比對 id 會跨型別誤判）
- [x] 確保程式不接受 component 指向 Offer。（`COMPONENT_TYPES` 只有 course／inventory，其餘型別回 ValueError）
- [x] 寫入前驗證 component target 存在且可用。（`offers.validate_targets`：target 必須存在且未封存；draft Course **允許**加入，改由 `offers.sale_blockers` 擋住啟用，讓管理員能自由決定先建課還是先建商品）
- [x] 將庫存調整集中到 Inventory domain。（`inventory.adjust_stock` 回傳 before/after 供 audit；`offers.set_simple_offer_stock` 是商品編輯頁唯一入口，共用或多實體內容一律拒絕並導向庫存品管理）
- [x] 新建 Offer 一併建立 InventoryItem 與 component。（`shop.create_variant`；否則 migration 之後建立的商品是唯一沒有庫存來源的）
- [ ] 停止 `variant.stock` 寫入。目前仍由 `offers.set_simple_offer_stock` 單點鏡像寫入：orders 的扣庫存要到 Phase 3 才搬到 InventoryItem，先拿掉會讓商城賣出不存在的庫存。Phase 7 清理清單已列此項。

## 3. 管理 API

- [x] 新增 InventoryItem list/create/detail/update/archive/reference endpoints。（`backend/src/api/admin/catalogue.py`）
- [x] 新增 Course skeleton endpoints。
- [x] 新增 Offer components get/put endpoints。
- [x] components 更新先完整驗證再寫入。（`validate_components` + `validate_targets` 都通過才 `replace_components`）
- [x] 只有管理 Worker 可寫入上述資料。（僅掛在 `admin_main.dispatch`，未登入回 401）
- [x] 回傳後端計算的能力摘要，不接受前端覆寫。（`DERIVED_FIELDS` 出現在 request 即 400；忽略會讓呼叫端以為被採納）
- [ ] 庫存調整保存操作原因與前後值。部分完成：`inventory.adjust_stock` 已回傳 before/after，尚未接上 audit log 寫入。

## 4. 管理前端

- [x] 新增庫存品列表與建立頁。（`frontend/src/admin/pages/InventoryPage.tsx`；搜尋以 generation 防止較慢的舊請求覆蓋新結果）
- [x] 新增課程列表與建立頁。（`CoursesPage.tsx`；未填網址代稱時由名稱推導）
- [x] Offer 編輯新增商品內容 Panel。（`features/catalogue/OfferComponentsPanel.tsx`，每個 Offer 各一個）
- [x] 新增 Course picker 與 InventoryItem picker。
- [x] 顯示 component quantity、觀看期限與引用摘要。（期限文案為「觀看後 N 天」，不是「購買後」）
- [x] 顯示「純數位／需要配送／含課程」衍生摘要。（直接顯示後端回傳值，前端不重算）
- [x] 防止同一 target 重複加入。（已在方案內的 target 不出現在 picker，而不是選了才報錯）
- [x] 被引用資料的刪除按鈕改為封存並說明原因。（後端回 409 並附使用中的方案數）
- [ ] 庫存品編輯／封存的前端操作。目前只有列表與新增；編輯與封存已有 API，UI 待補。

## 5. 相容層

- [x] 現有 shop/public API 在 phase3 前仍能取得正確 stock。（`variant.stock` 由 `offers.set_simple_offer_stock` 同步鏡像；cart、public detail、dashboard 低庫存都不需改）
- [x] 管理端變更庫存一律經 Inventory domain。（`shop.update_variant` 改呼叫 `set_simple_offer_stock`，不再自己寫 stock 欄位；共用或多實體內容丟 ValueError，API 回 409）
- [x] 短期 read adapter 不需要：`variant.stock` 仍是同一份數字的鏡像，phase3 改讀 InventoryItem 時直接切換。
- [x] 記錄切換到 phase3 後可移除的 compatibility code：
      1. `offers.set_simple_offer_stock` 中對 `product_variants.stock` 的鏡像 UPDATE。
      2. `domain/cart.py`、`domain/orders.py`、`domain/dashboard.py` 對 `variant.stock` 的讀取。
      3. 商品編輯頁的單一庫存欄位（改由庫存品管理）。

## 6. 測試

- [x] 新增 migration/backfill 測試。（`test_migrations_sqlite.py`，真 SQLite 引擎；涵蓋重跑不重複、不覆寫已調整的 stock）
- [x] 新增 InventoryItem CRUD、調整與引用保護測試。（`test_inventory.py`、`test_catalogue_admin.py`）
- [x] 新增 Course skeleton 狀態與 slug 唯一測試。（`test_courses.py`、`test_catalogue_admin.py`）
- [x] 新增 OfferComponent 驗證與完整集合替換測試。（`test_offers.py`）
- [x] 新增 `resolve_offer` 組合測試。（純實體、純課程、混合、requiredQuantity 相乘、target 快照）
- [x] 新增管理 API 權限與錯誤 shape 測試。（未登入 401、衍生欄位 400、引用中 409）
- [x] 前端測試 picker、重複阻擋、數量與摘要。（`OfferComponentsPanel.test.tsx` 9 測）

## 7. Phase Gate

- [ ] 所有既有商品都有一筆有效 inventory component。migration 與新建路徑都已涵蓋（0028 backfill + `shop.create_variant`），但實際資料需 staging 對帳。
- [ ] 新舊 stock 比對完全一致。blocker：需 staging D1。本機已驗證兩者由同一次寫入同步。
- [x] 課程與混合 Offer 維持 draft，不得從公開商城購買。（`offers.sale_blockers` 對未發布課程回 `course_not_published`；公開商城尚未讀 components，購物車行為未變）
- [x] phase3 可以只依 `resolve_offer` 實作 Cart 與 Order。（`resolve_offer` 已回傳價格、能力旗標、component 快照與 `requiredQuantity`）
- [x] rollback 不需要刪除新表；舊商城仍可讀取保留欄位。（`variant.sku`／`.stock` 未移除且仍同步）
