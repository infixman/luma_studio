# Phase 4 規格：Video Ingestion Pipeline

## 目標

管理員能把一支高畫質 MP4 交給桌面工具，得到一組驗證過、可被課程單元選取的 HLS
輸出。本階段不開放會員播放。

## 部署規格

沒有新的 Worker。簽章、驗證與記帳都在既有的 Admin Worker 裡。

Admin Worker bindings：

- D1。
- R2 `COURSE_SOURCE`（原始檔）。
- R2 `COURSE_VIDEO`（HLS 輸出）。
- R2 S3 API access key / secret，以 secret 保存。

Public Worker 只綁 `COURSE_VIDEO`，沒有 S3 credentials，也沒有 source bucket。

桌面工具（`desktop/`）不持有任何 R2 credentials。

## 桌面工具驗證規格

### `GET /api/desktop/pairing-code`

需要管理員 session。回傳目前這位管理員的配對碼，供工具輸入。

```json
{"code": "418302", "expiresInSeconds": 17}
```

TOTP，30 秒週期，6 位數字，每個管理員一組 seed。Seed 存 D1，建立時顯示一次，
之後只以雜湊或加密形式保存於伺服器端。

### `POST /api/desktop/tokens`

不需要 session。

```json
{"email": "admin@example.com", "code": "418302"}
```

```json
{"token": "…", "expiresAt": 1785296400, "scope": "video", "adminEmail": "admin@example.com"}
```

必須：

- email 在管理員允許清單內。
- 接受目前與前一個時間窗的碼，時鐘偏移不該算成錯誤。
- 固定時間比較。
- 同一組碼用過即失效，不能換第二個 token。
- 每個 email 有失敗次數上限與鎖定時間。六位數字擋不住無限次猜測。

Token scope 只有 `video`。任何非影片路由收到它一律 403，不是 401 —— 身分是真的，
權限不是。

## 影片 API 規格

```text
GET    /api/video-assets?q=&status=&cursor=
POST   /api/video-assets
POST   /api/video-assets/{assetId}/upload-urls
POST   /api/video-assets/import
GET    /api/video-assets/{assetId}
POST   /api/video-assets/{assetId}/archive
GET    /api/video-assets/{assetId}/references
GET    /api/video-storage?prefix=
```

`POST /api/video-assets`、`upload-urls`、`import`、`video-storage` 接受影片範圍
token 或管理員 session。其餘只接受管理員 session。

### 建立 Asset

Request：

```json
{
  "title": "第一課 起稿",
  "originalFilename": "lesson-01.mp4",
  "byteSize": 2147483648,
  "durationSeconds": 1830,
  "width": 3840,
  "height": 2160,
  "encodeVersion": 1
}
```

Response：

```json
{"assetId": "asset-id", "encodeVersion": 1, "status": "uploading"}
```

尺寸與長度來自工具的 ffprobe，只作為顯示與畫質階梯的依據，不是信任來源；
`ready` 的判斷完全靠註冊時的物件驗證。

### 取得 Upload URL

Request：

```json
{"keys": ["videos/asset-id/1/1080p/segment-000001.m4s"], "kind": "output"}
```

Response 每個 key 一張短效 presigned PUT URL 與到期時間。

必須驗證：

- `kind` 決定 bucket：`source` 進 `COURSE_SOURCE`，`output` 進 `COURSE_VIDEO`。
- 每個 key 都在該 asset 與該 encode version 的前綴底下。工具送任何其他 key 一律 400。
- key 的形狀在允許清單內（master、rendition playlist、init、segment、poster、source）。
- asset 仍為 `uploading`。
- 期限短。URL 就是 bearer token。
- 一次核發的數量有上限，避免一個請求換到幾千張 URL。

簽章用 SigV4。HMAC-SHA256 由標準庫 `hmac` / `hashlib` 完成，與播放 token 同一套
可用的原始工具。

HLS 輸出的每個物件都很小，一次 PUT 就夠。原始檔不是 —— 一支 4K 課程影片可以是
好幾 GB，用單一 PUT 傳等於「傳到 87% 斷線就從頭開始」。所以原始檔走 multipart：

```text
POST /api/video-assets/{assetId}/source-upload
POST /api/video-assets/{assetId}/source-upload/{sessionId}/parts/{partNumber}
POST /api/video-assets/{assetId}/source-upload/{sessionId}/complete
POST /api/video-assets/{assetId}/source-upload/{sessionId}/abort
```

