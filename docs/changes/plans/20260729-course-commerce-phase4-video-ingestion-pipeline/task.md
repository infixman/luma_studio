# Phase 4 工作項目：影片上傳與轉檔

## 1. Cloudflare 資源

- [ ] 建立 private `luma-course-source` R2 bucket。
- [ ] 建立 private `luma-course-video` R2 bucket。
- [ ] 設定限定 admin origin 的 CORS。
- [ ] 建立 Media Control Worker。
- [ ] 建立 Workflow／Queue 與 dead-letter 處理。
- [ ] 建立 FFmpeg Container 與最低權限 binding。
- [ ] 設定 secrets，不將 R2 S3 secret 放入前端或 repo。
- [ ] 設定開發、preview、production 的獨立資源名稱。

## 2. Migration 與 Domain

- [x] 建立 `video_assets`。
- [x] 建立 `video_upload_sessions`。
- [x] 建立 `video_transcode_jobs`。
- [x] 建立狀態轉移函式與條件 UPDATE。
- [x] 建立版本化 source/output key 產生器。
- [x] 建立 asset reference 查詢接口。
- [ ] 定義 archive、source retention 與舊 encode cleanup 狀態。

## 3. Multipart 上傳控制

- [ ] 實作建立 multipart upload。
- [x] 實作安全 part size 計算。
- [ ] 實作單一 UploadPart presigned URL。
- [ ] 實作 CompleteMultipartUpload 與 HEAD 驗證。
- [ ] 實作 AbortMultipartUpload。
- [ ] Complete 與 Abort 需冪等。
- [ ] 限制單檔大小、同時 session 數與過期時間。
- [ ] 建立未完成 session 清理工作。

## 4. Admin API 接線

- [ ] Admin API 驗證管理員後呼叫 Media Worker。
- [ ] Service Binding request 使用內部身份，Media Worker 不信任瀏覽器自稱管理員。
- [ ] 對外回應移除 R2 key、secret 與內部錯誤堆疊。
- [ ] 加入 upload/create/part/complete/abort/status/retry/archive routes。
- [ ] 加入合理 rate limit，避免 presign 與 Container 被濫用。

## 5. 上傳前端

- [ ] 建立 Video Library 頁。
- [ ] 實作檔案選擇與 drag-and-drop。
- [ ] 實作分段、平行上傳、每 part retry。
- [ ] 保存 session 與 ETag 供重整續傳。
- [ ] 顯示整體與單檔進度。
- [ ] 提供取消、繼續、重新上傳。
- [ ] 處理 URL 到期後重新取得，不重傳已完成 part。
- [ ] 完成後輪詢或訂閱轉檔狀態。

## 6. Container 與 FFmpeg

- [ ] 固定 FFmpeg 版本與映像 digest。
- [ ] 使用 ffprobe 驗證格式與收集 metadata。
- [ ] 實作不放大的 rendition ladder。
- [ ] 產生 H.264/AAC fMP4 HLS。
- [ ] 產生 poster。
- [ ] 分批上傳輸出，控制 ephemeral disk。
- [ ] 驗證所有 playlist reference。
- [ ] 最後發布 master.m3u8。
- [ ] 成功後以條件更新 active encode version。
- [ ] 清理本機工作目錄與失敗版本。

## 7. 重試與清理

- [ ] 實作 processing lease。
- [ ] 分類 temporary/permanent error。
- [ ] 實作 Queue retry 與 dead-letter。
- [ ] 實作管理員手動 retry。
- [ ] 建立 paid-independent 的媒體 job reconciliation。
- [ ] 建立未引用 asset、舊 encode version 與 source 的 lifecycle policy。
- [ ] 清理前再次檢查 CourseLesson reference。

## 8. 測試與驗收

- [x] 單元測試 key、part、狀態與 playlist validator。
- [ ] 整合測試 multipart create/upload/complete/abort。
- [ ] 使用短、直式、無音軌、VFR、損壞影片 fixture。
- [ ] 驗證 Admin API request body 不承載影片。
- [ ] 驗證 anonymous request 無法取得 upload URL。
- [ ] 驗證 presigned URL 不能改 key 或 part number。
- [ ] 驗證 source/video bucket 無 public URL。
- [ ] 實際播放輸出的 master playlist，僅作轉檔品質驗收，不建立會員公開入口。
- [ ] 記錄每分鐘來源影片的平均轉檔 CPU、時間與輸出容量，供成本估算。
