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

TOTP，30 秒週期，6 位數字，每個管理員一組 seed。

**Seed 不儲存。** 它是 `HMAC(DESKTOP_PAIRING_SECRET, "purpose:email")` 導出的，
所以沒有表、沒有遷移、沒有「只顯示一次」的流程，D1 被 dump 也不含任何 seed。
每個管理員的 seed 仍然不同，因為 email 是導出的一部分。

（早一版的規格寫「以雜湊形式保存」，那是錯的：TOTP 驗證需要 seed 原文，
雜湊過就驗不了。導出比儲存原文更好，所以改成導出。）

撤銷有兩層：換掉 secret 一次撤銷所有配對；把某個 email 移出管理員允許清單，
他就配對不了 —— 允許清單在驗證時檢查，不只在登入時。

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
GET    /api/video-assets/{assetId}/source-url
POST   /api/video-assets/{assetId}/archive
POST   /api/video-assets/{assetId}/abort
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

### 取得原始檔（重新轉檔用）

`GET /api/video-assets/{assetId}/source-url` 回傳一張短效 presigned GET URL。

```json
{"url": "…", "expiresAt": 1785296400, "byteSize": 2147483648}
```

必須驗證：

- 只簽這個 asset 自己的 `source_key`。**不接受任何 caller 指定的 key。**
- asset 有原始檔。沒上傳過原始檔的 asset 回 404，訊息要說得出是「沒有原始檔」
  而不是「沒有這支影片」。
- 期限短。
- 這是影片範圍 token 唯一的讀取權限；它不能讀 output bucket，也不能讀別的 asset。

### 重新轉檔

沿用既有端點，不需要新的狀態或表：

1. `GET /source-url` 取得原始檔。
2. `POST /api/video-assets`（帶 `assetId` 與新的 `encodeVersion`）建立新版本。
3. 照一般流程 `upload-urls` → PUT → `import`。
4. import 驗證通過才切換 `active_encode_version`。

