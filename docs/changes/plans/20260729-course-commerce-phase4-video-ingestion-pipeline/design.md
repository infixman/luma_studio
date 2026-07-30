# Phase 4：課程影片上傳與轉檔管線設計

日期：2026-07-30

## 原始需求

- 管理員能把課程影片交給系統，不用手動記一堆指令。
- 大型影片不經過 Python Worker 的 request body。
- 原始 MP4 存入 private R2。
- 多畫質轉檔與 HLS 分片。
- 儲存與播放成本要低，不採用按觀看分鐘計費的 Cloudflare Stream。
- 上傳需要進度、失敗重試及續傳。
- 影片進入影片庫後，由課程單元選取。

## 轉檔跑在哪裡

Cloudflare 平台上沒有便宜的選項：

- **Stream** 按觀看分鐘計費。課程影片是長片、重複觀看，這條線的成本會跟著流量長。
- **Container + Queue** 可以跑 FFmpeg，但要付常駐費用，還要維護映像、lease、dead-letter、OOM 分類 —— 為了一週可能只跑幾支影片的工作。
- **Worker** 不能跑 FFmpeg，Python 或 TypeScript 都不行。

所以轉檔跑在管理員自己的機器上。素材本來就在那裡，CPU 已經付過錢了，而課程影片的量級（一支影片轉一次，一輩子）不值得為它養一個常駐執行環境。

這個決定唯一的代價是：轉檔的時候那台機器要開著。以目前的出片頻率，這不是代價。

## 為什麼是桌面工具

「在本機轉檔」不等於「叫管理員自己跑腳本」。一支 PowerShell 腳本要求對方安裝 FFmpeg、裝 rclone、設好 R2 profile、記住 asset id、最後手動送一個 JSON 去註冊。每一步都能做對，但每一步也都能做錯，而做錯的結果是一支播到一半會斷的影片。

所以 ingest 是一個獨立的桌面程式（`desktop/`，Electron）：拖進一個高畫質 MP4，它負責檢查環境、轉檔、上傳、註冊、通知，中間不需要人記得任何事。

它不是「管理後台的另一個版本」。它只做搬影片進來這件事：

| 桌面工具 | 管理後台 |
| --- | --- |
| 轉檔、上傳、註冊新影片 | 影片庫瀏覽、改名、封存、刪除 |
| 瀏覽 R2、新增資料夾與檔案 | 修改與刪除既有物件 |
| 取得 presigned URL 上傳 | 核發 presigned URL、驗證結果 |

修改與刪除留在後台，因為刪一支影片之前要先確認沒有課程單元在用它 —— 那個檢查在後端，桌面工具沒有理由重做一份。

## 信任邊界

**R2 的 S3 金鑰不進入桌面工具。** 這是整個設計最硬的一條線。工具會裝在管理員的筆電上，安裝檔會放在網路上，任何寫進去的長效金鑰等於公開的長效金鑰。

工具拿到的是一個**只能做影片相關操作的短效 token**，不是管理員 session：

- 不能改商品、訂單、會員、授權。
- 不能核發別人的 token。
- 每一次 S3 操作都是向 Admin API 要一張限定 bucket、key、method、期限的 presigned URL。簽章在後端做，工具只是拿著 URL PUT。

換句話說，工具能做的事等於 Admin API 願意替它簽的事。這讓「工具被拿走」的最壞情況是「有人可以上傳影片」，而不是「有人可以改訂單」。

## 驗證身分

管理員身分目前存在 `admin_sessions`（email + 允許清單），沒有密碼表可以讓桌面工具去驗。桌面工具也不該內嵌一個瀏覽器登入流程 —— 那等於把管理員 session 搬進桌面。

改用配對碼：

1. 工具啟動，要求輸入管理員 email 與 6 位數字。
2. 管理員在後台一個頁面上讀那組數字。該頁面只有已登入的管理員看得到。
3. 工具把 email + 數字送去 Admin API，換到影片範圍的 token。

數字是 TOTP，每個管理員一組 seed，30 秒一換。這樣「能看到後台」就是「能授權一台機器」，不需要新的密碼、也不需要在桌面上保存可以登入後台的東西。

Seed 存在 D1（新表，一個管理員一列），只在建立時顯示過一次。

