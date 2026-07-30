# 交接：course-commerce 的 S5–S7

貼給下一個 agent 的起始指令。寫在 repo 裡是為了它不會隨對話消失。

---

## 你要做的事

把 `docs/changes/plans/20260729-course-commerce-phase4-video-ingestion-pipeline/task.md`
裡的 **S5、S6、S7** 做完，並補上 **S1–S4 剩下的未完成項**（下面列了）。

過程要遵守既有的開發約定，以及把過程寫進
`docs/changes/course-commerce-worklog.md`（見「工作流程」）。

## 工作流程（不可省略）

每一階分成**最小完整實作步驟** —— 每個步驟結束時系統是可以跑的，不會有「改一半，run
起來就壞」的中間狀態。每個步驟：

1. **開發**（TDD：先寫失敗的測試，看它為正確的理由失敗，再實作）
2. **一致性審查** —— 跟既有設計、命名、既有模組是否一致
3. **對抗性審查** —— 假設自己錯了，去找哪裡會壞
4. **重構審查** —— 有沒有重複造輪子，該抽的有沒有抽
5. **修正審查發現的問題**
6. **commit** —— 你要確保這個 commit 被 checkout 出來時是能跑的
7. 才進下一個步驟

**新寫的測試要做突變驗證**：把實作改回錯的版本，確認那條測試真的會掛。這個 repo 裡
有多次「測試綠但功能壞」的紀錄（見下面的教訓），突變驗證是唯一能證明測試有效的方法。

**worklog 是給人看的敘述，不是變更清單。** 寫下決定和它的理由、走錯的路、被證明錯的
假設。它的價值在於「為什麼」，那是 git log 補不上的。

## 現在的狀態

| | |
|---|---|
| 分支 | `main`，最後一個 commit `43de53d`，已 push |
| 後端 | 已部署，version `c92cc70a`（`luma-studio-admin-api`） |
| 前端 | **未部署** —— 後台有兩輪 UI 改動只在本地。`cd frontend && npm run deploy:admin` |
| 測試 | backend 1468、frontend 384、desktop 280，全綠 |
| S1–S4 | 核心路徑已在正式環境端到端驗過（真 R2、真簽章、真轉檔、真 `ready`） |

驗過的完整路徑：拖入 MP4 → 從 R2 鏡像下載 74 MB FFmpeg → 比對 SHA-256 → bsdtar 解壓 →
ffprobe → 轉 1080p/720p/480p → 產封面 → 手寫 master.m3u8 → 14 個 presigned PUT →
import 驗證 14 個 → `ready`。

## S1–S4 還沒完成的（四項，都不阻塞 S5）

- **S2：撤銷單一 token。** 目前只能換 `DESKTOP_TOKEN_SECRET`（一次全撤）或把 email
  移出管理員允許清單。使用者知道，尚未決定要不要做 —— **問他，不要自己決定**。
- **S2：presign 與 token 兌換的 per-IP rate limit。** 兌換已有逐帳號鎖定（5 次、15 分鐘、
  存 D1、失敗時關閉）。這一項是額外的濫用防護。同樣**先問**。
- **S3：兩條測試** —— Admin API request body 不承載影片內容；anonymous request 拿不到
  presigned URL。第二條目前只被端到端那組 403 測試間接涵蓋，沒有直接針對 presign 的。
- **S4：媒體 fixture 測試** —— 短片、直式、無音軌、VFR、損壞檔。**可以用 ffmpeg 合成**
  （`testsrc`、`sine`、把正常檔截半做損壞檔），不需要向使用者要素材。

## S5–S7 的建議順序

task.md 裡的順序不是硬性的。建議：

**S5 先做 `video_encode_versions` + 影片庫頁面。** 理由是那讓使用者**看得到**正式環境裡
那幾個測試 asset，也就有東西可以按下封存把它們清掉。列表、詳情、references、封存 API
都已經寫好了，缺的是頁面。

**multipart 原始檔上傳放 S5 後半。** 那是三條新的簽章路徑
（`CreateMultipartUpload`／`UploadPart`／`CompleteMultipartUpload`），是這一階風險最高的
部分。單純的 PUT presign 已經在正式環境驗過，所以地基是穩的 —— 但 multipart 的
canonical request 不同，**要跟 botocore 對簽，跟 `test_sigv4.py` 一樣的做法**。