期間舊版本保持可播放。新版本驗證失敗不影響會員。

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
uploading/uploaded/queued -> aborted（管理員放棄這次上傳）
queued/processing -> failed
failed -> queued
ready -> queued（新 encode version）
ready -> archived
```

任何不合法轉移回 409。`ready` 只有在 master playlist 與所有引用 object 驗證完成後
才能寫入，而且只有 import 端點能寫。

`aborted` 與 `archived` 是終點，而 import 是唯一繞過狀態機的地方 —— 所以 import 會
**拒絕**已經是這兩個狀態的 asset（409）。沒有這道檢查，放棄一次上傳只是改一列，
而握著 presigned URL 的工具傳完再 import，那支影片就自己回到 `ready`。

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

## 儲存總覽規格

### `GET /api/video-storage/summary`

```json
{
  "source": {"bytes": 214748364800, "objects": 42},
  "output": {"bytes": 96636764160, "objects": 8734},
  "orphans": {"sourceBytes": 5368709120, "outputBytes": 12884901888, "scannedAt": 1785296400, "truncated": false},
  "estimate": {
    "monthlyUsd": 4.32,
    "pricePerGbMonthUsd": 0.015,
    "freeGb": 10,
    "excludesOperations": true
  },
  "growth": {"bytesThisMonth": 21474836480}
}
```

- `source` 與 `output` 由 D1 加總，不列 bucket：原始檔看 `video_assets.byte_size`，
  輸出看 `video_encode_versions.byte_size`。開這個頁面不產生 R2 的 list 操作。
- `orphans` 是**上一次跑完的盤點**的結果，帶盤點時間與 `truncated`（那次有沒有掃完／記完）。沒盤點過就回 null，畫面顯示
  「尚未盤點」而不是 0 —— 0 看起來像「沒有孤兒」。
- 單價與免費額度是設定值，不是程式裡的常數。R2 的價目會變，一個過期的數字比
  沒有數字更糟，因為它看起來像事實。
- `excludesOperations` 是提醒畫面要標明估算範圍，不要把它說成帳單。

### `GET /api/video-storage/orphans?bucket=source|output`

回上一次盤點找到的孤兒物件：key、大小、最後修改時間。兩個桶用同一個端點，
因為判斷方式一樣。

### `POST /api/video-storage/scan`

真的去列 bucket，比對 D1，寫下結果。這是唯一會產生大量 list 操作的地方，所以是
一個明確的動作，不是任何頁面的副作用。

孤兒的判斷：

- 輸出桶：`videos/{assetId}/{version}/` 底下有物件，但 `video_encode_versions`
  沒有對應的一列。
- 原始檔桶：`sources/{assetId}/{uploadVersion}/` 底下有物件，但沒有 asset 指向它。
- **排除仍在 `uploading` 的 asset**，並對還沒進 D1 的 prefix 加 24 小時的年齡門檻。
  正在上傳中的版本長得跟孤兒一模一樣，寧可漏掉一個，不要刪掉一支正在傳的影片。

### `GET /api/video-storage/cleanup-candidates`

分類回傳，前端不自己判斷安全程度：

```json
{
  "safe": [
    {"kind": "orphan", "bucket": "output", "keys": 312, "bytes": 12884901888},
    {"kind": "supersededVersion", "assetId": "…", "encodeVersion": 1, "bytes": 8589934592}
  ],
  "needsJudgement": [
    {"kind": "unusedSource", "assetId": "…", "title": "…", "bytes": 5368709120,
     "consequence": "刪除後這支影片無法再重新轉檔"}
  ]
}
```

- `safe` 可以批次執行。
- `needsJudgement` 每一項單獨確認，確認文字帶影片名稱與 `consequence`。不提供全選。
- **課程還在用的原始檔不出現在任何一邊**，也沒有刪除端點會接受它。不是靠警告擋，
  是不給入口。

## 影片庫清單規格

`GET /api/video-assets` 已存在，用於輸出導向的一般清單。原始檔頁另外需要：

`GET /api/video-storage/sources` 一列一支原始檔：

| 欄位 | 來源 |
| --- | --- |
| `bytes` | `video_assets.byte_size` |
| `hasPlayableVersion` | 有沒有 active encode version |
| `activeEncodeVersion` | `video_assets.active_encode_version` |
| `versionCount` / `versionBytes` | `video_encode_versions` 加總 |
| `lessons` | 使用它的課程單元，含課程與單元名稱 |
| `createdAt` | 上傳時間 |

`lessons` 要能點進去看，不能只回數量。刪除的決定不會建立在「3 個單元」上，
會建立在「那門課去年就下架了」上。

`GET /api/video-storage/versions?assetId=` 一列一個 encode version：物件數、位元組、
驗證時間、是不是 active、是不是已被取代。

## 保存規格

| 物件 | 政策 |
| --- | --- |
| 課程還在用的原始檔 | 不刪，也不提供刪除入口 |
| 沒有課程使用的原始檔 | 可刪，但需逐項確認並顯示「無法再重新轉檔」 |
| 目前 active 的 encode version | 不刪 |
| 被取代的舊 encode version | 切換成功後過了 rollback 期可刪 |
| 兩個桶的孤兒物件 | 可刪 |
| 過期未完成的 multipart session | 可清理 |

清理程式：

- 刪除前重新查一次 asset 與 lesson 的引用，不信任清單產生時的快照。
- 一律先出 dry-run 清單，人看過才執行。
- 錯誤方向必須是少刪一個，不是多刪一個。

不設定任何依時間刪除的 lifecycle rule。刪除一律由人在後台按下，而後台要先說清楚
按下去會失去什麼。設 lifecycle rule 等於讓重新轉檔對舊影片默默失效，
而那要到有人按下重新轉檔的那天才會發現。

## 管理前端規格

影片庫顯示：

- 標題、原始檔名、大小。
- uploading/uploaded/queued/processing/ready/failed/aborted/archived。
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
- `source-url` 忽略 caller 提供的任何 key，只簽該 asset 的 `source_key`。
- 影片範圍 token 不能用 presigned GET 讀 output bucket 或別的 asset。
- 清理程式在引用存在時不刪除。
- 孤兒盤點不把仍在 `uploading` 的 asset 或 24 小時內的物件算成孤兒。
- 課程還在用的原始檔不出現在 cleanup candidates，且刪除端點拒絕它。
- 儲存總覽由 D1 加總，不觸發 R2 list 操作。
- 沒盤點過時 `orphans` 回 null，不回 0。
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
- 重新轉檔期間舊版本一直可播放。
- 有 asset 指向的原始檔不會被任何清理程式刪掉。
- 安裝檔可從後台取得，工具能自我更新。
- 課程尚未引用影片，會員端也沒有公開播放入口。