## 部署架構

```mermaid
flowchart LR
    Tool["桌面工具<br/>Electron + FFmpeg"] -->|"email + 配對碼"| AdminAPI["Python Admin API"]
    AdminAPI -->|"影片範圍 token"| Tool
    Tool -->|"要 presigned PUT"| AdminAPI
    Tool -->|"PUT 原始檔"| R2Source[("Private R2<br/>course-source")]
    Tool -->|"PUT HLS、poster"| R2Video[("Private R2<br/>course-video")]
    Tool -->|"註冊 / 完成通知"| AdminAPI
    AdminAPI -->|"讀 master、逐一確認"| R2Video
    AdminAPI --> D1[("D1<br/>video assets/jobs")]
    Web["Admin Web 影片庫"] -->|"輪詢"| AdminAPI
```

影片的 bytes 從工具直接進 R2，沒有一個 byte 經過 Worker 的 request body。Worker 只負責簽章、驗證與記帳。

### Presign 在 Python Worker 裡

SigV4 需要 HMAC-SHA256，標準庫的 `hmac` 與 `hashlib` 在這個 runtime 可以用 —— 播放 token 已經在用它們了。所以不需要為了簽章另外開一個 TypeScript Worker；R2 credentials 以 secret 存在 Admin Worker，只有 Admin Worker 看得到。

## R2 分層

| Bucket | 公開性 | 內容 | 保存 |
| --- | --- | --- | --- |
| `luma-course-source` | private | 原始 MP4 | 有 asset 指向就永久保留 |
| `luma-course-video` | private | HLS、縮圖、字幕 | 課程使用期間 |
| `luma-ibon-images` | 維持現況 | 圖片與 ibon | 不放課程影片 |

原始檔也上傳，因為**HLS 階梯沒辦法從 HLS 階梯重建**。加一階畫質、修一支轉壞的影片、補回 R2 掉掉的物件，每一件都要回到原始檔。

上傳原始檔同時也是備份：管理員的機器和 Cloudflare 是兩個不同的失效域，兩邊各一份就是真的兩份。但這只在**本機那份也留著**的時候成立 —— 上傳完就刪本機，等於換個地方放同一份。

Object key 不使用原始檔名：

```text
sources/{asset_id}/{upload_version}/source.mp4
videos/{asset_id}/{encode_version}/master.m3u8
videos/{asset_id}/{encode_version}/1080p/playlist.m3u8
videos/{asset_id}/{encode_version}/1080p/init.mp4
videos/{asset_id}/{encode_version}/1080p/segment-000001.m4s
videos/{asset_id}/{encode_version}/poster.webp
```

版本化 key 讓重新轉檔可以和目前可播放版本並存。只有新版本完整後才切換 `video_assets.active_encode_version`。

## 保存政策

不設定任何依時間刪除的 lifecycle rule。刪除一律由人在後台按下，而後台要先說清楚
按下去會失去什麼。

唯一的硬規則：**課程還在用的東西不刪。** 其餘的原始檔不是不能刪，是刪掉就永遠
不能再重新轉檔 —— 那是一個可以做的決定，但必須是有意識地做，而不是被一條
lifecycle rule 默默做掉。

成本形狀是線性而緩慢的：一年二十支 5GB 的影片約每月 1.5 美元，第五年累積約
每月 7.5 美元。所以「先不刪」撐得很久，真正的風險不是錢，是**沒有人會再回頭看
這個決定** —— 所以後台要一直把容量與費用擺在看得見的地方（見下節）。

孤兒物件是另一回事。上傳失敗、中途放棄、換了 upload version 之後被丟下的半個檔案，
都會靜靜留在 bucket 裡。工具只能新增不能刪除，所以這些只會累積。它們不是備份，
是垃圾。

刪除前一律再查一次引用，不信任清單產生時的快照。清理的錯誤方向必須是「少刪一個」，
不是「多刪一個」。

## 影片庫的三個畫面

### 總覽

第一眼要看到的是**現在花多少錢**，因為這是唯一會讓人想起該清東西的時機：

- 原始檔總容量、HLS 輸出總容量、兩者合計。
- 換算的每月儲存費用，扣掉免費額度。標明是估算，且不含操作費用。
- 趨勢：這個月增加了多少。
- 建議清理的清單，以及每一項刪掉會失去什麼。

