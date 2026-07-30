# Phase 4 工作項目：影片上傳與轉檔

轉檔跑在管理員的機器上，由 `desktop/` 的 Electron 工具負責；理由與信任邊界見
`design.md`。伺服器端負責簽章、驗證與記帳。

分階段的原則是**風險最大的先做，每一階段結束都有東西可以真的跑一次**。
S1–S4 是不能砍的最小集合；S4 結束就是第一個能用的版本。S5 之後每一階都可以獨立
延後，順序也可以換。

## 已完成（先前階段留下的基礎）

- [x] 建立 private `luma-course-source` R2 bucket。
- [x] 建立 private `luma-course-video` R2 bucket。
- [x] 設定限定 admin origin 的 CORS。（`docs/r2-course-source-cors.json`。Electron 用不到，留給日後後台直接上傳，也作為 bucket 未對外開放的一部分）
- [x] Admin Worker 綁 `COURSE_SOURCE` 與 `COURSE_VIDEO`；public Worker 只綁 `COURSE_VIDEO`。
- [x] 建立 `video_assets`、`video_upload_sessions`、`video_transcode_jobs`。
- [x] 建立狀態轉移函式與條件 UPDATE。
- [x] 建立版本化 source/output key 產生器。
- [x] 建立 asset reference 查詢接口。
- [x] 實作安全 part size 計算。
- [x] 讀 master playlist、跟著 rendition 走、HEAD 每個物件。（`video.verify_encode`）
- [x] 一次回報所有缺漏。
- [x] 驗證通過才寫 `ready`，且只有 import 端點能寫。（`video.register_verified_asset`）
- [x] `POST /api/video-assets/import`。
- [x] 單元測試 key、part、狀態與 playlist validator。

---

## S1：SigV4 presign（純後端）

退掉的風險：**Pyodide 能不能乾淨做 SigV4。** 整條路建立在這上面，錯了後面全部要改。
容易翻車的是 canonical request 細節 —— `UNSIGNED-PAYLOAD`、host header、query 排序。

驗收：用 Worker 簽出的 URL，以 curl 真的 PUT 一個物件進 R2。

- [x] 建立 R2 S3 API token，以 secret 存入 Admin Worker，不進 repo 也不進工具。`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` 是 secret，`R2_S3_ENDPOINT` 是 plaintext（它只是網址，帳號 id 不是憑證）。
- [x] 實作 SigV4 presign（限定 bucket、key、method、期限）。與 botocore 對簽，簽章一致。
- [x] 實作輸出物件的 key 形狀允許清單，越界 key 回 400。（`video.signable_key`；與播放閘道共用同一份清單）
- [x] 實作 `POST /api/video-assets`。
- [x] 實作 `POST /api/video-assets/{id}/upload-urls`，含單次數量上限（100；整批驗，一個不合格全批拒絕）。
- [x] 對外回應與 log 移除 R2 credentials、secret 與完整 presigned URL。
- [x] 測試：presigned URL 不能改 bucket、key 或 method；越界 key 與路徑穿越被拒。

## S2：配對碼與範圍 token（純後端）

放在 S1 後面，因為 token 是用來守 presign 的。先做門再做門後面的東西，門壞了看不出來。

驗收：換到 token → 打 presign 通 → 打訂單路由回 403。

- [x] ~~建立管理員 TOTP seed 表。~~ 不需要：seed 由 `DESKTOP_PAIRING_SECRET` 與 email 導出，沒有表。
- [x] ~~產生與保存 seed，建立時顯示一次。~~ 同上，沒有東西要保存或顯示。
- [x] 實作 `GET /api/desktop/pairing-code`，需管理員 session。
- [x] 後台一頁顯示目前配對碼與剩餘秒數。`/desktop-tool`；倒數用伺服器回的剩餘秒數，歸零才重新取，不自己算下一組碼。
- [x] 實作 `POST /api/desktop/tokens`：接受目前與前一窗、固定時間比較、用過即失效（條件 upsert 記下用掉的時窗；真 SQLite 測試驗那道 WHERE）。
- [x] 實作每個 email 的失敗次數上限與鎖定。刻意不用 `rate_limit`：它逐 IP 且 binding 缺席時放行，擋不住六位數字。這個在 D1、逐 email、失敗時關閉。
- [x] 實作影片範圍 token 的簽發與驗證，非影片路由回 403。允許清單只放行建 asset／upload-urls／import。
- [ ] 提供撤銷單一 token 的方式。目前只能換 `DESKTOP_TOKEN_SECRET`（一次全撤）或把 email 移出管理員允許清單。
- [ ] 加入 presign 與 token 兌換的 per-IP rate limit。兌換已有逐帳號的鎖定；這一項是額外的濫用防護。
- [x] 測試：正確、過期、前一窗、重放、次數上限；影片 token 打非影片路由回 403。另有端到端驗收：無 session 換 token → presign 200 → 訂單/顧客/儀表板/課程/列表/封存全部 403。

