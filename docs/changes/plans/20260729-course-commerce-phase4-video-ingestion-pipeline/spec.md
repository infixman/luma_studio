# Phase 4 規格：Video Ingestion Pipeline

## 目標

實作可續傳的瀏覽器直傳 private R2、可靠 FFmpeg 轉檔與可管理的 VideoAsset 狀態，
但不在本階段開放會員播放。

## 部署規格

### Media Control Worker

建議名稱：`luma-studio-media-control`

Bindings：

- D1：與管理 API 共用必要的 video tables，或透過 service API 存取。
- R2 source bucket。
- R2 video bucket。
- Workflow／Queue。
- Container binding。
- R2 S3 API signing credentials 以 secret 保存。

Media Worker 不接受公開瀏覽器直接呼叫的管理 session；入口由 Admin API 驗證後使用
Service Binding 呼叫，或使用短效內部簽章。

### Container

映像需固定：

- FFmpeg/ffprobe 版本。
- 所需 codec。
- entrypoint 與 health check。
- 非 root 執行。
- 每個 job 使用唯一工作目錄。
- 工作結束不依賴本機磁碟保存成果。

## API 規格

管理 API 對前端：

```text
GET    /api/video-assets?q=&status=&cursor=
POST   /api/video-assets/uploads
POST   /api/video-assets/uploads/{sessionId}/parts/{partNumber}
POST   /api/video-assets/uploads/{sessionId}/complete
POST   /api/video-assets/uploads/{sessionId}/abort
GET    /api/video-assets/{assetId}
POST   /api/video-assets/{assetId}/retry
POST   /api/video-assets/{assetId}/archive
GET    /api/video-assets/{assetId}/references
```

### 建立 Upload

Request：

```json
{
  "filename": "lesson-01.mp4",
  "byteSize": 2147483648,
  "contentType": "video/mp4",
  "lastModified": 1785292800000
}
```

Response：

```json
{
  "assetId": "asset-id",
  "sessionId": "session-id",
  "partSize": 16777216,
  "expiresAt": 1785296400
}
```

伺服器依 byte size 決定 part size，確保不超過 R2 multipart 最大 part 數。R2 目前允許
最多 10,000 parts，單一 part 除最後一段外至少 5 MiB；實作前以官方
[R2 Limits](https://developers.cloudflare.com/r2/platform/limits/) 再確認。

### 取得 Part URL

必須驗證：

- session 屬於目前管理操作。
- session 仍為 uploading。
- part number 在允許範圍。
- URL 尚未被過度核發。

Response 只回傳單一 UploadPart presigned URL 與到期時間。

### Complete

Request：

```json
{
  "parts": [
    {"partNumber": 1, "etag": "\"...\""}
  ]
}
```

伺服器：

1. 驗證 part number 唯一、連續且數量合理。
2. 呼叫 CompleteMultipartUpload。
3. HEAD source object 驗證大小。
4. 將 asset 改為 uploaded。
5. 建立唯一 transcode job。

Complete endpoint 必須冪等。重送時回傳同一 asset 狀態，不建立兩個相同 encode job。

## D1 狀態規格

狀態轉移必須使用條件 UPDATE：

```text
uploading -> uploaded -> queued -> processing -> ready
uploading -> aborted
queued/processing -> failed
failed -> queued
ready -> queued（新 encode version）
```

任何不合法轉移回 409。`ready` 只有在 master playlist 與所有引用 object 驗證完成後
才能寫入。

## 轉檔輸出規格

- HLS master playlist。
- 每 rendition 獨立 media playlist。
- fMP4 init segment 與 `.m4s` segments。
- H.264 video、AAC audio，確保主流瀏覽器支援。
- 固定 keyframe 對齊 segment 邊界。
- rendition 不得放大來源。
- poster 使用 WebP，另保存寬高。
- master playlist 使用相對路徑。
- 所有檔案 Content-Type 正確。

轉檔命令不可直接拼接原始檔名或使用 shell interpolation。所有路徑由 asset id 與
encode version 產生。

## 重試與併發

- 同一 asset 同時最多一個 processing job。
- job 使用 lease/attempt 避免 Queue 重送造成兩個 Container 同時寫同一 version。
- retry 建立新的 attempt；需要重新編碼時使用新 encode version。
- Container timeout、OOM、FFmpeg 非零 exit、R2 寫入失敗要分類 error code。
- 指數退避只用於暫時性錯誤；不支援 codec、損壞來源等永久錯誤等待管理員處理。

## 管理前端規格

影片庫顯示：

- 標題、原始檔名、大小。
- 上傳進度。
- uploading/uploaded/queued/processing/ready/failed。
- duration、resolution、建立時間。
- failed 的可讀錯誤與重試操作。
- 被哪些課程單元引用；phase5 接上資料。

上傳器：

- multipart 並行數可設定。
- 每個 part 有 retry 上限與 backoff。
- 保存 sessionId、assetId、part size、已完成 ETag。
- 重整頁面可恢復。
- 使用者取消時呼叫 abort。
- 完成前不把 asset 顯示為可選。

## R2 CORS

至少：

- AllowedOrigins：正式 admin origin 與明確 localhost。
- AllowedMethods：multipart 所需 PUT/HEAD。
- AllowedHeaders：Content-Type、checksum 與實作使用的簽章 headers。
- ExposeHeaders：ETag。
- 不使用 `*` origin 搭配管理上傳。

## 測試範圍

### 單元與整合

- part size 計算與 10,000 parts 邊界。
- presign 只能作用於指定 key、part 與期限。
- Complete 冪等。
- 非法狀態轉移。
- ffprobe metadata parser。
- rendition 選擇不放大。
- playlist 完整性驗證。
- retry 與 lease。
- archive/reference 保護。

### 實際媒體 fixture

- 短 MP4。
- 直式影片。
- 只有 720p 的來源。
- 可變幀率。
- 沒有音軌。
- 損壞檔案。
- 偽裝成 MP4 的其他格式。

## 驗收標準

- 瀏覽器上傳 bytes 不經 Admin API Worker。
- 重新整理後可繼續未完成上傳。
- 一次成功上傳只建立一個轉檔工作。
- `ready` asset 的所有 playlist 和 segment 都存在。
- bucket 保持 private。
- 失敗工作可診斷、可重試，不會覆蓋目前 ready 版本。
- 課程尚未引用影片，會員端也沒有公開播放入口。