單價是設定值，不是寫死在程式裡的常數。R2 的價目會變，而一個過期的數字比沒有
數字更糟 —— 它看起來像事實。

容量**不是靠列 bucket 算的**。一支影片幾百個物件，總覽頁每次開就列幾千個 key，
慢而且燒 Class B 操作。`verify_encode` 為了驗證本來就會 HEAD 每一個物件，那時候
就拿得到大小，所以總量在註冊時記進 D1，總覽只讀 D1。

需要真的列 bucket 的只有「找孤兒」 —— 那是一個明確的盤點動作，有進度、可以隔很久
跑一次，不是開頁面的副作用。

### 原始檔清單

一列一支原始檔，回答的是「這個檔還有沒有用」：

| 欄位 | 為什麼在這裡 |
| --- | --- |
| 容量 | 決定值不值得留 |
| 有沒有轉出可播放的版本 | 沒有的話這支影片還沒完成，不是舊檔 |
| 目前 active 的 encode version | 對照有沒有被取代 |
| 被哪些課程單元使用 | **這是能不能刪的判斷依據** |
| 上傳時間 | 排序用 |

「用在哪些課程」要點得進去看，不能只給一個數字。刪除的決定不會建立在
「3 個單元」上，會建立在「哦，那門課去年就下架了」上。

### 輸出清單

一列一個 encode version，因為可以刪的往往是版本而不是影片：active、被取代、
驗證失敗的殘骸，各自的容量與物件數。

輸出桶的孤兒跟原始檔桶一樣處理，同一份盤點、同一個清單分頁 —— 而且輸出桶的孤兒
會比原始檔桶多得多：一次中斷的上傳留下的是幾百個物件，不是一個。判斷方式也一樣：
R2 有、`video_encode_versions` 沒有對應的一列。

一個要小心的地方：**正在上傳中的版本長得跟孤兒一模一樣**，因為它的那一列還沒寫進去。
盤點必須排除仍在 `uploading` 的 asset，並且對還沒進入 D1 的 prefix 加一個寬鬆的
年齡門檻（例如 24 小時內不算孤兒）。清理程式寧可漏掉一個，不要刪掉一支正在傳的影片。

### 記容量的地方

`video_encode_versions`：一個 asset 的一個輸出版本一列，記物件數、位元組總量、
驗證時間、是不是 active。

版本目前是隱含的 —— 只有 `active_encode_version` 一個數字，被取代的版本在 D1 裡
沒有留下痕跡。要算容量、要列出「可以刪的舊版本」、要判斷輸出桶的孤兒，都需要
這些版本有名字。位元組總量在 `verify_encode` HEAD 每個物件時一併記下，不另外列 bucket。

原始檔的大小記在 `video_assets.byte_size`，已經有了。

### 建議刪除

分三種，安全程度差很多，畫面上不能混在一起：

| 類型 | 安全嗎 | 刪掉會失去什麼 |
| --- | --- | --- |
| 輸出桶的孤兒物件 | 安全 | 什麼都不會失去 |
| 原始檔桶的孤兒物件 | 安全 | 什麼都不會失去 |
| 被取代且過了 rollback 期的舊 encode version | 安全 | 退回舊版的能力 |
| 沒有任何課程單元使用的原始檔 | **要判斷** | 那支影片永遠不能重新轉檔 |

第三種要顯示得跟前兩種不一樣，而且不能有「全選」。前兩種可以一鍵清；
第三種每一項都要單獨確認，確認文字要寫出影片名稱和「不能再重新轉檔」。

課程還在用的原始檔**不出現在建議裡**，也不提供刪除按鈕。不是靠警告擋，是不給那個入口。

## 重新轉檔

原始檔在 R2 上，就讓「重新轉檔」從「找出當初那台筆電」變成「任何裝了工具的機器」。

流程幾乎全部沿用既有設計：工具下載原始檔、轉出新的 encode version、上傳、註冊。
版本化 key 讓新版本跟會員正在看的那版並存，`ready -> queued` 已經在狀態機裡，
`active_encode_version` 只在驗證通過後才切 —— 新版轉壞了傷不到任何人。

要補的只有一件事：**presigned GET**。目前只簽 PUT。