## S3：Electron 骨架與上傳（不含轉檔）

輸入是一個已經轉好的輸出目錄。先做這一半，是因為會出錯的是整合而不是轉檔，
拿一份已知正確的輸出來試比較便宜。轉檔在 S4 補上之後，這條路留著 ——
重傳一份 encode 是幾分鐘，重轉是一小時。

退掉的風險：整合。打包、token 存哪、並行與重試、Content-Type、續傳記錄。

驗收：一支真的 `ready` 的影片，由工具做出來。

- [x] 建立 `desktop/`：electron-vite 專案骨架。Preact，與 repo 一致；`npm run smoke` 用真 Electron 驗橋接。
- [x] 啟動畫面：管理員 email + 配對碼，換 token 後存入 `safeStorage`。沒有加密可用時不存（不寫明文）。
- [x] 選擇已轉好的輸出目錄，逐物件取得 presigned URL 並上傳。也接受拖入 MP4（S4 的轉檔路徑）。
- [x] 每個物件有 retry 與正確 Content-Type。過期的 URL 會重換一次（一批 100 張只活 15 分鐘，慢速上傳會撞到）。
- [x] 保存 asset id 與已完成的 key，關掉重開可續傳。ledger 的 key 含檔案數與容量，重新轉檔不會誤接續。
- [x] 上傳完成後呼叫 import，缺漏時只補傳缺的物件。
- [x] 顯示上傳進度、可取消。
- [x] 打一個丟掉的包，確認打包後跑得起來、找得到 userData 目錄。`--self-check` + `npm run verify:packaged`。
- [ ] 測試：驗證 Admin API request body 不承載影片；anonymous request 無法取得 presigned URL。

## S4：本機轉檔

階梯與參數已被腳本驗證過，所以這階段主要是接管線與解析 ffmpeg 進度。

驗收：拖進 MP4 → ready。**到這裡是第一個能用的版本。**

- [x] 建立 `luma-desktop-tools` bucket 存放安裝檔與 FFmpeg 鏡像（binding `DESKTOP_TOOLS`；Standard、非公開）。
      獨立一個 bucket 而不是塞在 video 桶的 prefix：播放閘道讀 video 桶，裡面非影片的東西越少，它的 key 允許清單越不容易出錯。
- [x] `GET /tools/ffmpeg/{檔名}` 路由。檔名走 pattern（單一路徑段、不得以點開頭、只收壓縮檔後綴），
      需要桌面 token（bytes 不是機密，擋的是流量）。沒有 binding 時回 503 並說缺哪個，不是 404。
- [x] 鏡像釘死版本的 FFmpeg（`ffmpeg-8.1.2.zip`，gyan release build 重新打包成只有 ffmpeg.exe／ffprobe.exe／LICENSE），並填好 `ffmpegRelease.ts`。
- [x] ~~鏡像對應原始碼。~~ **不放，這是一個有記錄的決定 —— 見下面 S7 的前置條件。**
- [x] 環境自檢：FFmpeg／ffprobe 是否存在、版本與 SHA256 是否相符。空的雜湊值當成「尚未設定」，不是「跳過檢查」。
- [x] `LUMA_FFMPEG_DIR` 開發用逃生口：指向機器上已有的 FFmpeg，讓轉檔在鏡像存在之前就能驗。
      打包後一律拒絕（`app.isPackaged`），而且 `PINNED.version` 一填上就照樣比版本 —— 可設定的只有「去哪裡找」，不是雜湊或版本。
