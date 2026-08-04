# Cloudflare 與部署

## 初次設定


1. 安裝 [uv](https://docs.astral.sh/uv/)，登入 Cloudflare，並安裝依賴：

   ```powershell
   uv --directory backend sync
   uv --directory backend run pywrangler login
   ```

2. 建立資料庫與 R2 bucket：

   ```powershell
   uv --directory backend run pywrangler d1 create luma-ibon-cache
   uv --directory backend run pywrangler r2 bucket create luma-ibon-images
   ```

3. 把 D1 輸出的 `database_id` 同時填入 [backend/wrangler.toml](../backend/wrangler.toml) 與 [backend/wrangler.admin.toml](../backend/wrangler.admin.toml)。兩個 Worker 必須指向同一個資料庫，填錯會安靜地把資料切成兩份。

4. 部署後端。**管理 Worker 要先部署**，因為只有它會套用 migration，公開 Worker 只讀不寫：

   ```powershell
   uv --directory backend run pywrangler deploy -c wrangler.admin.toml
   uv --directory backend run pywrangler deploy
   ```

   secret 是 per-Worker 的，`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_OAUTH_REDIRECT_URI` 要在兩個 Worker 上各設一次，不會互相共用。

5. 部署前端。兩個站台各自建置、各自部署：

   ```powershell
   cd frontend
   npm ci
   npm run build
   npx wrangler deploy -c wrangler.admin.jsonc
   npx wrangler deploy
   ```

   `npm run build` 會跑型別檢查再依序建置兩份。API 網址來自 [.env.production](../frontend/.env.production) 與 [.env.admin](../frontend/.env.admin)，不是環境變數——兩份建置需要不同的值，用同一個 shell 變數餵兩邊，後台就會安靜地連到公開 API。

6. 將本機 `upload_ibon/<id>/` 同步到遠端 R2：

   ```powershell
   .\scripts\sync-r2.ps1 20260721_soda
   ```

7. 套用下一節的後台設定。

## 後台設定

以下設定**不在版控裡**，只存在於 Cloudflare 儀表板。重建環境或換帳號時要照著設一遍，否則會出現一些很難查的症狀——這一節就是為了避免那些。

### 網域與 Worker 綁定

網域註冊在 Gandi，但 nameserver 指向 Cloudflare（Gandi → 網域管理 → Nameservers → External）。Workers 的 Custom Domain 必須在 zone 由 Cloudflare 託管的前提下才能綁。

Workers & Pages → 選 Worker → Settings → Domains & Routes → Add → Custom Domain：

| Worker | 網域 |
| --- | --- |
| `luma-studio-web` | `luma-studio.tw` |
| `luma-studio-web` | `www.luma-studio.tw` |
| `luma-studio-admin` | `admin.luma-studio.tw` |
| `luma-studio-web-api` | `api.luma-studio.tw` |
| `luma-studio-admin-api` | `admin-api.luma-studio.tw` |

DNS 記錄與憑證由 Cloudflare 自動建立。**綁定前不要手動加 A/CNAME**，已存在的記錄會讓綁定失敗。

### 從 `luma-studio` 改名到 `luma-studio-web-api`

**改 `wrangler.toml` 的 `name` 不會改名，會長出第二個 Worker。** 舊的那個還在，而且 `api.luma-studio.tw` 還綁在它身上。所以順序不能顛倒：

1. **先 push**。deploy 會建立 `luma-studio-web-api`——沒有 secrets、沒有網域。此時線上完全不受影響，客人還是走舊的那個。
2. **設 secrets**（secret 不會跟著搬）：`GOOGLE_CUSTOMER_CLIENT_ID`、`GOOGLE_CUSTOMER_CLIENT_SECRET`、`GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI`、`VISITOR_SALT`、`RESEND_API_KEY`。

   `VISITOR_SALT` **一定要用原本那一組**。換了，bio link 的訪客雜湊就變了，同一個人會被算成新訪客——而且不會有任何錯誤訊息，統計只是從那天起悄悄失真。
3. **搬網域**：舊 Worker → Settings → Domains & Routes 移除 `api.luma-studio.tw`，然後在新 Worker 加回去。一個 Custom Domain 同時只能綁一個 Worker，所以中間會有幾十秒打不開。挑沒人的時間做。
4. **驗證**：`https://api.luma-studio.tw/api/health` 回得出 migration 清單就對了。順手開一次前台跟結帳。
5. **把舊的 `luma-studio` 換成跳轉 Worker**（見上一節），不要刪掉它——那個名字撐著已經發出去的 workers.dev 網址。這一步不是收尾，是必要的：舊的那個身上還有 `crons = ["*/5 * * * *"]`，不換掉就會有兩個 Worker 同時掃逾期訂單、同時排空信件佇列。跳轉 Worker 沒有 cron，蓋上去等於把排程拿掉。

Google OAuth 那邊**不用動**。redirect URI 綁的是網域不是 Worker 名字，`https://api.luma-studio.tw/auth/callback` 從頭到尾沒變。D1、R2 與速率限制的 binding 都寫在 `wrangler.toml` 裡，跟著部署走。

### 已經發出去的 workers.dev 網址

`https://luma-studio.infixman.workers.dev/ibon_print/20260721_soda` 印出去過。

**workers.dev 的主機名就是 Worker 的名字**，所以那個網址只在有一個叫 `luma-studio` 的 Worker 時才存在。改名之後如果把舊的刪掉，那條連結就永遠救不回來——`luma-studio-web-api.infixman.workers.dev` 是另一個網址。

所以 `luma-studio` 這個名字留著，但裡面換成一個只會跳轉的小 Worker（[frontend/worker/legacy.ts](../frontend/worker/legacy.ts)、[frontend/wrangler.legacy.jsonc](../frontend/wrangler.legacy.jsonc)）。它沒有 D1、沒有 R2、沒有 secrets，**也沒有 cron**——兩個 Worker 共用同一個排程會讓逾期訂單被掃兩次、信件佇列被排空兩次。

只有 `/ibon_print/{id}` 會帶著路徑過去，其他一律送到首頁：舊主機是 API，它的其他路徑在網站上意義不同，照著轉會落在一個看起來像我們壞掉的 404。

用 302 不用 301。這是**臨時**的——等到沒有人手上還拿著印了舊網址的紙就可以撤掉——而 301 會被瀏覽器快取到你改變主意也沒用。

⚠️ **`api.luma-studio.tw` 搬到 `luma-studio-web-api` 之前不要部署它。** 用這個名字部署會蓋掉目前叫 `luma-studio` 的東西，而在網域搬走之前，那就是線上的公開 API。

```powershell
cd frontend
npx wrangler deploy -c wrangler.legacy.jsonc
```

刻意沒有放進 CI，就是為了不讓它在搬移完成前被自動部署出去。搬完之後要不要加進 `deploy.yml` 隨你——它幾乎不會再改。

### Worker secrets

只有後端 Worker 需要。用指令設定，不要寫進 `wrangler.toml` 的 `[vars]`——那份設定會進版控。

**secret 是 per-Worker 的**，而且兩個 Worker 需要的**不一樣**。

| Worker | Secret | 內容 |
| --- | --- | --- |
| `luma-studio-web-api` | `GOOGLE_CUSTOMER_CLIENT_ID` | 顧客那組 OAuth client |
| `luma-studio-web-api` | `GOOGLE_CUSTOMER_CLIENT_SECRET` | 同上 |
| `luma-studio-web-api` | `GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI` | `https://api.luma-studio.tw/auth/callback` |
| `luma-studio-web-api` | `VISITOR_SALT` | 任意隨機字串，雜湊 bio link 訪客識別 |
| `luma-studio-admin-api` | `GOOGLE_CLIENT_ID` | 店主那組 OAuth client |
| `luma-studio-admin-api` | `GOOGLE_CLIENT_SECRET` | 同上 |
| `luma-studio-admin-api` | `GOOGLE_OAUTH_REDIRECT_URI` | `https://admin-api.luma-studio.tw/auth/callback` |
| `luma-studio-web-api` | `RESEND_API_KEY` | 寄信用。**只有公開 Worker 需要**——排空信件佇列的排程在那邊 |

沒有設 `RESEND_API_KEY` 或 `MAIL_FROM` 時整套通知信是關的：不會排入、不會寄出，也不會累積一堆之後突然全部寄出去的舊信。

`MAIL_FROM` 與 `MAIL_OWNER` 不是 secret（不是憑證），寫在兩個 Worker 的 `[vars]` 裡：

```toml
MAIL_FROM = "苒光繪誌 <shop@luma-studio.tw>"   # 網域要先在 Resend 驗證過
MAIL_OWNER = "你的信箱"                        # 收「有新訂單」的通知
```

管理 Worker 也要 `MAIL_FROM`——它會排入「已出貨」這類信，而 `MAIL_FROM` 是那個開關。它不需要 `RESEND_API_KEY`，因為它不負責寄。

```powershell
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_CLIENT_ID
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_CLIENT_SECRET
uv --directory backend run pywrangler secret put GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI
uv --directory backend run pywrangler secret put VISITOR_SALT

# 課程播放授權的簽章金鑰。沒有它，播放 session 端點會回 503 而不是發出
# 一張沒有簽章的 token。輪替時把舊值放進 PLAYBACK_SECRET_PREVIOUS，
# 驗證會同時接受兩把、簽發只用新的那把，正在上課的人不會被踢出去。
uv --directory backend run pywrangler secret put PLAYBACK_SECRET
uv --directory backend run pywrangler secret put PLAYBACK_SECRET_PREVIOUS

uv --directory backend run pywrangler secret put GOOGLE_CLIENT_ID -c wrangler.admin.toml
uv --directory backend run pywrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.admin.toml
uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI -c wrangler.admin.toml

# R2 的 S3 API 金鑰，用來簽出上傳影片的短效 URL。只有管理 Worker 有它 ——
# 公開 Worker 不簽任何東西，桌面工具拿到的是簽好的 URL 而不是金鑰。
# 缺它的時候 presign 會回 503，而不是發出一張到了 R2 才失敗的 URL。
uv --directory backend run pywrangler secret put R2_ACCESS_KEY_ID -c wrangler.admin.toml
uv --directory backend run pywrangler secret put R2_SECRET_ACCESS_KEY -c wrangler.admin.toml

# 後台預覽轉檔結果時，用的是跟會員同一套播放 token。secret 是綁 Worker 的，公開
# Worker 那一把不會出現在這裡，缺它預覽會回 503。兩把不需要一樣：後台的 token
# 由後台自己簽、自己驗。
uv --directory backend run pywrangler secret put PLAYBACK_SECRET -c wrangler.admin.toml

# 桌面工具配對碼的來源。每個管理者的 TOTP seed 是這個值和他的 email 導出的，
# 所以**沒有任何 seed 存在資料庫裡** —— 不用遷移、不用「只顯示一次」、
# D1 被 dump 也拿不到東西。換掉這個值就等於一次撤銷所有已配對的機器。
uv --directory backend run pywrangler secret put DESKTOP_PAIRING_SECRET -c wrangler.admin.toml

# 桌面工具 token 的簽章金鑰。跟配對碼分開，因為兩者的壽命和撤銷方式不同：
# 換配對 secret 只是讓新的配對要重做，換這一把是立刻讓所有已發出的 token 失效。
uv --directory backend run pywrangler secret put DESKTOP_TOKEN_SECRET -c wrangler.admin.toml
```

`wrangler.admin.toml` 裡的 `R2_S3_ENDPOINT` 要填成
`https://<account-id>.r2.cloudflarestorage.com`。它不是秘密（每張簽好的 URL 裡都有），
但是帳號專屬的，所以放設定而不是程式。留空的話 presign 一律 503。

管理 Worker **不需要** `VISITOR_SALT`（只有 `bio_link.record_event` 讀它，而記錄瀏覽是公開端的事），也不需要任何 `IBON_*`（後台只讀 D1 的列印設定，不跑上傳流程）。

兩組 OAuth client 而不是一組配兩個 redirect URI：店主那組可以在 Google Cloud Console 上設得更嚴，而顧客那組的 client secret 外洩也不會波及後台。

從舊架構搬過來時，公開 Worker 上原有的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_OAUTH_REDIRECT_URI` 已經沒有程式碼在讀——管理登入搬走了。留著只是三個沒有用途的憑證，用 `pywrangler secret delete` 移除。

### 速率限制規則

Security → Security rules → Rate limiting rules → Create rule。

| 欄位 | 值 |
| --- | --- |
| Rule name | `api flood guard` |
| Expression | `starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/auth/") or starts_with(http.request.uri.path, "/r/") or starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/bio-link-assets/") or starts_with(http.request.uri.path, "/ibon_print/")` |
| Requests / Period | 50 / 10 秒 |
| Action / Duration | Block / 10 秒 |

免費方案把 Period、Duration 鎖在 10 秒，計數依據固定為 IP，只有 Requests 可調。

**為什麼是 50 而不是更嚴**：團體包班時整間教室共用一個對外 IP，7-11 店內 Wi-Fi 也是。設太緊會整班一起被擋。觀察 Security → Events 的觸發次數再調整。

這是唯一能保護 **Worker 每日請求額度**的一層，因為它在 Worker 之前執行。`backend/src/rate_limit.py` 的限制器保護的是 D1、R2 與 ibon 上傳，但限制器要執行，Worker 就已經被叫起來了。

### 快取規則

Caching → Cache Rules → Create rule。

| 欄位 | 值 |
| --- | --- |
| Rule name | `cache r2 assets` |
| Expression | `starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/bio-link-assets/")` |
| Cache eligibility | Eligible for cache |
| Edge TTL | Use cache-control header if present, bypass cache if not |

