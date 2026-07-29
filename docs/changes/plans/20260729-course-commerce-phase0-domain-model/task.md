# Phase 0 工作項目：商城與課程共同模型

## 1. 現況盤點

- [ ] 列出 `products`、`product_variants`、`orders`、`order_items`、`customers`、
      `shipping_methods` 的實際 schema、索引與讀寫入口。
- [ ] 列出管理端商品建立、編輯、上架與刪除 API。
- [ ] 列出商城商品頁、購物車驗算、結帳、付款成功、取消與逾期流程。
- [ ] 確認所有會直接讀寫 `product_variants.stock` 的程式與測試。
- [ ] 確認 localStorage 購物車格式與相容期限。
- [ ] 記錄目前 D1 migration 的執行者、部署順序與失敗處理。

## 2. 領域決策

- [ ] 確認程式碼使用 `Offer` 語意，但初期是否保留 `product_variants` 實體表名。
- [ ] 確認 default Offer 的 title、SKU 與 API 呈現方式。
- [ ] 確認材料包是否允許不出現在商城但可被 Offer 引用。
- [ ] 確認 bundle 是否禁止巢狀；預設禁止以避免循環和數量爆炸。
- [ ] 確認課程授權預設永久，期限型方案使用 `access_days`。
- [ ] 確認混合商品在付款後立即開課，不等待實體出貨。
- [ ] 確認退款、取消已付款訂單與 chargeback 的授權政策。
- [ ] 確認課程商品購買數量是否固定為 1，以及未來贈送課程是否另案處理。
- [ ] 確認免運門檻計算是否包含數位內容；建議只計入指定的實體配送金額。

## 3. Schema 草案

- [ ] 為 `offers`／`product_variants` 製作 additive migration 草案。
- [ ] 為 `inventory_items`、`offer_components` 製作 schema 草案。
- [ ] 為 `courses`、`course_sections`、`course_lessons`、`video_assets` 製作 schema 草案。
- [ ] 為 `order_fulfillments`、`course_entitlements` 製作 schema 草案。
- [ ] 定義所有唯一索引、查詢索引、狀態值與時間欄位。
- [ ] 定義 D1 無法表達的 polymorphic reference 驗證責任。
- [ ] 準備現有 variant 到 default/public Offer 的分類查詢。
- [ ] 準備現有 variant 到 inventory item/component 的 backfill 對照表。

## 4. 契約與流程

- [ ] 定義管理端 Product、Offer、Component、Course、VideoAsset JSON shape。
- [ ] 定義公開商品卡、商品詳情、CartQuote、CheckoutRequest 的未來 shape。
- [ ] 定義 `requiresShipping`、`containsCourse` 等衍生欄位的唯一計算位置。
- [ ] 定義訂單建立時商品快照與履約快照內容。
- [ ] 定義付款成功後授權建立的冪等鍵與重試策略。
- [ ] 定義封存、刪除、撤銷與補發的狀態轉移圖。

## 5. 驗證資料

- [ ] 建立五組代表案例：單一實體、多規格實體、純課程、課程＋材料包、多課程組合。
- [ ] 對每組案例列出商品頁、購物車、配送、庫存、付款與會員結果。
- [ ] 驗證每個案例不需要新增商品類型 enum。
- [ ] 驗證訂單快照在商品或課程改名後仍可完整閱讀。
- [ ] 驗證付款通知重送不會產生重複 entitlement。

## 6. Phase Gate

- [ ] 所有未定商業規則都有明確 owner 與決定，不留在程式碼中猜測。
- [ ] phase1～phase7 文件引用相同名詞與狀態。
- [ ] migration 可以分階段部署，不要求前後端同一秒切換。
- [ ] 不在 phase0 修改正式 schema 或公開行為。
- [ ] 設計審查通過後，才開始 phase1。
