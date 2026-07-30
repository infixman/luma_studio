# Phase 4 工作項目：影片上傳與轉檔

轉檔跑在管理員的機器上，由 `desktop/` 的 Electron 工具負責；理由與信任邊界見
`design.md`。伺服器端負責簽章、驗證與記帳。

## 1. Cloudflare 資源

- [x] 建立 private `luma-course-source` R2 bucket。
- [x] 建立 private `luma-course-video` R2 bucket。
- [x] 設定限定 admin origin 的 CORS。（`docs/r2-course-source-cors.json`）
- [x] Admin Worker 綁 `COURSE_SOURCE` 與 `COURSE_VIDEO`；public Worker 只綁 `COURSE_VIDEO`。
- [ ] 建立 R2 S3 API token，以 secret 存入 Admin Worker，不進 repo 也不進工具。
- [ ] 建立存放安裝檔與 FFmpeg 鏡像的 R2 bucket 或 prefix。
- [ ] 設定開發與 production 的獨立資源名稱。

## 2. Migration 與 Domain

- [x] 建立 `video_assets`。
- [x] 建立 `video_upload_sessions`。
- [x] 建立 `video_transcode_jobs`。
- [x] 建立狀態轉移函式與條件 UPDATE。
- [x] 建立版本化 source/output key 產生器。
- [x] 建立 asset reference 查詢接口。
- [ ] 建立管理員 TOTP seed 表。
- [ ] 建立桌面工具版本政策表。
- [ ] 定義 archive、source retention 與舊 encode cleanup 狀態。

## 3. 桌面工具驗證

- [ ] 產生與保存每位管理員的 TOTP seed，建立時顯示一次。
- [ ] 實作 `GET /api/desktop/pairing-code`，需管理員 session。
- [ ] 後台一頁顯示目前配對碼與剩餘秒數。
- [ ] 實作 `POST /api/desktop/tokens`：接受目前與前一窗、固定時間比較、用過即失效。
- [ ] 實作每個 email 的失敗次數上限與鎖定。
- [ ] 實作影片範圍 token 的簽發與驗證，非影片路由回 403。
- [ ] 提供撤銷單一 token 的方式。

## 4. Presign 與上傳控制

- [x] 實作安全 part size 計算。
- [ ] 實作 SigV4 presign（PUT，限定 bucket、key、期限）。
- [ ] 實作輸出物件的 key 形狀允許清單，越界 key 回 400。
- [ ] 實作 `POST /api/video-assets`。
- [ ] 實作 `POST /api/video-assets/{id}/upload-urls`，含單次數量上限。
- [ ] 實作原始檔 multipart 的 create／part／complete／abort，且 complete 與 abort 冪等。
- [ ] 限制單檔大小、影片長度與同時 session 數。
- [ ] 建立未完成 session 清理工作。
- [ ] 加入 presign 與 token 兌換的 rate limit。
- [ ] 對外回應移除 R2 key、secret、presigned URL 與內部錯誤堆疊。
- [ ] 實作 `GET /api/video-storage?prefix=`，只回 key／大小／時間，不回簽章 URL。

## 5. 註冊與驗證

- [x] 讀 master playlist、跟著 rendition 走、HEAD 每個物件。（`video.verify_encode`）
- [x] 一次回報所有缺漏。
- [x] 驗證通過才寫 `ready`，且只有 import 端點能寫。（`video.register_verified_asset`）
- [x] `POST /api/video-assets/import`。
- [ ] Import 冪等測試：同一 asset 與 encode version 重送不建立第二筆。

## 6. 桌面工具

- [ ] 建立 `desktop/`：electron-vite 專案骨架。
- [ ] 啟動畫面：管理員 email + 配對碼，換 token 後保存於作業系統的憑證儲存。
- [ ] 環境自檢：FFmpeg／ffprobe 是否存在、版本與 SHA256 是否相符。
- [ ] 從 R2 鏡像下載 FFmpeg，可續傳，雜湊不符即拒絕執行。
- [ ] 鏡像 FFmpeg 的 LICENSE 與原始碼，「關於」畫面列出路徑。
- [ ] 拖曳放開 MP4，ffprobe 讀真實格式與尺寸。
- [ ] 依來源高度轉出不放大的畫質階梯，keyframe 對齊 segment 邊界。
- [ ] 產生 poster。
- [ ] 手寫 master.m3u8，相對路徑固定一層深。
- [ ] 逐物件取得 presigned URL 並上傳，每個物件有 retry 與正確 Content-Type。
- [ ] 原始檔走 multipart。
- [ ] 保存 asset id 與已完成的 key，關掉重開可續傳而不重新轉檔。
- [ ] 顯示轉檔與上傳進度、可取消、可重試。
- [ ] 上傳完成後呼叫 import，缺漏時只補傳缺的物件。
- [ ] R2 瀏覽畫面：看得到既有物件，可新增資料夾與檔案，沒有修改與刪除。
- [ ] 清理本機工作目錄。

## 7. 安裝、更新與版本控制

- [ ] electron-builder NSIS 設定，不簽章；README 寫明 SmartScreen 會警告。
- [ ] 星芒圖示，各尺寸齊全（參照 FotoBuddy）。
- [ ] CI 打包並上傳安裝檔與 updater metadata 到 R2。
- [ ] 實作 `GET /releases/{version}/{file}`，version 走正規表示式、file 走白名單。
- [ ] 實作 `GET /api/desktop/version-policy`。
- [ ] electron-updater 指向 releases 路由。
- [ ] 低於 `minSupported` 或 `blocked` 時工具停止工作並要求更新。
- [ ] 後台桌面工具版本區：顯示政策、下載連結，可修改政策。

## 8. 管理前端

- [ ] 建立 Video Library 頁。列表、詳情、references 與封存 API 已完成。
- [ ] 頁面開著時每三秒輪詢，離開停止。
- [ ] failed 顯示可讀錯誤。
- [ ] 未 ready 的 asset 不出現在課程單元的可選清單。

## 9. 清理

- [ ] 建立未引用 asset、舊 encode version 與 source 的 lifecycle policy。
- [ ] 清理前再次檢查 CourseLesson reference。

## 10. 測試與驗收

- [x] 單元測試 key、part、狀態與 playlist validator。
- [ ] 配對碼測試：正確、過期、前一窗、重放、次數上限。
- [ ] 影片 token 打非影片路由回 403。
- [ ] presigned URL 不能改 bucket、key 或 method。
- [ ] 越界 key 與路徑穿越被拒。
- [ ] releases 路由拒絕非白名單檔名。
- [ ] 使用短、直式、無音軌、VFR、損壞影片 fixture。需實際媒體檔。
- [ ] 驗證 Admin API request body 不承載影片。
- [ ] 驗證 anonymous request 無法取得 presigned URL。
- [ ] 驗證 source/video bucket 無 public URL。
- [ ] 反編譯安裝檔確認找不到 R2 credentials。
- [ ] 實際播放輸出的 master playlist，僅作轉檔品質驗收，不建立會員公開入口。
- [ ] 記錄每分鐘來源影片的轉檔時間與輸出容量，供儲存成本估算。
