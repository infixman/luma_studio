# Phase 5 工作項目：課程編輯與商品頁

## 1. Migration 與 Domain

- [x] 擴充 `courses` 展示與講師欄位。
- [x] 建立 `course_sections`。
- [x] 建立 `course_lessons` 與 VideoAsset reference index。
- [x] 建立 Course row mapper、欄位驗證與狀態轉移。
- [x] 建立 outline 完整驗證與 position 正規化。
- [x] 建立 lesson count、duration 等衍生計算。
- [x] 建立 Course/VideoAsset/Offer references 查詢。

## 2. HTML 安全

- [x] 選定與 Worker 執行環境相容的 sanitizer。
- [x] 定義 tag、attribute、protocol allowlist。
- [x] 限制圖片引用為已知 MediaItem。
- [x] 清理外部連結並加安全 rel。
- [x] 加入 script、event、style、javascript URL 與 malformed HTML 測試。
- [x] 確保歷史草稿重新儲存時也經過同一 sanitizer。

## 3. 管理 API

- [x] 完成 Course list/create/detail/update。
- [x] 完成 outline get/put。
- [x] 完成 publish/archive。
- [x] publish 回傳結構化 validation errors。
- [x] Offer enable 時驗證 Course published。
- [ ] Course archive 前回傳 Offer 與 entitlement 影響摘要。 封存可用，影響摘要未做。
- [x] 公開 API 不回傳 private R2 key。

## 4. Course 管理前端

- [x] 建立 Course list 頁。
- [x] 建立 Course create/edit 頁。
- [ ] 建立基本資料與課程銷售資訊欄位。
- [ ] 整合 HTML rich text editor。 課程編輯頁目前只有純文字欄位。
- [ ] 建立章節與單元新增、刪除、拖曳排序。 後端 `PUT /outline` 可用，前端仍是唯讀。
- [ ] 建立 VideoAsset picker。 影片列表 API 已完成，選擇器未做。
- [ ] 顯示影片狀態、時長、尺寸與 poster。 同上。
- [ ] 支援試看設定。 同上。
- [ ] 顯示總單元與總時數。 單元數已回傳；總時數需影片長度，等 Phase 4 轉檔。
- [ ] 顯示未儲存警告、預覽與發布檢查。 未做。

## 5. Product 管理整合

- [ ] Offer component picker 顯示完整 Course 摘要。 目前只顯示名稱與草稿標記。
- [ ] 方案摘要顯示觀看期限與是否含實體品。 已顯示於商品內容 Panel。
- [ ] draft Course 阻止 Offer 啟用並給明確修正連結。 已阻止並說明；修正連結未做。
- [ ] Course 顯示被哪些 Product/Offer 使用。 查詢已完成，畫面未做。

## 6. 公開 API 與商城

- [x] 擴充 Product detail 的 Course public shape。
- [x] 隱藏鎖定 Lesson HTML 與所有 private object key。
- [x] ProductPage 新增學習成果、適合對象、介紹、講師、大綱。
- [x] 多課程 bundle 顯示每門課程。
- [ ] Offer 選項顯示觀看期限與材料包差異。 未做。
- [ ] 試看入口先由 feature flag 保護。 商品頁標記了試看單元，播放入口未接。
- [ ] 驗證一般實體商品頁沒有額外 Course query。 已由測試涵蓋（無 course component 即不查）。

## 7. 測試

- [x] Course domain、outline 與發布驗證測試。
- [x] HTML sanitizer security tests。
- [ ] VideoAsset status reference tests。 已完成（`test_video_admin.py`）。
- [ ] Offer enable 與 Course status tests。 已完成（`test_offers.py`）。
- [x] 公開 API data minimization tests。
- [ ] Course editor 主要互動測試。 編輯器互動尚未實作。
- [x] ProductPage 純實體／單課程／多課程／混合快照測試。
- [ ] 使用真實長中文、空章節與大量單元檢查版面。 需人工檢視。

## 8. Phase Gate

- [ ] 至少建立一門完整測試課程。 blocker：需編輯器寫入功能與 staging。
- [ ] 所有影片均從 Video Library 選取，不接受手貼 R2 key。 blocker：需 Phase 4 資源。
- [ ] 發布驗證能攔住 processing/failed 影片。 已完成（`publish_problems`）。
- [ ] 商品頁不洩漏 locked lesson 內容。 已完成並有測試。
- [ ] phase6 未完成前不解除課程商品公開 feature flag。 旗標預設關閉。
