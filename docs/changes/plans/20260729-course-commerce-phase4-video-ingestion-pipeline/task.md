# Phase 4 工作項目：影片上傳與轉檔

> **2026-07-30：不使用 Cloudflare Container**（見 `design.md` 開頭）。
> 下方所有與 Media Control Worker、Queue、Container、multipart 直傳、SigV4
> 相關的項目**不再適用**，標記為「不採用」而非未完成。

## 1. Cloudflare 資源

- [x] 建立 private `luma-course-source` R2 bucket。
- [x] 建立 private `luma-course-video` R2 bucket。
- [x] 設定限定 admin origin 的 CORS。（`docs/r2-course-source-cors.json`；本機轉檔用不到，但 source bucket 保留給日後自動化）
- [~] 建立 Media Control Worker。 **不採用**：改為本機轉檔。
- [~] 建立 Workflow／Queue 與 dead-letter 處理。 **不採用**：改為本機轉檔。
- [~] 建立 FFmpeg Container 與最低權限 binding。 **不採用**：改為本機轉檔。
- [~] 設定 secrets，不將 R2 S3 secret 放入前端或 repo。 **不採用**：改為本機轉檔。
- [~] 設定開發、preview、production 的獨立資源名稱。 **不採用**：改為本機轉檔。

## 2. Migration 與 Domain

- [x] 建立 `video_assets`。
- [x] 建立 `video_upload_sessions`。
- [x] 建立 `video_transcode_jobs`。
- [x] 建立狀態轉移函式與條件 UPDATE。
- [x] 建立版本化 source/output key 產生器。
- [x] 建立 asset reference 查詢接口。
- [ ] 定義 archive、source retention 與舊 encode cleanup 狀態。

## 3. Multipart 上傳控制

- [~] 實作建立 multipart upload。 **不採用**：改為本機轉檔。
- [x] 實作安全 part size 計算。
- [~] 實作單一 UploadPart presigned URL。 **不採用**：改為本機轉檔。
- [~] 實作 CompleteMultipartUpload 與 HEAD 驗證。 **不採用**：改為本機轉檔。
- [~] 實作 AbortMultipartUpload。 **不採用**：改為本機轉檔。
- [~] Complete 與 Abort 需冪等。 **不採用**：改為本機轉檔。
- [~] 限制單檔大小、同時 session 數與過期時間。 **不採用**：改為本機轉檔。
- [~] 建立未完成 session 清理工作。 **不採用**：改為本機轉檔。

## 4. Admin API 接線

- [~] Admin API 驗證管理員後呼叫 Media Worker。 **不採用**：改為本機轉檔。
- [~] Service Binding request 使用內部身份，Media Worker 不信任瀏覽器自稱管理員。 **不採用**：改為本機轉檔。
- [ ] 對外回應移除 R2 key、secret 與內部錯誤堆疊。
- [~] 加入 upload/create/part/complete/abort/status/retry/archive routes。 **不採用**：改為本機轉檔。
- [~] 加入合理 rate limit，避免 presign 與 Container 被濫用。 **不採用**：改為本機轉檔。

## 5. 上傳前端

- [ ] 建立 Video Library 頁。前端未做；列表與封存 API 已完成。
- [~] 實作檔案選擇與 drag-and-drop。 **不採用**：改為本機轉檔。
- [~] 實作分段、平行上傳、每 part retry。 **不採用**：改為本機轉檔。
- [~] 保存 session 與 ETag 供重整續傳。 **不採用**：改為本機轉檔。
- [~] 顯示整體與單檔進度。 **不採用**：改為本機轉檔。
- [~] 提供取消、繼續、重新上傳。 **不採用**：改為本機轉檔。
- [~] 處理 URL 到期後重新取得，不重傳已完成 part。 **不採用**：改為本機轉檔。
- [~] 完成後輪詢或訂閱轉檔狀態。 **不採用**：改為本機轉檔。

## 6. Container 與 FFmpeg

- [~] 固定 FFmpeg 版本與映像 digest。 **不採用**：改為本機轉檔。
- [x] 使用 ffprobe 驗證格式與收集 metadata。（`scripts/transcode-course-video.ps1`；畫質階梯由 ffprobe 的實際高度決定）
- [x] 實作不放大的 rendition ladder。（腳本與 `video.ladder_for` 同一套規則）
- [x] 產生 H.264/AAC fMP4 HLS。（keyframe 對齊 segment 邊界）
- [x] 產生 poster。
- [~] 分批上傳輸出，控制 ephemeral disk。 **不採用**：改為本機轉檔。
- [x] 驗證所有 playlist reference。（`video.verify_encode`：讀 master、逐一確認、一次回報全部缺漏）
- [x] 最後發布 master.m3u8。（腳本最後才寫；註冊端點驗證通過才標 ready）
- [~] 成功後以條件更新 active encode version。 **不採用**：改為本機轉檔。
- [~] 清理本機工作目錄與失敗版本。 **不採用**：改為本機轉檔。

## 7. 重試與清理

- [~] 實作 processing lease。 **不採用**：改為本機轉檔。
- [~] 分類 temporary/permanent error。 **不採用**：改為本機轉檔。
- [~] 實作 Queue retry 與 dead-letter。 **不採用**：改為本機轉檔。
- [~] 實作管理員手動 retry。 **不採用**：改為本機轉檔。
- [~] 建立 paid-independent 的媒體 job reconciliation。 **不採用**：改為本機轉檔。
- [ ] 建立未引用 asset、舊 encode version 與 source 的 lifecycle policy。
- [ ] 清理前再次檢查 CourseLesson reference。

## 8. 測試與驗收

- [x] 單元測試 key、part、狀態與 playlist validator。
- [~] 整合測試 multipart create/upload/complete/abort。 **不採用**：改為本機轉檔。
- [ ] 使用短、直式、無音軌、VFR、損壞影片 fixture。需實際媒體檔；playlist 驗證已有測試。
- [~] 驗證 Admin API request body 不承載影片。 **不採用**：改為本機轉檔。
- [~] 驗證 anonymous request 無法取得 upload URL。 **不採用**：改為本機轉檔。
- [~] 驗證 presigned URL 不能改 key 或 part number。 **不採用**：改為本機轉檔。
- [ ] 驗證 source/video bucket 無 public URL。
- [ ] 實際播放輸出的 master playlist，僅作轉檔品質驗收，不建立會員公開入口。
- [~] 記錄每分鐘來源影片的平均轉檔 CPU、時間與輸出容量，供成本估算。 **不採用**：改為本機轉檔。