這會讓影片範圍的 token 多一項能力：下載原始檔。可以接受 —— 拿工具的人是管理員，
本來就有原始檔 —— 但它是刻意加的一條 scope，不是順便：

- 只能簽該 asset 自己的 source key，不能簽任意 key。
- 跟 PUT 一樣的短期限。
- 只有重新轉檔的入口會要它。

## Ingest 流程

```mermaid
sequenceDiagram
    actor Admin as 管理員
    participant Tool as 桌面工具
    participant API as Admin API
    participant R2 as R2
    participant Web as Admin Web

    Admin->>Tool: 拖入 MP4
    Tool->>Tool: ffprobe 讀真實格式與尺寸
    Tool->>API: 建立 asset（名稱、大小、長度、尺寸）
    API-->>Tool: assetId、encodeVersion
    Tool->>Tool: 依來源高度轉出不放大的畫質階梯
    loop 每個輸出物件
        Tool->>API: 要這個 key 的 presigned PUT
        API-->>Tool: 短效 URL
        Tool->>R2: PUT
    end
    Tool->>API: 註冊這個 encode version
    API->>R2: 讀 master、逐一 HEAD 每個被引用的物件
    API-->>Tool: ready，或一次列出所有缺漏
    Web->>API: 輪詢影片庫
```

進度、已完成的 key 與 asset id 保存在工具本機，所以關掉重開可以接著傳，不用重新轉檔。

### 為什麼註冊要重新驗證一次

一支影片會產生幾百個物件。上傳中斷、某一個 PUT 靜靜失敗、或使用者以為傳完了其實還差三個，都是日常。而少一個分段的影片會**播到那一段才斷** —— 最糟的發現時機是會員正在看。

所以 `ready` 不是工具說的，是後端算的：讀 master playlist、跟著每個 rendition playlist 走一遍、HEAD 每一個被引用的物件，然後**一次回報所有缺漏**。一次列全部而不是列第一個，是因為要讓人重跑一次上傳，而不是重跑六次。

## 狀態機

```mermaid
stateDiagram-v2
    [*] --> uploading
    uploading --> uploaded: 所有物件已 PUT
    uploading --> aborted: 使用者取消/過期
    uploaded --> queued
    queued --> processing
    processing --> ready: 所有輸出驗證通過
    processing --> failed: 驗證缺漏或本機轉檔失敗
    failed --> queued: 重新上傳
    ready --> queued: 建立新 encode version
    ready --> archived: 不再使用
```

轉移一律用條件 UPDATE。註冊端點是唯一能寫 `ready` 的地方，而且只在驗證通過後寫。

## 轉檔規格

工具跑的與 `video.ladder_for` 是同一套規則：

| 名稱 | 最大解析度 | 使用條件 |
| --- | --- | --- |
| 1080p | 1920×1080 | 來源高度至少 1080 |
| 720p | 1280×720 | 來源高度至少 720 |
| 480p | 854×480 | 一般來源 |

- 畫質階梯由 ffprobe 讀到的實際高度決定，不看副檔名也不看任何人的假設。
- 不放大來源。放大只是用更多頻寬和儲存送出一個更模糊的檔案。
- H.264 / AAC，fMP4 HLS，預設 6 秒 segment。
- keyframe 固定對齊 segment 邊界。播放器只能在 keyframe 換畫質，沒對齊的分段會讓切換卡住或失敗。
- poster 用 WebP，另存寬高。
- master playlist 手寫，不用 ffmpeg 的 `var_stream_map`：相對路徑是播放閘道換算 object key 的依據，手寫才能保證固定只有一層資料夾。
- 所有檔案的 Content-Type 要正確。以 octet-stream 送出的 playlist 沒有播放器讀得懂。
- 指令不拼接原始檔名、不經過 shell interpolation。所有路徑由 asset id 與 encode version 產生。

實際 bitrate 需要用代表性的畫畫教學素材驗證：細線與紙張紋理比一般 talking-head 更容易在低 bitrate 出現塊狀失真。

## 環境依賴

工具需要 FFmpeg 與 ffprobe。不打包進安裝檔，第一次啟動時下載，**只從我們自己的 R2 鏡像**：

