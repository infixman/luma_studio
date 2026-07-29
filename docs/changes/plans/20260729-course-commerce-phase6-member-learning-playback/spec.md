# Phase 6 規格：Learning Portal 與 Playback Gateway

## 目標

讓有效 entitlement 的會員可以瀏覽課程與播放 private R2 HLS，並保存觀看進度；
未登入、未購買、過期或被撤銷者不能取得可用播放 session。

## 資料庫規格

### `course_lesson_progress`

```sql
CREATE TABLE course_lesson_progress (
  customer_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, lesson_id)
);
```

索引：

- `(customer_id, course_id, updated_at)`
- 必要時 `(course_id, completed_at)` 供統計；第一版可不建。

Playback session 採 stateless signed token 時不需要 D1 session table。若營運要求立即撤銷、
裝置限制或 session 管理，再新增 server-side table，不在第一版預先增加。

## Learning API

```text
GET  /api/learning/courses
GET  /api/learning/courses/{courseSlug}
GET  /api/learning/courses/{courseSlug}/lessons/{lessonId}
POST /api/learning/courses/{courseId}/lessons/{lessonId}/playback-session
PUT  /api/learning/courses/{courseId}/lessons/{lessonId}/progress
POST /api/learning/courses/{courseId}/lessons/{lessonId}/complete
```

所有 endpoint：

- 使用 customer session，不接受 customer id request parameter。
- 檢查 blocked customer。
- 檢查有效 entitlement。
- Course archived 不影響既有有效 entitlement：archive 只阻止新販售與新授權，會員的
  learning 與播放維持可用（2026-07-30 決策）。

### 有效 Entitlement

```text
customer_id == current customer
revoked_at IS NULL
expires_at IS NULL OR expires_at > now
course_id matches
```

不能只檢查是否存在歷史 order item。`expires_at IS NULL` 有兩種意義：`access_days IS NULL`
的永久授權，以及期限型但尚未啟動倒數的授權。兩者在有效性判斷上都算有效。

退款、已付款取消或 chargeback 撤銷後，entitlement 的 `revoked_at` 會被寫入，Learning
與 Playback 一律拒絕；但觀看進度、訂單與 audit 仍保留，不刪除。

### 首次觀看啟動期限

期限型授權（`access_days` 非 NULL 且 `first_viewed_at IS NULL`）在**第一次成功核發受保護
Lesson／VideoAsset 的 playback session** 時啟動：

```sql
UPDATE course_entitlements
SET first_viewed_at = ?now,
    expires_at = ?now + access_days * 86400,
    updated_at = ?now
WHERE id = ?id
  AND access_days IS NOT NULL
  AND first_viewed_at IS NULL
  AND revoked_at IS NULL;
```

規則：

- 條件 UPDATE 只會成功一次；後續播放與 session refresh 不得重設或延長。
- 啟動發生在授權檢查通過**之後**、回傳 session 之前。若 session 核發失敗則不啟動。
- 只有受保護內容會啟動。`/api/learning/courses` 列表、Course detail、商品頁、公開課程頁
  與 preview scope 的試看 session **一律不得**寫入 `first_viewed_at`。
- 啟動要寫 audit，供客訴查詢「什麼時候開始算」。
- 啟動與否不影響本次 session 的有效性；剛啟動的授權必然仍在期限內。

## Course Response

「我的課程」只回有效 entitlement 的 Course：

```json
{
  "courses": [
    {
      "slug": "watercolor-flowers",
      "title": "水彩花卉入門",
      "coverPath": "...",
      "accessDays": null,
      "firstViewedAt": null,
      "expiresAt": null,
      "lessonCount": 12,
      "completedCount": 4,
      "lastLessonId": "lesson-id",
      "lastViewedAt": 1785292800
    }
  ]
}
```

`accessDays` 為 NULL 表示永久。`accessDays` 非 NULL 且 `firstViewedAt` 為 NULL 時，UI 顯示
「觀看後 N 天內有效」，不顯示到期日；已啟動則顯示 `expiresAt`。列出課程清單不得啟動倒數。

Course detail 可以回完整已授權 Lesson HTML，但不能回 R2 key、master key 或未簽章的
媒體 URL。

## Playback Session API

### 驗證

1. customer session。
2. entitlement（含 revoked／expired 判斷）。
3. Course、Section、Lesson 關係。
4. Lesson 的 VideoAsset 為 ready。
5. asset active encode version 存在。
6. 全部通過後，對期限型且尚未啟動的 entitlement 執行一次條件 UPDATE 啟動倒數。

