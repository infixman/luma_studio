# Phase 5 工作項目：課程編輯與商品頁

## 1. Migration 與 Domain

- [ ] 擴充 `courses` 展示與講師欄位。
- [ ] 建立 `course_sections`。
- [ ] 建立 `course_lessons` 與 VideoAsset reference index。
- [ ] 建立 Course row mapper、欄位驗證與狀態轉移。
- [ ] 建立 outline 完整驗證與 position 正規化。
- [ ] 建立 lesson count、duration 等衍生計算。
- [ ] 建立 Course/VideoAsset/Offer references 查詢。

## 2. HTML 安全

- [ ] 選定與 Worker 執行環境相容的 sanitizer。
- [ ] 定義 tag、attribute、protocol allowlist。
- [ ] 限制圖片引用為已知 MediaItem。
- [ ] 清理外部連結並加安全 rel。
- [ ] 加入 script、event、style、javascript URL 與 malformed HTML 測試。
- [ ] 確保歷史草稿重新儲存時也經過同一 sanitizer。

## 3. 管理 API

- [ ] 完成 Course list/create/detail/update。
- [ ] 完成 outline get/put。
- [ ] 完成 publish/archive。
- [ ] publish 回傳結構化 validation errors。
- [ ] Offer enable 時驗證 Course published。
- [ ] Course archive 前回傳 Offer 與 entitlement 影響摘要。
- [ ] 公開 API 不回傳 private R2 key。

## 4. Course 管理前端

- [ ] 建立 Course list 頁。
- [ ] 建立 Course create/edit 頁。
- [ ] 建立基本資料與課程銷售資訊欄位。
- [ ] 整合 HTML rich text editor。
- [ ] 建立章節與單元新增、刪除、拖曳排序。
- [ ] 建立 VideoAsset picker。
- [ ] 顯示影片狀態、時長、尺寸與 poster。
- [ ] 支援試看設定。
- [ ] 顯示總單元與總時數。
- [ ] 顯示未儲存警告、預覽與發布檢查。

## 5. Product 管理整合

- [ ] Offer component picker 顯示完整 Course 摘要。
- [ ] 方案摘要顯示觀看期限與是否含實體品。
- [ ] draft Course 阻止 Offer 啟用並給明確修正連結。
- [ ] Course 顯示被哪些 Product/Offer 使用。

## 6. 公開 API 與商城

- [ ] 擴充 Product detail 的 Course public shape。
- [ ] 隱藏鎖定 Lesson HTML 與所有 private object key。
- [ ] ProductPage 新增學習成果、適合對象、介紹、講師、大綱。
- [ ] 多課程 bundle 顯示每門課程。
- [ ] Offer 選項顯示觀看期限與材料包差異。
- [ ] 試看入口先由 feature flag 保護。
- [ ] 驗證一般實體商品頁沒有額外 Course query。

## 7. 測試

- [ ] Course domain、outline 與發布驗證測試。
- [ ] HTML sanitizer security tests。
- [ ] VideoAsset status reference tests。
- [ ] Offer enable 與 Course status tests。
- [ ] 公開 API data minimization tests。
- [ ] Course editor 主要互動測試。
- [ ] ProductPage 純實體／單課程／多課程／混合快照測試。
- [ ] 使用真實長中文、空章節與大量單元檢查版面。

## 8. Phase Gate

- [ ] 至少建立一門完整測試課程。
- [ ] 所有影片均從 Video Library 選取，不接受手貼 R2 key。
- [ ] 發布驗證能攔住 processing/failed 影片。
- [ ] 商品頁不洩漏 locked lesson 內容。
- [ ] phase6 未完成前不解除課程商品公開 feature flag。
