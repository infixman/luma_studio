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

- [ ] 建立 R2 S3 API token，以 secret 存入 Admin Worker，不進 repo 也不進工具。
- [ ] 實作 SigV4 presign（限定 bucket、key、method、期限）。
- [ ] 實作輸出物件的 key 形狀允許清單，越界 key 回 400。
- [ ] 實作 `POST /api/video-assets`。
- [ ] 實作 `POST /api/video-assets/{id}/upload-urls`，含單次數量上限。
- [ ] 對外回應與 log 移除 R2 credentials、secret 與完整 presigned URL。
- [ ] 測試：presigned URL 不能改 bucket、key 或 method；越界 key 與路徑穿越被拒。

## S2：配對碼與範圍 token（純後端）

放在 S1 後面，因為 token 是用來守 presign 的。先做門再做門後面的東西，門壞了看不出來。

驗收：換到 token → 打 presign 通 → 打訂單路由回 403。

- [ ] 建立管理員 TOTP seed 表。
- [ ] 產生與保存 seed，建立時顯示一次。
- [ ] 實作 `GET /api/desktop/pairing-code`，需管理員 session。
- [ ] 後台一頁顯示目前配對碼與剩餘秒數。
- [ ] 實作 `POST /api/desktop/tokens`：接受目前與前一窗、固定時間比較、用過即失效。
- [ ] 實作每個 email 的失敗次數上限與鎖定。
- [ ] 實作影片範圍 token 的簽發與驗證，非影片路由回 403。
- [ ] 提供撤銷單一 token 的方式。
- [ ] 加入 presign 與 token 兌換的 rate limit。
- [ ] 測試：正確、過期、前一窗、重放、次數上限；影片 token 打非影片路由回 403。

## S3：Electron 骨架與上傳（不含轉檔）

輸入是 `scripts/transcode-course-video.ps1` 的輸出目錄 —— 這就是腳本留著的理由。

退掉的風險：整合。打包、token 存哪、並行與重試、Content-Type、續傳記錄。

驗收：一支真的 `ready` 的影片，由工具做出來。

- [ ] 建立 `desktop/`：electron-vite 專案骨架。
- [ ] 啟動畫面：管理員 email + 配對碼，換 token 後存入作業系統的憑證儲存。
- [ ] 選擇已轉好的輸出目錄，逐物件取得 presigned URL 並上傳。
- [ ] 每個物件有 retry 與正確 Content-Type。
- [ ] 保存 asset id 與已完成的 key，關掉重開可續傳。
- [ ] 上傳完成後呼叫 import，缺漏時只補傳缺的物件。
- [ ] 顯示上傳進度、可取消。
- [ ] 打一個丟掉的 NSIS 包，確認打包後跑得起來、找得到 userData 目錄。
      不做這件事，S4 的 ffmpeg 路徑處理會在 S6 重寫一次。
- [ ] 測試：驗證 Admin API request body 不承載影片；anonymous request 無法取得 presigned URL。

## S4：本機轉檔

階梯與參數已被腳本驗證過，所以這階段主要是接管線與解析 ffmpeg 進度。

驗收：拖進 MP4 → ready。**到這裡是第一個能用的版本。**

- [ ] 建立存放安裝檔與 FFmpeg 鏡像的 R2 bucket 或 prefix。
- [ ] 鏡像釘死版本的 FFmpeg，連同 LICENSE 與對應原始碼。
- [ ] 環境自檢：FFmpeg／ffprobe 是否存在、版本與 SHA256 是否相符。
- [ ] 從 R2 鏡像下載，可續傳；雜湊不符即拒絕執行且不重試。
- [ ] 「關於」畫面列出 LICENSE 與原始碼路徑。
- [ ] 拖曳放開 MP4，ffprobe 讀真實格式與尺寸。
- [ ] 依來源高度轉出不放大的畫質階梯，keyframe 對齊 segment 邊界。
- [ ] 產生 poster。
- [ ] 手寫 master.m3u8，相對路徑固定一層深。
- [ ] 顯示轉檔進度、可取消、失敗可重試。
- [ ] 清理本機工作目錄。
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
- [ ] 工具的 R2 瀏覽畫面：看得到既有物件，可新增資料夾與檔案，沒有修改與刪除。
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
