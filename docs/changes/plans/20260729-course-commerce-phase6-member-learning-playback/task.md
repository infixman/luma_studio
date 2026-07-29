# Phase 6 工作項目：會員課程中心與安全播放

## 1. Migration 與 Entitlement Query

- [ ] 建立 `course_lesson_progress`。
- [ ] 建立有效 entitlement 的集中查詢。
- [ ] 確認永久、期限未啟動、期限已啟動、撤銷與 blocked customer 規則。
- [ ] 實作首次觀看啟動期限的條件 UPDATE（`access_days IS NOT NULL AND first_viewed_at IS NULL AND revoked_at IS NULL`）。
- [ ] 啟動倒數寫 audit。
- [ ] 建立 Course progress summary query，避免每張卡 N+1。
- [ ] 建立 last viewed Lesson 與 completed count 計算。

## 2. Learning API

- [ ] 建立「我的課程」list endpoint。
- [ ] 建立已授權 Course detail endpoint。
- [ ] 建立 Lesson content endpoint。
- [ ] 所有 endpoint 從 session 取得 customer id。
- [ ] 過期、撤銷、封存與 blocked 狀態回傳一致錯誤。
- [ ] 公開 response 移除 R2 source/master key。

## 3. Playback Session

- [ ] 定義版本化 token payload。
- [ ] 實作 HMAC 簽章與 constant-time 驗證。
- [ ] 實作 current/previous key rotation。
- [ ] 建立 playback-session endpoint。
- [ ] 驗證 Course/Lesson/VideoAsset 引用與 active version。
- [ ] 授權通過且 session 核發成功後才啟動期限倒數；preview scope 不啟動。
- [ ] session refresh 不重設 `first_viewed_at`／`expires_at`。
- [ ] 設定 Secure、HttpOnly、限定 Path 的短效 cookie。
- [ ] 實作 session refresh。
- [ ] log redaction 移除 cookie/token。

## 4. Playback Gateway

- [ ] 建立 `/course-media/{asset}/{version}/*` route。
- [ ] 嚴格解析並驗證 object path。
- [ ] 驗證 cookie signature、expiry、asset/version。
- [ ] 由 private R2 binding 讀取 HLS object。
- [ ] 正確處理 Content-Type、ETag、Range 與 Cache-Control。
- [ ] 授權後才查 Cache API。
- [ ] 只 cache 成功 immutable media response。
- [ ] 確認 401/403/404 不進共享 cache。
- [ ] 實作 preview scope。

## 5. Progress

- [ ] 建立 progress upsert endpoint。
- [ ] 驗證 position 與 Lesson duration。
- [ ] 建立 completed endpoint 或合併 request。
- [ ] 加入合理 rate limit。
- [ ] 前端每 15～30 秒、pause、ended、離開時節流保存。
- [ ] 純 HTML Lesson 支援完成狀態。

## 6. 會員前端

- [ ] 新增 `/account/courses`。
- [ ] 新增 Course 學習頁與 Lesson route。
- [ ] 建立桌機側欄與手機收合目錄。
- [ ] 整合 HLS player 並帶 credentials。
- [ ] 處理 session refresh、401/403 與播放錯誤。
- [ ] 顯示觀看進度與完成狀態。
- [ ] 課程卡顯示永久／「觀看後 N 天內有效」／已啟動到期日三種期限狀態。
- [ ] 建立上一單元／下一單元操作。
- [ ] 從訂單付款成功頁連到「我的課程」。
- [ ] 完成鍵盤、焦點與螢幕閱讀器基本驗證。

## 7. 安全與快取測試

- [ ] 未登入與未購買測試。
- [ ] 過期、撤銷與 blocked customer 測試。
- [ ] 首次播放啟動倒數、第二次不變更、併發只啟動一次測試。
- [ ] 列表／detail／preview 不啟動倒數測試。
- [ ] archived Course 的既有 entitlement 仍可播放測試。
- [ ] 修改 token payload/signature 測試。
- [ ] token 過期與 refresh 測試。
- [ ] 分享 URL 無 cookie 測試。
- [ ] path traversal 與 asset/version 越權測試。
- [ ] preview 越權測試。
- [ ] 先由有權會員 warm cache，再由無權會員請求，必須仍為 403。
- [ ] 確認 log 不含播放 cookie 或簽章。

## 8. E2E 驗收

- [ ] 建立測試會員與已付款課程訂單。
- [ ] 確認 entitlement 出現在我的課程。
- [ ] 播放至少兩個不同 VideoAsset。
- [ ] 重整、切換裝置後恢復進度。
- [ ] 撤銷 entitlement，等待 token 到期後無法續播，且觀看進度未被刪除。
- [ ] 建立期限型測試授權，確認付款後 `expires_at` 為 NULL、首次播放後才寫入。
- [ ] 確認 private R2 object 無法直接公開存取。
- [ ] 記錄一般 HLS 可被授權會員保存的風險，不將本階段描述為 DRM。
- [ ] 通過後才解除課程商品公開 feature flag。