Part size 由 byte size 推算，確保不超過 R2 的 multipart 上限（目前最多 10,000
parts，除最後一段外每段至少 5 MiB；實作前以官方
[R2 Limits](https://developers.cloudflare.com/r2/platform/limits/) 再確認）。
Complete 與 Abort 必須冪等，session 記在 `video_upload_sessions`，R2 secret 不入 D1。

### 註冊（Import）

Request：

```json
{
  "assetId": "asset-id",
  "title": "第一課 起稿",
  "originalFilename": "lesson-01.mp4",
  "durationSeconds": 1830,
  "width": 3840,
  "height": 2160,
  "encodeVersion": 1
}
```

伺服器：

1. 讀 `videos/{assetId}/{encodeVersion}/master.m3u8`。
2. 跟著每個 rendition playlist 走一遍，收集 init segment 與所有分段。
3. HEAD 每一個被引用的物件。
4. 全部存在才寫 `ready` 並設定 `active_encode_version`。

缺漏時回 409，並且**一次列出所有缺漏**，不是第一個：

```json
{"error": "這個版本還缺 3 個檔案", "missing": ["…"], "assetId": "asset-id"}
```

Import 必須冪等。重送同一 asset 與 encode version 時重新驗證並回同一狀態，
不建立第二個 asset。

`assetId` 省略時建立新 asset；帶了但不存在時回 404 —— 免得打錯字默默生出孤兒。

### R2 瀏覽

`GET /api/video-storage?prefix=` 列出物件的 key、大小與修改時間，不回 presigned URL。

工具只能讀與新增。修改與刪除不在這條 API 上，因為刪除前要檢查課程單元的引用，
那個檢查屬於後台的封存流程。

## 桌面工具版本規格

### `GET /api/desktop/version-policy`

```json
{
  "latest": "1.2.0",
  "minSupported": "1.0.0",
  "forceUpdate": false,
  "blocked": false,
  "feedUrl": "https://admin-api.luma-studio.tw/releases",
  "notes": "…"
}
```

存在 D1 一列，後台可讀可改。低於 `minSupported` 的工具停止工作並要求更新；
`blocked` 讓一個壞版本立刻停下來，不必等每台機器自己更新。

### `GET /releases/{version}/{file}`

從 R2 串出安裝檔與 electron-updater 需要的 metadata。`version` 以正規表示式限制，
`file` 走檔名白名單，兩者都不接受路徑分隔字元。這是唯一公開的影片無關路由。

## D1 狀態規格

狀態轉移必須使用條件 UPDATE：

```text
uploading -> uploaded -> queued -> processing -> ready
uploading -> aborted
queued/processing -> failed
failed -> queued
ready -> queued（新 encode version）
ready -> archived
```

任何不合法轉移回 409。`ready` 只有在 master playlist 與所有引用 object 驗證完成後
才能寫入，而且只有 import 端點能寫。

## 轉檔輸出規格

- HLS master playlist。
- 每 rendition 獨立 media playlist。
- fMP4 init segment 與 `.m4s` segments。
- H.264 video、AAC audio。
- 固定 keyframe 對齊 segment 邊界。
- rendition 不得放大來源。
- poster 使用 WebP，另保存寬高。
- master playlist 使用相對路徑，固定一層資料夾深。
- 所有檔案 Content-Type 正確。

轉檔命令不可拼接原始檔名或使用 shell interpolation。所有路徑由 asset id 與
encode version 產生。

## 環境依賴規格

工具第一次啟動時取得 FFmpeg 與 ffprobe：

- 只從我們的 R2 鏡像，不打包進安裝檔，不試官方連結。
- 版本與 SHA256 釘死在工具裡，對不上就不執行也不重試。
- 下載可中斷續傳，失敗訊息要說得出是網路還是雜湊不符。
- LICENSE 與對應原始碼壓縮檔一併鏡像，路徑出現在「關於」畫面。

## 重試

- 上傳中斷後可續傳：已完成的 key 記在工具本機，重開接著傳，不重新轉檔。
- 驗證缺漏後只補傳缺的物件，然後重新 import。
- 需要重新編碼時使用新的 encode version，舊版本保持可播放直到新版本驗證通過。
- 本機轉檔失敗就在本機重跑，不需要伺服器端的 queue 與 backoff。

## 管理前端規格

影片庫顯示：

- 標題、原始檔名、大小。
- uploading/uploaded/queued/processing/ready/failed/archived。
- duration、resolution、建立時間。
- failed 的可讀錯誤。
- 被哪些課程單元引用；phase5 接上資料。

頁面開著時每三秒輪詢一次，離開頁面停止。

桌面工具版本區顯示目前政策、安裝檔下載連結，並可修改政策。

## R2 CORS

`AllowedOrigins` 為正式 admin origin 與明確 localhost，`AllowedMethods` 為 PUT/HEAD，
`ExposeHeaders` 含 ETag，不使用 `*`。設定見 `docs/r2-course-source-cors.json`。

Electron 的上傳不受瀏覽器 CORS 限制，但後台若日後直接上傳就需要，且設定本身
就是 bucket 不對外開放的一部分。

## 測試範圍

### 單元與整合

- 配對碼：正確、過期、前一窗、重放、次數上限、固定時間比較。
- Token scope：影片 token 打非影片路由回 403。
- Presign：只作用於指定 bucket、key、method 與期限；越界 key 被拒。
- key 形狀允許清單。
- Import 冪等。
- 非法狀態轉移。
- playlist 完整性驗證，含缺 init segment、缺中段、master 指向不存在的 rendition。
- rendition 選擇不放大。
- archive/reference 保護。
- releases 路由拒絕路徑穿越與非白名單檔名。
- 版本政策的 min/force/blocked 判斷。

### 實際媒體 fixture

- 短 MP4。
- 直式影片。
- 只有 720p 的來源。
- 可變幀率。
- 沒有音軌。
- 損壞檔案。
- 偽裝成 MP4 的其他格式。

## 驗收標準

- 影片 bytes 不經 Admin API Worker。
- 工具內找不到 R2 credentials；反編譯安裝檔也找不到。
- 影片 token 不能執行任何非影片操作。
- 關掉工具再開，未完成的上傳可以接著傳。
- 一次成功上傳只建立一個 asset。
- `ready` asset 的所有 playlist 和 segment 都存在。
- source 與 video bucket 都沒有 public URL。
- 缺檔的上傳會被拒絕，並一次列出所有缺漏。
- 失敗不會覆蓋目前 ready 的版本。
- 安裝檔可從後台取得，工具能自我更新。
- 課程尚未引用影片，會員端也沒有公開播放入口。