Cloudflare **預設不會快取 Worker 產生的回應**，所以沒有這條規則的話，每一次圖檔請求都是一筆 R2 讀取。Worker 已經在回應中送出 `cache-control: public, max-age=3600`，這條規則只是讓它生效。

### 安全性與協定設定

| 位置 | 項目 | 值 | 原因 |
| --- | --- | --- | --- |
| Security → Settings | Bot Fight Mode | **關** | 對純 JSON API 子網域誤判率高，會擋掉帶認證的 XHR |
| Security → Settings | Browser Integrity Check | 開 | 預設值，擋標頭異常的請求 |
| Speed → Settings | Always use HTTPS | 開 | |
| Speed → Settings | 0-RTT Connection Resumption | **關** | early data 在某些路徑上會被回 403 |

### 曾經踩過的坑

**HTTP/3 回 403。** 曾出現整個 `api.luma-studio.tw` 在某台機器的 Edge 上回 403，但同一台機器的 curl 正常、無痕視窗正常、Cloudflare 的 firewall event 查無記錄。原因是該網路的 HTTP/3（QUIC）路徑異常；`edge://flags` 關閉 Experimental QUIC protocol 後恢復。

診斷順序：比對瀏覽器與 curl 的 `https://www.cloudflare.com/cdn-cgi/trace` 輸出，若 `ip=` 相同而 `http=` 不同，就是協定層而非 Cloudflare 設定的問題。**不要在這種情況下逐項關閉安全設定**——firewall event 查不到記錄就代表不是那一層擋的。


