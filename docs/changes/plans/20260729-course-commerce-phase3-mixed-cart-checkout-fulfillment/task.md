# Phase 3 工作項目：混合購物車、結帳與履約

## 1. Migration

- [ ] 擴充 `order_items` 的 Offer 與能力快照欄位。
- [ ] 建立 `order_fulfillments` 與索引。
- [ ] 建立 `course_entitlements` 與唯一索引。
- [ ] 定義既有訂單的相容讀取；不得重算歷史商品內容。
- [ ] 新增數位訂單可用的 `shipping_method = none` 規則。

## 2. Cart Domain

- [ ] 正規化 `variantId`／`offerId` 輸入。
- [ ] 使用 phase2 `resolve_offer` 取代直接 variant.stock 判斷。
- [ ] 彙總跨 line 的 InventoryItem 需求量。
- [ ] 實作 course/mixed Offer 數量上限。
- [ ] 計算 subtotal、shippingSubtotal、requiresShipping、containsCourse。
- [ ] 只有需要配送時查詢與報價 shipping methods。
- [ ] 擴充 problems reason 與前端中文訊息。

## 3. Order 與庫存

- [ ] 將 `take_stock`／`give_back_stock` 改為 InventoryItem。
- [ ] 建立訂單前重新驗算完整 CartQuote。
- [ ] 實作多 InventoryItem 的條件扣減與失敗補償。
- [ ] 建立 OrderItem snapshot。
- [ ] 同時建立 OrderFulfillment snapshot。
- [ ] 任何中途失敗都回補庫存並阻止付款。
- [ ] 逾期與取消只回補 physical fulfillment。
- [ ] 更新 stock audit 與 order audit detail。

## 4. Checkout API

- [ ] 純數位 request 不要求 shippingMethod。
- [ ] 純數位不要求 phone/address，仍驗證會員與通知 Email。
- [ ] 有實體時完整沿用宅配／超商驗證。
- [ ] 不信任 client 的配送與能力旗標。
- [ ] 更新會員 profile 時，純數位不得清空既有地址。
- [ ] 回傳前端需要的履約摘要。

## 5. 付款與 Entitlement

- [ ] 建立 `provision_paid_order`。
- [ ] 使用冪等 insert 建立 course entitlement。
- [ ] 正確計算永久與期限授權。
- [ ] 重複付款通知可安全重跑。
- [ ] 建立 paid/pending digital fulfillment reconciliation。
- [ ] 管理後台提供安全的重試入口。
- [ ] 補發與撤銷權限先保留 domain API，完整 UI 在 phase7。

## 6. 商城前端

- [ ] CartPage 根據 quote 顯示或隱藏配送。
- [ ] 限制含課程 Offer 的數量。
- [ ] CheckoutPage 根據 `requiresShipping` 渲染欄位。
- [ ] 純數位訂單顯示「無需配送」。
- [ ] OrderPage 分開顯示數位與實體內容。
- [ ] 「前往我的課程」以 feature flag 保護到 phase6。
- [ ] 升級 localStorage shape 時保留舊 `variantId` 讀取。

## 7. 管理前端

- [ ] Order detail 增加 digital/physical fulfillment 區塊。
- [ ] 純數位訂單隱藏出貨操作。
- [ ] 顯示課程授權 pending/fulfilled/failed。
- [ ] 提供 reconciliation 重試但避免重複建立授權。

## 8. 測試

- [ ] 擴充 `backend/tests/test_cart.py` 完整組合矩陣。
- [ ] 擴充 `backend/tests/test_orders.py` 庫存、快照、逾期與補償。
- [ ] 擴充 `backend/tests/test_checkout_profile.py` 條件式欄位。
- [ ] 擴充 `backend/tests/test_orders_admin.py` 履約顯示與操作限制。
- [ ] 前端測試 CartPage、CheckoutPage、OrderPage 的純數位／實體／混合。
- [ ] 測試付款通知至少重送兩次。
- [ ] 注入 entitlement 寫入失敗並驗證 reconciliation。

## 9. 部署 Gate

- [ ] 先部署 schema 與可讀舊資料的後端。
- [ ] 再部署商城與管理前端。
- [ ] 用 feature flag 阻止課程商品正式上架。
- [ ] 驗證既有實體訂單建立、付款、逾期與出貨。
- [ ] 驗證純課程及混合測試商品但不公開。
- [ ] 確認沒有程式仍以 `product_variants.stock` 作權威來源。
- [ ] 記錄回滾時新訂單 fulfillment 的相容處理。