**S6 依賴 S5 的 `video_encode_versions`**，順序不能換。

**S7 有兩項你做不完**，需要使用者的機器和帳號：「在實際機器上裝一次、更新一次」，
以及 CI 打包上傳（要他在 GitHub 設 R2 token）。做到那裡就停下來報告。

## 這個 repo 學到的教訓（不要重新發現一次）

### 測試會綠但功能是壞的

- **`FakeDatabase` 沒有鍵也沒有約束。** import 的 `INSERT` 撞主鍵撞了很久沒被發現，
  因為假的資料庫照收。**任何靠 SQL 語意成立的保證（主鍵、UNIQUE、`ON CONFLICT`、
  `WHERE`）都要用真 SQLite 測**：把 SQL 抽成模組常數，在 `tests/test_migrations_sqlite.py`
  裡對 `sqlite3` 執行。既有範例：`desktop_auth.CONSUME_SQL`、`video.REGISTER_SQL`。
- **不要斷言在 fake 回答的讀取上。** 這個 repo 犯過四次：測 `POST` 之後去看
  `response.json()["asset"]`，而那是 FakeDatabase 照腳本回的。**斷言在 INSERT／UPDATE
  上**（`database.statements`）。
- **exit code 0 不代表對。** ffmpeg 少寫了 init segment，三個階梯全部「成功」。
  端到端跑一次真實流程抓到的東西，是單元測試抓不到的。

### Windows 路徑，三個獨立的坑

1. **ffmpeg 用 `/` 找目錄。** `-hls_fmp4_init_filename` 的位置是從
   `-hls_segment_filename` 裡找 `/` 推出來的；`\` 對它不是分隔符，於是 init.mp4 掉進
   工作目錄。所有給 ffmpeg 的路徑都過 `toFfmpegPath()`。
2. **`tar` 不是 bsdtar。** PATH 上通常是 Git for Windows 的 GNU tar，它讀不了 zip，
   而且把 `C:\` 當 `host:path`。要指名 `%SystemRoot%\System32\tar.exe`。
3. **同一個資料夾有多種寫法。** `C:\a` 和 `C:/a` 和 `C:\A` 是一個目錄、三個字串。
   `jobId` 因此開過第二個 asset、重傳了 14 個物件。凡是拿路徑當 key 都要正規化。

### Cloudflare Worker

- **記憶體 128 MB。** `serve_r2_object` 是整個讀進來（ArrayBuffer + Python bytes ＝
  兩份），74 MB 的檔案就會爆。大物件用 `Ctx.stream()` 直通 R2 的 body。
- **JS `null` 不是 Python `None`**（workers-py 有 `_jsnull_to_none` 就是證據）。
  從 JS 物件拿回來的值不要直接 `is None`。
- **`safeStorage` 在 Windows 不是純 DPAPI**：金鑰隨機產生後放在 userData 的
  `Local State`。搬 `pairing.bin` 而不搬 `Local State` 就解不開。
- **CSRF 閘門豁免 bearer token**，理由寫在 `shared/responses.py`：瀏覽器附不了
  `Authorization`（會觸發 preflight，而 `ALLOWED_REQUEST_HEADERS` 沒宣告它）。
  **如果哪天把 `Authorization` 加進允許清單，這個豁免就變成瀏覽器到得了的洞。**

### 工具鏈

- **不要用 heredoc 或 shell 字串寫含反斜線／中文的檔案。** 這個 repo 反覆被吃掉轉義
  和中文字。用 Write／Edit 工具，或 Python 寫檔。測試裡的 Windows 路徑用
  `String.raw` 寫。
- **`npm run smoke` 報 `paired=false` 不是「沒配對」**：`electron scripts/smoke.mjs`
  沒有 package.json 可取名字，`app.getName()` 是 `Electron`，userData 是隔壁的空目錄。
  刻意不改（指向真 store 會跟執行中的 app 搶 single-instance lock，然後靜靜 exit 0）。
- **`requestSingleInstanceLock` 以 userData 為鍵。** 使用者開著 app 的時候，任何無頭
  harness 一啟動就 `app.quit()` —— exit 0、零輸出。用獨立的 userData 並複製
  `pairing.bin` + `prefs.json` + `Local State`。

## 使用者定下的約束（不可違反）

1. **桌面工具裡不能有 R2 金鑰。** 所有 S3 操作都經過 admin 後端代理。
2. **桌面 token 只做影片操作。** 允許清單只放行建 asset／upload-urls／import／抓鏡像。
   非影片路由回 **403 不是 401**（身分是真的，權限不是）。
3. **安裝包不簽章**（沒有預算買憑證）。README 要寫明 SmartScreen 會警告。
4. **`PINNED` 的雜湊和版本永遠不可設定。** 只有「去哪裡找」可以（`LUMA_FFMPEG_DIR`，
   而且打包後一律拒絕）。空的或格式不對的雜湊當「尚未設定」，**永遠不是「跳過檢查」**。
5. **GPL 對應原始碼**：義務在把 binary 交給管理員以外的人時才成立。目前只有兩個
   管理員自己安裝，所以鏡像刻意不放原始碼、工具刻意沒有「開啟原始碼」按鈕。
   S7 的下載頁在後台後面，收件人不變，所以**也不觸發**。細節和三條路寫在 task.md 的
   S7 段落 —— 動那一段之前先讀。

## 開發環境

```bash
# 後端
cd backend && uv run pytest
cd backend && uv run pywrangler deploy -c wrangler.admin.toml