## Admin 與 Google OAuth

管理介面：

```text
https://admin.luma-studio.tw
```

舊網址 `https://luma-studio.tw/admin` 會 301 轉過來。

**`/` 是總覽，不是 ibon 列印**（ibon 移到 `/ibon`）。後台開起來第一眼該回答的是「今天有什麼事等我」——已付款還沒出貨幾筆、什麼快賣完、近三十天收了多少、上次在改哪一頁。ibon 是工具，工具不是首頁。

總覽的每個數字都是資料庫自己算的（[dashboard.py](../backend/src/domain/dashboard.py)），不是把資料列讀進 Python 再加總：這一頁開的次數最多，不能隨著生意變好而變慢。

兩個容易搞混的定義寫在測試裡：**營收從 `paid_at` 算不是 `created_at`**（三月下單、四月付款算四月的錢），**庫存警示的門檻不是零**（等到零的時候才補已經來不及了）。

**未登入的訪客只會看到一頁登入畫面**，沒有分頁列、沒有卡片、沒有表單（[AdminGate](../frontend/src/admin/components/AdminGate.tsx)）。先渲染介面、再讓各頁的 401 把人踢去 Google，等於讓路過的人看完整份功能清單——分頁名稱、卡片標題、每個表單的形狀。單獨看都不是什麼機密，合起來就是一份寫給不該讀的人看的營運說明。