- [~] 從 R2 鏡像下載；雜湊不符即拒絕且不重試。**程式寫好了但無法端到端驗證 —— 鏡像還不存在。** 續傳未做（整檔重下）。
- [x] 「關於」畫面列出 LICENSE 與原始碼路徑。GPL 的義務，不是致謝 —— 有測試釘住兩個路徑都看得到。
- [x] 拖曳放開 MP4，ffprobe 讀真實格式與尺寸。沒有影像軌就拒絕，不會空轉二十分鐘。
- [x] 依來源高度轉出不放大的畫質階梯，keyframe 對齊 segment 邊界。與後端 `ladder_for` 逐一核對。
- [x] 產生 poster。`-ss` 在 `-i` 之前，所以是 seek 而不是解到那裡。
- [x] 手寫 master.m3u8，相對路徑固定一層深。**修掉腳本的 bug：無音軌不再宣告 `mp4a.40.2`。**
- [x] 顯示轉檔進度、可取消（真的 kill ffmpeg）、失敗可重試。
- [x] 清理本機工作目錄 —— 只在註冊成功之後。上傳失敗的 encode 值得留著（重傳幾分鐘，重轉一小時）。
- [ ] 測試：使用短、直式、無音軌、VFR、損壞影片 fixture。需實際媒體檔。

## S5：影片庫與原始檔上傳

- [ ] 建立 `video_encode_versions` 表（物件數、位元組、驗證時間、active）。
- [ ] `verify_encode` HEAD 物件時一併記下總量與物件數，寫入該版本一列。
- [ ] 建立 Video Library 頁；列表、詳情、references 與封存 API 已完成。
- [ ] 頁面開著時每三秒輪詢，離開停止。
- [ ] failed 顯示可讀錯誤。
- [ ] 未 ready 的 asset 不出現在課程單元的可選清單。
- [ ] 實作原始檔 multipart 的 create／part／complete／abort，且 complete 與 abort 冪等。
- [ ] 工具上傳原始檔。
- [ ] 限制單檔大小、影片長度與同時 session 數。
- [ ] 實作 `GET /api/video-storage?prefix=`，只回 key／大小／時間，不回簽章 URL。
- [ ] 工具的 R2 瀏覽畫面：**唯讀**。只是用來確認影片真的傳上去了。
      原本寫的「可新增資料夾與檔案」拿掉了：object key 由伺服器依允許清單產生，
      而播放閘道用**同一份清單**決定哪些 key 可以被讀 —— 為了讓人手動放檔案而放寬那份清單，
      會連帶放寬播放權限。而且它解的問題已經有別的解法：import 會回報缺哪些物件，
      工具自己補傳那幾個，不需要有人手動放。
- [ ] 測試：import 冪等 —— 同一 asset 與 encode version 重送不建立第二筆。

## S6：容量、費用與清理

依賴 S5 的 `video_encode_versions`。做完這一階才有人會想起該清東西。

- [ ] 實作 `GET /api/video-storage/summary`：兩桶容量、每月費用估算、本月成長。
- [ ] 單價與免費額度做成設定值，不是程式常數。
- [ ] 實作 `POST /api/video-storage/scan`：列兩個 bucket、比對 D1、記下孤兒與時間。
- [ ] 盤點排除仍在 `uploading` 的 asset，以及 24 小時內的物件。
- [ ] 實作 `GET /api/video-storage/orphans?bucket=source|output`。
- [ ] 實作 `GET /api/video-storage/cleanup-candidates`，分 `safe` 與 `needsJudgement`。
- [ ] 實作 `GET /api/video-storage/sources`：容量、有沒有可播放版本、使用它的課程單元。
- [ ] 實作 `GET /api/video-storage/versions?assetId=`。
- [ ] 總覽頁：容量與每月費用擺在第一眼，標明是估算且不含操作費用。
- [ ] 未盤點時顯示「尚未盤點」，不顯示 0。
- [ ] 原始檔頁：一列一支，使用中的課程單元可以點進去。
- [ ] 輸出頁：一列一個 encode version，含孤兒分頁。
- [ ] `safe` 可批次清；`needsJudgement` 逐項確認，確認文字帶影片名稱與後果，沒有全選。
- [ ] 課程還在用的原始檔不出現在建議裡，刪除端點也拒絕它。
- [ ] 刪除前重查引用；先出 dry-run 清單。
- [ ] 測試：使用中的原始檔不被列為候選也不能刪；上傳中的版本不被當成孤兒；總覽不觸發 list 操作。

## S7：安裝、版本與自動更新

放最後，因為自動更新只能靠「發 1.0.0 再發 1.0.1」驗證，不想在工具還在變形時燒版本號。

