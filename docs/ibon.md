# ibon 列印

這個專案最早的功能，還在跑。

## 使用方式

公開取件頁（含 QR Code、取件編號與列印期限）：

```text
https://luma-studio.tw/ibon_print/20260721_soda
```

給程式或 Postman 使用時直接打 API：

```text
https://api.luma-studio.tw/api/print/20260721_soda
```

JSON 包含 `pincode`、`deadline`、`qrCodeSvg`、圖檔清單與快取資訊。ibon 的一般 `GetPincode` 回應目前 `qRcode` 為 `null`，因此 Worker 以同一組取件編號產生等效 SVG QR Code。

舊網址仍可用。已經發出去的 `https://api.luma-studio.tw/ibon_print/{id}` 預設一律 302 導向前端頁面——包含 LINE、IG 內建瀏覽器與 QR 掃描 app 這類送 `Accept: */*` 的客戶端。只有明確要求 JSON 的呼叫端會拿到資料：`?format=json`，或送出 `Accept: application/json` 且不接受 HTML。

已知缺口與待辦記在 [backlog.md](backlog.md)。


## 限制

- D1 快取保存 24 小時，並綁定資料夾的 ibon `SelectType`；快取命中時不會再上傳至 ibon。
- 快取未命中時，只接受資料夾內 1–8 個 `jpg/jpeg/png/bmp/gif`，總大小不得超過 15 MB。
- ibon 的 R2 object key 必須為 `<id>/<filename>`。Bio link 頭像是例外，放在 `_bio-link/` 前綴下。
- Bio link 的事件記錄採用「每位訪客每天每個目標最多一筆」，靠唯一索引與 `INSERT OR IGNORE` 達成。這不只是為了數字準確：這兩個端點是公開的，而 D1 的每日寫入額度與 admin session 共用，沒有上限的計數器等於讓任何人都能把你鎖在自己的後台外面。
- 上傳順序為 `BaseEntry/GetEntry` → `IbonUpload/GetPincode` → `GetChunksize` → `Upload`。上游失敗時 JSON API 會回傳不含 token 的 `stage` 與安全診斷資訊。
- ibon 可能變更一般消費者流程或拒絕 Cloudflare 流量；每次部署後應以一個實際資料夾驗證。
- 管理登入依賴跨站 cookie。若瀏覽器封鎖第三方 cookie 導致登入失效，退路是讓前後端共用同一個網域的兩個子網域。