這是**揭露面**的處理，不是授權本身。真正的邊界在管理 Worker：沒有 session 的請求一律 401，這件事有測試守著（`test_admin_routing.py`）。前端的閘門讓人看不到，後端的閘門讓人拿不到。

僅允許 `chiao7912@gmail.com`、`infixman@gmail.com` 這兩個已驗證 Google 帳號。介面可建立資料夾、上傳/刪除圖片、刪除空資料夾、複製或開啟公開取件頁與圖檔網址，並設定每個資料夾的紙張尺寸、色彩、單/雙面與紙張種類。

預設規格為 **A4／彩色／單面列印／一般用紙**，對應 ibon `SelectType: FA4CN1`。每次規格異動都會清除該資料夾的 ibon 24 小時快取；下一個公開列印請求會以新的 `SelectType` 建立 pincode。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立 **Web application** OAuth 2.0 Client。
2. 在 Authorized redirect URIs 加入後端的 callback：

   ```text
   https://api.luma-studio.tw/auth/callback
   ```

3. 將 OAuth 值存為 Cloudflare secrets，切勿寫入 Git：

   ```powershell
   uv --directory backend run pywrangler secret put GOOGLE_CLIENT_ID
   uv --directory backend run pywrangler secret put GOOGLE_CLIENT_SECRET
   uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI
   ```