# 前端
cd frontend && npx vitest run && npx tsc --noEmit
cd frontend && npm run deploy:admin

# 桌面（typecheck → 測試 → build → smoke 全包）
cd desktop && npm run build
cd desktop && npm run verify:packaged
```

桌面工具開發時跳過 74 MB 下載：

```powershell
$env:LUMA_FFMPEG_DIR = "C:/ffmpeg/bin"; npm run dev
```

無頭跑一次完整 ingest 的 harness 在 scratchpad（會隨 session 消失，需要就自己重寫）：
`ingestcheck.mjs` 匯入 `out/main/index.js`、`app.setName('luma-video-uploader')`、
用獨立 userData、透過 `window.desktop.upload.start()` 驅動。

## 正式環境的殘留

驗證過程在正式環境留下 **4 個測試 asset**（8 秒合成影片，總共約 1.5 MB）：

| asset id | 狀態 |
|---|---|
| `ZLyJuxtvtfegM95oJF7vic7a` | `uploading` —— import 撞主鍵那次的殘留 |
| `ikpGsPNc29Dl412q2IGXPGMK` | `ready` |
| `yhybHdl2PQ7cjZ8BTa1eBYIt` | `ready` |
| `Pldum2w0bJuFjkfEte9C_Knq` | `ready`（走鏡像下載那次） |

S5 的影片庫做好之後，它們是第一批真實測資 —— 也正好可以拿來驗封存。

另外 `luma-desktop-tools` 桶的**根目錄**有一份多餘的 `ffmpeg-8.1.2.zip`（正式使用的是
`ffmpeg/ffmpeg-8.1.2.zip`）。可以刪。

## 讀哪些檔案

- `docs/changes/course-commerce-worklog.md` —— 整條路的敘述，**先讀這個**
- `docs/changes/plans/20260729-course-commerce-phase4-video-ingestion-pipeline/`
  的 `design.md`／`spec.md`／`task.md` —— 決定與理由、S5–S8 的項目清單
- `docs/changes/plans/...phase7.../` —— 監控指標與保存政策
- `backend/src/domain/video.py` —— key 形狀允許清單、狀態機、`verify_encode`、
  `REGISTER_SQL`。**播放閘道和簽章共用同一份允許清單**，改它要同時想兩邊
- `backend/src/domain/desktop_auth.py` —— 配對碼、範圍 token、`_VIDEO_ROUTES`
- `desktop/src/shared/` —— 純邏輯都在這裡，而且都有測試；`main/` 裡的東西 import
  electron 所以測不到，**該測的邏輯要放 shared**