### Response

```json
{
  "playbackUrl": "/course-media/asset-id/version/master.m3u8",
  "expiresAt": 1785294000
}
```

並設定：

```text
Secure
HttpOnly
SameSite=Lax 或更嚴格且不破壞目前網域
Path=/course-media/{assetId}/{encodeVersion}/
短效 Max-Age
```

若 cookie 位於 API domain，HLS client 必須使用 credentials，CORS 只允許 storefront
origin 並允許 credentials。

## Token 驗證

- 使用版本化 payload 與 HMAC-SHA256 或環境支援的等效演算法。
- constant-time signature comparison。
- 驗證 `exp`、`iat` 合理範圍。
- path 中 asset/version 必須與 token 完全一致。
- token secret 由 Worker secret 提供並支援 key rotation。
- 不將 token、cookie 或完整簽章寫入 log。

Key rotation 可在驗證端短期接受 current/previous key，核發只使用 current key。

## Gateway Object 規格

允許：

- `master.m3u8`
- rendition playlist
- init segment
- `.m4s` segment
- poster（若學習頁需要）

拒絕：

- `..`、編碼後 traversal、反斜線。
- 不屬於允許副檔名的 object。
- source bucket object。
- token asset/version 以外的路徑。

Content-Type、Range、Cache-Control 與 ETag 由已知輸出 metadata 設定，不信任 request
任意指定 R2 key。

## 快取規格

- 授權檢查發生在 cache lookup 前。
- Cache key 不含 customer id、cookie 或 token。
- 只 cache 200 且來自 active/immutable encode version 的媒體 object。
- 401、403、404 不共享 cache。
- Playlist 與 segment 的 cache TTL 分開。
- 切換 encode version 後，新 URL 自然使用新 cache key。

## Progress API

Request：

```json
{
  "positionSeconds": 482,
  "completed": false
}
```

規則：

- 非負整數。
- 若有影片，不得明顯超過 duration。
- 純 HTML Lesson 可只使用 completed。
- 只允許目前 Course 的 Lesson。
- upsert 只更新目前 customer。
- 客戶端以節流方式送出；服務端仍需 rate limit。

## 前端規格

### Routes

```text
/account/courses
/learn/{courseSlug}
/learn/{courseSlug}/lessons/{lessonId}
```

### Player

- 使用支援 HLS 的原生能力或 hls.js。
- 所有 media request 帶 credentials。
- 401/403 時停止重試並重新檢查 entitlement。
- session 到期前 refresh，不重新載入整頁。
- 儲存 progress 時避免阻塞播放。
- 顯示 processing/failed 不應發生；若資產後續失效，顯示可理解錯誤。

### Accessibility

- 播放器可用鍵盤操作。
- 控制項有標籤與明確焦點。
- 章節目錄使用正確 heading/list 結構。
- 完成狀態不能只靠顏色。
- 手機觸控目標符合合理尺寸。

## 安全測試

- anonymous 播放 session。
- 登入但沒有 entitlement。
- entitlement 過期／撤銷。
- 用 A 會員 cookie 播放 B 不擁有的 Course。
- token 改 asset/version/expiry。
- token 過期。
- 分享 URL 但沒有 cookie。
- path traversal 與不允許副檔名。
- preview token 嘗試播放非 preview Lesson。
- Cache hit 仍需授權。
- 期限型授權第一次播放才寫 `first_viewed_at`／`expires_at`；第二次播放與 session refresh 不變更。
- 併發兩個 playback session 請求只啟動一次倒數。
- 列出我的課程、開啟 Course detail、播放 preview 都不啟動倒數。
- 已撤銷 entitlement 無法建立 session，但觀看進度仍在。
- archived Course 的既有有效 entitlement 仍可播放。

## 驗收標準

- 付款並取得 entitlement 的會員在「我的課程」看得到課程。
- 未登入、未購買、過期與撤銷都無法建立播放 session。
- 期限型授權的倒數只由第一次受保護播放啟動，且只啟動一次。
- 只有 m3u8 URL、沒有 cookie 無法播放。
- 每個 segment 不查 D1，但仍驗證短效簽章。
- R2 bucket 保持 private，公開 API 不洩漏 object key。
- 觀看進度可跨裝置恢復。
- 文件明確揭露一般 HLS 不是 DRM。
