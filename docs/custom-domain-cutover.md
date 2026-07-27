# 切換到 luma-studio.tw

前後端搬到自有網域的操作順序。分階段是為了讓任何一步失敗都不會讓已經撒出去的取件連結變成死連結。

目標配置：

| 用途 | 網域 | Cloudflare Worker |
| --- | --- | --- |
| 前端（取件頁、admin） | `luma-studio.tw`、`www.luma-studio.tw` | `luma-studio-web` |
| 後端 API | `api.luma-studio.tw` | `luma-studio` |

兩者在同一個 registrable domain 之下，因此 session cookie 可以從 `SameSite=None` 收回 `Lax`。

## 階段一：DNS（已完成的部分打勾）

1. Gandi 購入 `luma-studio.tw`，關閉附帶的信箱試用。
2. Cloudflare 加入網域，Free 方案，空的 zone，不手動建任何 A/CNAME。
3. Gandi 的 nameserver 改為 Cloudflare 提供的兩組。
4. 等 Cloudflare zone 狀態變為 **Active**。

`ALLOWED_ORIGINS` 已經預先加入新網域。這一步不會影響現行服務，因為還沒有流量從新網域進來。

## 階段二：綁定 Custom Domain

zone 變成 Active 之後：

1. Workers & Pages → `luma-studio-web` → Settings → Domains & Routes → Add → Custom Domain → `luma-studio.tw`。
2. 同一個 Worker 再加一次 `www.luma-studio.tw`。
3. Workers & Pages → `luma-studio` → 同樣加入 `api.luma-studio.tw`。

DNS 記錄與憑證由 Cloudflare 自動建立，不需要手動加。憑證簽發通常幾分鐘。

驗證：

```bash
curl -sI https://api.luma-studio.tw/api/health
curl -s https://api.luma-studio.tw/api/health
```

應該回 200 與 `{"ok": true, ...}`。

## 階段三：Google OAuth

1. Google Cloud Console → OAuth 2.0 Client → Authorized redirect URIs 加入：

   ```text
   https://api.luma-studio.tw/auth/callback
   ```

   舊的 workers.dev callback 先保留，回滾時需要。

2. 更新 secret：

   ```powershell
   uv --directory backend run pywrangler secret put GOOGLE_OAUTH_REDIRECT_URI
   ```

   值填 `https://api.luma-studio.tw/auth/callback`。

這一步做完之前不要進行階段四，否則登入會失敗。

## 階段四：切換前端來源

1. GitHub repository variable `API_BASE_URL` 改為 `https://api.luma-studio.tw`。
2. [backend/wrangler.toml](../backend/wrangler.toml) 的 `FRONTEND_ORIGIN` 改為 `https://luma-studio.tw`。
3. [backend/src/auth.py](../backend/src/auth.py) 的 `session_cookie` 從 `SameSite=None` 改為 `SameSite=Lax`，並更新該函式的註解。
4. 推上 main，等兩個 job 都部署完成。

順序很重要：`API_BASE_URL` 要在前端重新建置之前設定好，否則前端會繼續打 workers.dev 的後端。

## 階段五：驗證

1. `https://luma-studio.tw/admin` 能登入，資料夾清單載入正常。
2. 上傳、刪除圖片、變更列印規格都成功。
3. `https://luma-studio.tw/ibon_print/<id>` 顯示取件頁。
4. 舊連結仍可用：

   ```bash
   curl -sI https://luma-studio.infixman.workers.dev/ibon_print/<id>
   ```

   應回 302，`location` 指向 `https://luma-studio.tw/ibon_print/<id>`。

5. 用手機的 LINE 開啟舊連結，確認會跳到新頁面。

## 回滾

階段四的三項設定改回原值再部署即可。workers.dev 的網域不會被移除，因此隨時可以退回。

## 後續清理

新網域穩定運作一段時間後：

- 從 `ALLOWED_ORIGINS` 移除 `https://luma-studio-web.infixman.workers.dev`。
- Google OAuth 的 Authorized redirect URIs 移除 workers.dev 那筆。
- 保留後端 workers.dev 網域本身，已撒出去的 `/ibon_print/{id}` 連結靠它轉址。