4. Bio link 的訪客雜湊需要一組隨機鹽值，同樣以 secret 保存：

   ```powershell
   uv --directory backend run pywrangler secret put VISITOR_SALT

# 課程播放授權的簽章金鑰。沒有它，播放 session 端點會回 503 而不是發出
# 一張沒有簽章的 token。輪替時把舊值放進 PLAYBACK_SECRET_PREVIOUS，
# 驗證會同時接受兩把、簽發只用新的那把，正在上課的人不會被踢出去。
uv --directory backend run pywrangler secret put PLAYBACK_SECRET
uv --directory backend run pywrangler secret put PLAYBACK_SECRET_PREVIOUS
   ```

   值填任意隨機字串。**不要**寫進 `wrangler.toml` 的 `[vars]`——那份設定會進版控，鹽值一旦公開，任何人都能從 IP 反推訪客雜湊。未設定時程式會退回每個 isolate 隨機產生的鹽值，雜湊仍然安全，但「同一訪客每日只記一次」的去重只在單一 isolate 內成立。

`GOOGLE_OAUTH_REDIRECT_URI` 的值是上面的完整 callback URL。

## GitHub 自動部署

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) 在 `main` 有新 commit 時部署四個站台，但只有**兩個 job**：

```text
後端 Worker（測試 → 管理 API → 公開 API）
        ↓
網站（測試 → 建置 → 管理後台 → 商店前台）
```

四個部署但只有兩條真正的依賴：**schema 要先於讀它的東西**，**API 要先於呼叫它的頁面**。那是一條線，不是一張圖。job 內部的先後就是普通的步驟順序，比一堆 `needs:` 好讀，而且不用多付一份冷環境的成本——兩個後端 Worker 共用同一份原始碼和同一個 token。

**測試跟它守護的部署放在同一個 job。** 拆成四個 job 時，測試只跑在其中兩個，另外兩個靠 `needs` 假設上游測過了——那是一個沒有東西在強制的約定，改動依賴關係就會讓測試安靜地不再擋住部署。

商店前台放在管理後台之後，只是為了讓 `/admin` 的 301 一上線就有地方可去。這是步驟順序，不是 job 依賴：顧客看得到的商店，不該被內部工具的建置擋住。

所有 job 都綁在名為 `production` 的 GitHub Environment，請先建立該 environment，再於 repository 的 **Settings → Secrets and variables → Actions**（或該 environment）設定：

- `CLOUDFLARE_API_TOKEN`：具此帳號 Workers 部署權限的 API token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID。

前端的 API 網址不再由 CI 變數提供，改放在 [frontend/.env.production](../frontend/.env.production) 與 [frontend/.env.admin](../frontend/.env.admin)。兩份建置需要不同的值，一個 shell 變數同時餵兩邊會讓後台連錯 API，而那是一種不會報錯的壞法。

Google OAuth secrets 只留在 Cloudflare，GitHub Actions 不需要也不應持有它們。
