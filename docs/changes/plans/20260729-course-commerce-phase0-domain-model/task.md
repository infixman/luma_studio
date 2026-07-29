# Phase 0 工作項目：商城與課程共同模型

> `[x]` 僅表示本階段已完成 repo-grounded 盤點或設計收斂；不表示正式程式、migration 或 API 已實作。

## 1. 現況盤點

- [x] 列出 `products`、`product_variants`、`orders`、`order_items`、`customers`、`shipping_methods` 的 schema 與索引。證據：`backend/src/shared/migrations.py:136-299`。
- [x] 列出商品建立、編輯、上架與 variant CRUD。證據：`backend/src/api/admin/shop.py:148-230`, `268-287`；建立 UI：`frontend/src/admin/pages/ProductCreatePage.tsx:40-55`。
- [x] 列出公開商品列表、詳情與可購買性。證據：`backend/src/api/front/pages.py:9-12`, `83-91`；`backend/src/domain/shop.py:166-213`。
- [x] 列出 Cart localStorage 格式、validate request/response 與前端使用點。證據：`frontend/src/storefront/lib/cart.ts:10-60`；`backend/src/domain/cart.py:33-122`；`backend/src/api/front/checkout.py:12-27`。
- [x] 確認價格、SKU、stock 的現況資料來源與限制。證據：`backend/src/domain/shop.py:36-42`, `101-106`, `143-153`；SKU 尚非 unique。
- [x] 確認建單條件扣庫存、中途失敗回補、pending 逾期回補。證據：`backend/src/domain/orders.py:179-263`, `564-590`；cron：`backend/src/main.py:226-233`。
- [x] 確認 checkout 對配送、電話、地址與超商資料的實際要求。證據：`backend/src/api/front/checkout.py:50-78`；`frontend/src/storefront/pages/CheckoutPage.tsx:124-188`。結論：目前所有訂單都要求配送方式／電話，超商門市欄位尚未由 checkout 寫入。
- [x] 確認付款、重複通知與手動已付款路徑。證據：`backend/src/domain/orders.py:349-370`；`backend/src/api/admin/orders.py:123-153`；`backend/src/api/front/checkout.py:114-126`。結論：沒有正式 gateway callback，只有條件式付款轉移基礎。
- [x] 確認訂單狀態與 audit。證據：`backend/src/domain/orders.py:172-176`, `373-428`, `546-590`；schema：`backend/src/shared/migrations.py:286-299`。
- [x] 確認 Admin/Public Worker、migration 執行者與部署順序。證據：`backend/src/shared/router.py:32-59`、`backend/src/admin_main.py:104-106`、`backend/src/main.py:23-26`、`README.md:16-20`。
- [x] 確認相關測試覆蓋與缺口。證據：`backend/tests/test_cart.py:32-205`、`backend/tests/test_orders.py:100-216`、`backend/tests/test_checkout_profile.py:57-100`；課程／component／entitlement／callback 測試尚不存在。

## 2. 模型與跨階段契約

- [x] 收斂 Product、Offer、Option、InventoryItem、OfferComponent、Course、VideoAsset、OrderFulfillment、Entitlement 的責任邊界；見 `design.md`「目標領域模型」。
- [x] 定義 `product_variants` 暫作 Offer、default Offer 與 `variantId` 相容規則；見 `design.md`「Offer、default Offer 與舊 variantId」。
- [x] 定義 InventoryItem 成為唯一庫存寫入來源、禁止長期雙寫與 backfill 對帳順序；見 `design.md`「庫存遷移與一致性」。
- [x] 定義 Cart／Order 共用 `resolve_offer`、OrderItem／Fulfillment snapshot 與付款後 entitlement 冪等規則；見 `design.md`／`spec.md`。
- [x] 定義 D1 polymorphic component 的應用層驗證與多品項補償策略；見 `design.md`「polymorphic OfferComponent」與 `spec.md`「狀態與補償」。
- [x] 定義 candidate tables、索引、唯一性、狀態、相容／rollback 及 API shape 原則；見 `spec.md`。
- [x] 檢查 Phase 1–7 的 design/spec 名詞與依賴；Phase 0 已明確交接。證據：`docs/changes/plans/20260729-course-commerce-phase1-optional-product-options/design.md:69-83`、`phase2-composable-offer-components/spec.md:71-107`、`phase3-mixed-cart-checkout-fulfillment/spec.md:58-169`、`phase4-video-ingestion-pipeline/design.md:156-194`、`phase5-course-authoring-catalog/spec.md:100-157`、`phase6-member-learning-playback/spec.md:32-126`、`phase7-integration-hardening-launch/spec.md:97-120`。

## 3. 代表案例

- [x] 完成單一實體、多規格實體、純課程、課程＋材料包、多課程組合的資料形狀、商品頁、Cart、配送、庫存、快照、付款、取消／逾期與會員結果。見 `design.md`「五個代表案例」。
- [x] 驗證案例可由 component 推導配送，不需 product-type enum。見 `design.md`「Cart、Order、snapshot 與履約」。
- [ ] 以實作或測試驗證五案例。Blocker：Phase 1–3 尚未實作 Course／InventoryItem／OfferComponent／Fulfillment。

## 4. 已完成的產品／營運決策

- [x] 退款、已付款取消、chargeback 後 entitlement 政策。2026-07-30 owner 決定：自動撤銷受影響 course fulfillment source；無其他有效 source 時收回 Course／Lesson 與影片播放權，不刪進度／訂單／audit。部分退款必須明確指定 course fulfillment。
- [x] 混合商品 paid 後的開課時間。2026-07-30 owner 決定：paid 後立即建立數位授權，不等待出貨。
- [x] 預設觀看期限。2026-07-30 owner 決定：預設無限；期限型 Offer 設 `access_days`，第一次成功播放後才開始倒數。
- [x] 含 Course Offer 購買數量與未來 gifting。2026-07-30 owner 決定：每次 quantity 固定 1；會員有相同 Course 有效 entitlement 或未過期 pending 同 Offer 時拒絕結帳；到期／所有來源撤銷後可再購買。
- [x] 混合 Offer 免運門檻基數。2026-07-30 owner 決定：以整個需配送 Offer 的售價計入，純數位 Offer 不計。
- [x] 純數位 paid 後是否自動 completed。2026-07-30 owner 決定：全部 digital fulfillment／entitlement 成功後立即 completed，失敗保留 paid 重試。
- [x] archived Course 對既有 entitlement 的可看政策。2026-07-30 owner 決定：封存只阻止新販售／新授權，既有有效 entitlement 可繼續觀看。
- [x] 未來贈送課程是否需要。2026-07-30 owner 決定：支援 gift entitlement source，保留 actor、recipient、Course、原因與 audit，不建立零元 OrderItem。

## 5. Phase gate

- [x] Phase 0 未修改正式 schema、backend、frontend、wrangler、migration 或 Phase 1–7 文件；只修改 Phase 0 三份文件。
- [x] 已定義 Admin-first migration、backfill、讀取切換、rollback 與清理順序；見 `spec.md`「migration、backfill、相容與 rollback 順序」。
- [ ] Phase 1 implementation review 通過。需要確認 partial unique index 策略、single-variant／zero-variant backfill、Product+default Offer 一致性策略，以及 variantId 相容觀察期；見 `spec.md`「Phase 1 gate」。
- [ ] Phase 3 課程 checkout 公開啟用。Blocker：Phase 2 schema／backfill、Phase 3 checkout／fulfillment／entitlement 實作與測試尚未完成；第 4 節商業決策已完成。