**陷阱**：如果 1.0.0 裝上去而更新機制還沒好，就推不了修正。所以 `minSupported`
與 `blocked` 必須跟第一個發布版一起上，不能晚於它。

### GPL 對應原始碼：現在不用做，但要知道什麼會讓它變成要做

工具會裝一份 FFmpeg 的 GPL binary。「提供對應原始碼」的義務是在
**conveying（把 binary 交給別人）** 時成立。

**觸發條件是收件人，不是階段。** 這一階的下載頁在管理後台後面，收件人還是那兩個
擁有這個系統的管理員 —— 跟現在用 `--self-check` 手動裝一份沒有差別，都是內部使用。
所以 S7 不觸發它，鏡像裡刻意不放原始碼，工具裡也刻意沒有「開啟原始碼」的按鈕
（那顆按鈕曾經存在，指向一個工具永遠不會下載的檔案，按了什麼都不會發生 ——
一個假裝滿足了義務的控制項比沒有控制項糟）。

會觸發它的是這些：安裝檔放到不需要登入就能拿的地方；給外包剪輯或任何不在管理員
名單上的人；把 repo 或安裝檔公開。

真的發生時，問題比「補一個 zip」大：我們交出去的是**別人編譯的** build，對應原始碼
指的是那個 build 的全部來源。gyan 只公佈 FFmpeg 的 commit（8.1.2 是 `38b88335f9`），
不公佈 libx264、libx265 等依賴用的 revision，所以無法精確重建。屆時三條路：

1. **不散布 binary** —— 工具改成從上游下載，我們只保留 SHA-256 釘死。義務歸零，也省下
   R2 的 74 MB 與流量。障礙：gyan 只給 `.7z`（Windows 內建 bsdtar 讀不了），
   BtbN 給 `.zip` 但用移動的 `latest` tag（重建一次 digest 就失效）。
2. **盡力補原始碼** —— 放 FFmpeg 該 commit 的 zip 加上 x264／x265 同期 snapshot，附
   written offer。依賴版本是推測的，嚴格說不完全合規。
3. **自己編 FFmpeg** —— 完全合規，成本是一條 build pipeline。

- [ ] 建立桌面工具版本政策表。
- [ ] 實作 `GET /api/desktop/version-policy`。
- [ ] 實作 `GET /releases/{version}/{file}`，version 走正規表示式、file 走白名單。
- [ ] electron-builder NSIS 設定，不簽章；README 寫明 SmartScreen 會警告。
- [ ] 星芒圖示，各尺寸齊全（參照 FotoBuddy）。
- [ ] CI 打包並上傳安裝檔與 updater metadata 到 R2。
- [ ] electron-updater 指向 releases 路由。
- [ ] 低於 `minSupported` 或 `blocked` 時工具停止工作並要求更新。
- [ ] 後台桌面工具版本區：顯示政策、下載連結，可修改政策。
- [ ] 測試：releases 路由拒絕路徑穿越與非白名單檔名；min/force/blocked 判斷。
- [ ] 在實際機器上裝一次、更新一次。**需要你的機器，我做不完這一項。**

## S8：從 R2 重新轉檔

沒有東西依賴它，所以放最後。設計已經預留（版本化 key、`ready -> queued`、
驗證後才切 active），要補的只有 presigned GET 與一個入口。

- [ ] 實作 `GET /api/video-assets/{id}/source-url`：只簽該 asset 的 `source_key`，忽略 caller 給的任何 key。
- [ ] 沒有原始檔的 asset 回 404，訊息說得出是「沒有原始檔」。
- [ ] 影片庫的「重新轉檔」入口。
- [ ] 工具下載原始檔、轉出新 encode version、上傳、註冊。
- [ ] 測試：`source-url` 不能讀 output bucket 或別的 asset；重新轉檔期間舊版本一直可播放。

---

## 不屬於任何一階

- [ ] 建立過期未完成 multipart session 的清理。（S5 的 multipart 上線後就需要）
- [ ] 原始檔總量超過 1 TB 時重新評估保存政策。這是一個回顧提醒，不是一次性工作。

## 上線前驗收

- [ ] 驗證 source/video bucket 無 public URL。
- [ ] 反編譯安裝檔確認找不到 R2 credentials。
- [ ] 實際播放輸出的 master playlist，僅作轉檔品質驗收，不建立會員公開入口。
- [ ] 記錄每分鐘來源影片的轉檔時間與輸出容量，供儲存成本估算。