- 版本釘死，連同 SHA256 一起記在工具裡，對不上就不執行。
- 官方發布頁的檔名與連結會改，舊版本會下架。鏡像不會。
- 「官方失敗就退回鏡像」聽起來更省，實際上是把最少被測到的那條路留到官方真的壞掉的那天才第一次執行；而且「官方失敗」很難判斷 —— 404、很慢、檔名換了、傳一半、回一頁 HTML 錯誤頁，長得都不一樣。
- R2 沒有 egress 費用，這是它跟 S3 最主要的差別。一台機器抓一次一百多 MB，成本落在 Class B 操作與儲存，一年個位數次下載的量級，錢不是考量。

FFmpeg 是 GPL。放在自己的鏡像上就是散布，所以 LICENSE 與對應的原始碼壓縮檔一起鏡像，路徑寫在工具的「關於」畫面裡。這個義務跟從哪裡下載無關 —— 只要我們有託管，它就成立。

## 安裝與更新

參照 `C:\Code\FotoBuddy` 的作法：

- electron-vite 建置，electron-builder 打 NSIS 安裝檔。
- **不簽章。** 代價要說清楚：Windows SmartScreen 會對下載與安裝提出警告，管理員要手動放行。使用者只有管理員本人，所以可以接受，但不能假裝不存在。
- CI 打包後上傳到 R2。
- 更新用 electron-updater 的 generic provider，指向 Admin API 的 `/releases/{version}/{file}` —— 該路由從 R2 串出檔案，version 與檔名都走白名單，不讓任意路徑穿過去。
- 版本政策放在 D1 一列（latest、minSupported、forceUpdate、blocked、feedUrl），後台一頁可讀可改，也放安裝檔的下載連結。
- 桌面圖示用苒光繪誌 logo 的星芒，跟 web favicon 同一個圖形。各尺寸都要出，不然工作列上只會是一顆鼻屎。

## 完成後怎麼讓後台知道

工具註冊成功後通知 Admin API，影片庫要看得到新影片。後台用**輪詢**，三秒一次：

- 影片庫是一個管理員偶爾打開的頁面，不是即時協作介面。
- SSE 或 WebSocket 要在 Worker 上維持連線，為了這個場景不值得。
- 三秒的延遲對「等轉檔完成」這件事沒有差別，而輪詢壞掉的方式是「慢一點」，連線壞掉的方式是「靜靜地不再更新」。

只在影片庫頁面開著的時候輪詢，離開就停。

## 安全設計

- Source 與 Video bucket 都不開 public access。
- Presigned URL 視為 bearer token，期限盡量短，不進 log。
- object key 由伺服器產生，前端與工具都不能指定任意 prefix。
- 桌面工具的 token 只能做影片操作，且可撤銷。
- CORS 只允許正式管理後台與明確的本機開發 origin，不用 `*`。
- MIME 與副檔名只做早期提示，ffprobe 才是格式判斷。
- 限制單檔大小、影片長度、同時上傳數。
- 錯誤訊息不回傳 R2 credentials、完整 presigned URL 或 token。
- presigned GET 只用於重新轉檔，且只能簽該 asset 自己的原始檔。
- 配對碼比對用固定時間比較，並限制嘗試次數 —— 六位數字擋不住無限次猜測。

## 成本控制

- 原始檔只轉一次，播放時不做即時轉碼。
- 只產生不超過來源尺寸的 rendition。
- master playlist 最後發布，失敗版本不會被播放器選到。
- 沒有 asset 指向的孤兒物件可清理；有 asset 指向的原始檔不清理。
- 重新轉檔成功並切換後，舊 encode version 延遲清理，保留短期 rollback。
- R2 Standard 適合經常播放的 HLS；不要為了低儲存單價把熱門 segment 放進有讀取費的 Infrequent Access。
- 轉檔的 CPU 成本落在管理員的機器上，帳單上看不到。

## 本階段不做

- 不將 VideoAsset 加入 CourseLesson；phase5 處理。
- 不做會員播放 gateway；phase6 處理。
- 不承諾 DRM。
- 不做自動排程轉檔。資料表、狀態機與 job 欄位都留著，日後要接排程只需補上執行環境。
- 不直接從 R2 列出所有 object 當影片庫。影片庫的權威是 D1。
- 不做 macOS 或 Linux 安裝檔。
