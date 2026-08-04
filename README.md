# Luma Studio

苒光繪誌的網站與後台：一個賣實體課程材料包與線上課程的商店、店主用的管理後台、
以及一支把課程影片在本機轉檔後上傳的桌面工具。ibon 列印是最早的功能，還在跑，
但已經不是這個專案的主體。

四個部署，兩份原始碼：

| 部署 | 內容 | 網址 |
| --- | --- | --- |
| `luma-studio-web-api` | Cloudflare Python Worker，公開 API | `api.luma-studio.tw` |
| `luma-studio-admin-api` | Cloudflare Python Worker，管理 API | `admin-api.luma-studio.tw` |
| `luma-studio-web` | Vite + Preact 靜態站台，商店前台 | `luma-studio.tw` |
| `luma-studio-admin` | Vite + Preact 靜態站台，管理後台 | `admin.luma-studio.tw` |

兩個 Worker 共用 `backend/src/`，只有進入點不同（[main.py](backend/src/main.py) 與
[admin_main.py](backend/src/admin_main.py)）。兩個站台共用 `frontend/src/shared/`，
由 `vite.config.ts` 依 `--mode` 切換進入點。

**拆開的理由是 cookie 隔離。** 兩邊的 session cookie 都沒有設 `Domain`，所以是
host-only —— 管理者的 session 只會被送到 `admin-api`，公開站台上的任何腳本都碰不到它。
四個網域仍同屬 `luma-studio.tw`，`SameSite=Lax` 不受影響。

**管理 Worker 是唯一會套用 D1 migration 的部署。** 公開 Worker 只讀 `schema_migrations`
回報狀態：結帳是熱路徑，不該為 schema 檢查付冷啟動成本，而公開得到的 Worker 也沒有理由
具備 `ALTER TABLE` 的能力。所以部署順序固定是管理端先、公開端後。

## 目錄

```text
backend/          Cloudflare Python Workers
  src/
    main.py         公開 Worker 進入點
    admin_main.py   管理 Worker 進入點
    api/front/      公開路由
    api/admin/      管理路由
    domain/         商城、課程、頁面、媒體、訂單、播放授權等業務邏輯
    shared/         router、responses、rate_limit、migrations、簽章與雜項
    auth_*.py       店主與顧客的 session，兩者共用 auth_core
frontend/         兩個 Vite + Preact 站台
  worker/           供應 SPA 的 Worker：storefront、admin、legacy 轉址
  src/shared/       兩邊都用到的東西
  src/storefront/   商店前台
  src/admin/        管理後台（自己的元件庫，見 docs/admin-ui.md）
desktop/          Electron 桌面工具：本機轉檔並上傳課程影片
scripts/          本機診斷與 R2 同步腳本
docs/             底下這些文件
.github/workflows/ main 有新 commit 就部署
```

`frontend/src/` 底下只有三個目錄，規則很簡單：東西放在**用到它的那一邊**，兩邊都用到
才進 `shared/`。方向是單向的：`shared/` 不可以 import `admin/` 或 `storefront/`，
否則前台的 bundle 會被後台的程式碼拖進去。

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/backend.md](docs/backend.md) | CSRF 與跨來源、速率限制、備份、監測、migration、功能開關 |
| [docs/cloudflare.md](docs/cloudflare.md) | 初次設定、網域綁定、secrets、快取與 WAF 規則、Google OAuth、自動部署 |
| [docs/shop.md](docs/shop.md) | 商品、自訂頁面、媒體庫、購物車、結帳、訂單、會員、通知信 |
| [docs/courses.md](docs/courses.md) | 線上課程、影片轉檔與發版、播放授權、觀看權的規則 |
| [docs/admin-ui.md](docs/admin-ui.md) | 後台的設計系統：token、元件、排版與幾條規則 |
| [docs/bio-link.md](docs/bio-link.md) | 名片頁與造訪統計 |
| [docs/ibon.md](docs/ibon.md) | ibon 列印：使用方式與限制 |
| [docs/backlog.md](docs/backlog.md) | 已知缺口與待辦 |

端點清單刻意不寫在文件裡。路由檔就是清單，而手抄的那一份會漂移
—— 這份 README 上一版的表格就漏掉了整個線上課程：
[api/front/routes.py](backend/src/api/front/routes.py) 與
[api/admin/routes.py](backend/src/api/admin/routes.py)。

## 本機開發

後端兩個 Worker、前端兩個站台各自獨立啟動，只跑正在改的那些就好：

```powershell
uv --directory backend run pywrangler dev
```

```powershell
uv --directory backend run pywrangler dev -c wrangler.admin.toml
```

```powershell
cd frontend; npm run dev
```

```powershell
cd frontend; npm run dev:admin
```

前台在 5173、後台在 5174，公開 Worker 在 8787、管理 Worker 在 8788。

前端預設打正式環境的 API。要改打本機後端，寫進 gitignore 過的本機覆寫檔
`frontend/.env.local`（前台）與 `frontend/.env.admin.local`（後台）：

```text
VITE_API_BASE=http://localhost:8787
VITE_PUBLIC_API_BASE=http://localhost:8787
```

後台的那份要用 `.env.admin.local` 而不是 `.env.local`：Vite 的優先序是
`.env` < `.env.local` < `.env.[mode]` < `.env.[mode].local`，所以 `.env.admin`
會蓋掉 `.env.local`。後台的 `VITE_API_BASE` 指 8788。

後端的本機來源設定放在 `backend/.dev.vars`（見
[backend/.dev.vars.example](backend/.dev.vars.example)）。**不要**把 localhost 寫進
`wrangler.toml` 的 `[vars]` —— 那份設定會上到 production，等於讓任何在該埠上的程式
取得正式環境的寫入權。

本機是 http，瀏覽器不會接受 `Secure` cookie，所以需要登入的流程要對著已部署的後端測。

## 測試與部署

```powershell
uv --directory backend run pytest
```

```powershell
cd frontend; npm test; npm run typecheck
```

```powershell
cd desktop; npm test; npm run typecheck
```

推上 `main` 就會部署，不需要手動跑 wrangler。[deploy.yml](.github/workflows/deploy.yml)
分成兩個 job：後端（測試 → 管理 API → 公開 API），然後站台（測試 → 建置 → 後台 → 前台）。
四個部署但只有兩條真正的依賴：**schema 要先於讀它的東西，API 要先於呼叫它的頁面**。
測試跟它守護的部署放在同一個 job，所以沒有「上游應該測過了」這種靠約定成立的假設。

桌面工具不走這條線。它由 `desktop-v{版本}` 這個 tag 的 GitHub release 觸發，
打包上傳之後還要有人到後台把版本政策提上去 —— 發佈和放行是兩個決定。
見 [docs/courses.md](docs/courses.md)。
