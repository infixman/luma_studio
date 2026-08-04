# 名片頁

公開頁：

```text
https://luma-studio.tw/card
```

編輯介面在 admin 的第二個分頁：

```text
https://admin.luma-studio.tw/card
```

可設定頭像、顯示名稱、簡介，以及兩組連結：主要的連結按鈕，和一排社群 icon。兩者都可排序、可個別停用。頭像未設定時公開頁改用 logo。

限制：連結合計最多 50 筆、標題 80 字、網址 2048 字且只接受 `http`、`https`、`mailto`、`tel`；頭像 2 MB 以內的 jpg、png、gif、webp。頭像存在同一個 R2 bucket 的 `_bio-link/` 前綴下，該前綴刻意不符合 ibon 的資料夾規則，因此不會出現在資料夾清單，`/images/` 也取不到。

連結順序可拖曳調整，也保留上下箭頭按鈕——拖曳在鍵盤上無法操作，手機上也不好按。

## 造訪統計

編輯頁下方有 7／30／90 天的統計：頁面瀏覽、連結點擊、點擊率、每日長條圖、各連結點擊排行，以及國家、來源網站、裝置的前幾名。

公開頁上的每個連結都指向 `/r/{id}`，由後端記錄後再轉出。記錄的是每位訪客每天每個目標一筆，內容包含國家、城市、來源網站、裝置類別與一組每日輪替的匿名雜湊，**無法識別個人，也無法跨日追蹤**。User-Agent 看起來是機器人或連結預覽器時完全不記錄。

因此所有數字都是「不重複訪客」而非原始次數：同一人整天重整也只算一次。這不只是讓數字有意義，更是必要的防護——這兩個端點是公開的，而 D1 的每日寫入額度與 admin session 共用。

## 分享預覽

`/card` 被貼到 LINE、Facebook、Slack 時會顯示標題、簡介與品牌卡片。SPA 在爬蟲眼中是空白的 HTML，所以前端 Worker（[frontend/worker/storefront.ts](../frontend/worker/storefront.ts)）會在回傳頁面前，向 API 取得目前內容並把 Open Graph 標籤寫進 `<head>`。爬蟲來得又急又密集，因此那次 API 呼叫在邊緣快取五分鐘。

預覽圖是 `public/assets/share-card.png`（1200×630），不是頭像——預覽卡片會裁切成約 1.91:1，方形頭像進去只會剩下一條。換 logo 之後重新產生：

```powershell
uv run --with pillow python scripts/build-share-card.py
```
