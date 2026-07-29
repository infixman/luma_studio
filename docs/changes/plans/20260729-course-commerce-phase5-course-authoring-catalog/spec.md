# Phase 5 規格：Course Authoring 與商品頁

## 目標

提供完整 Course、Section、Lesson 管理，讓課程單元引用 ready VideoAsset，並將課程
公開資訊整合到含 Course component 的商品頁。

## 資料庫規格

### 擴充 `courses`

| 欄位 | 說明 |
| --- | --- |
| `summary` | 商品卡或頁首短摘要 |
| `description_html` | 完整介紹 |
| `cover_media_id` | 圖片媒體庫引用 |
| `instructor_name` | 講師 |
| `instructor_bio_html` | 講師介紹 |
| `level` | beginner/intermediate/advanced/all |
| `language` | 預設 zh-Hant |
| `audience_html` | 適合對象 |
| `outcomes_html` | 學習成果 |
| `prerequisites_html` | 先備知識 |
| `materials_html` | 工具與材料 |
| `published_at` | 首次／最近發布時間 |

### `course_sections`

```text
id, course_id, title, position, created_at, updated_at
```

### `course_lessons`

```text
id, section_id, title, content_html, video_asset_id,
is_preview, position, created_at, updated_at
```

索引：

- sections `(course_id, position)`
- lessons `(section_id, position)`
- lessons `(video_asset_id)` 供引用檢查

影片長度由 VideoAsset 取得，不複製到 Lesson；公開 API 可在 query 時組合並回傳衍生總時數。

## 管理 API

```text
GET    /api/courses?q=&status=&cursor=
POST   /api/courses
GET    /api/courses/{id}
PUT    /api/courses/{id}
POST   /api/courses/{id}/publish
POST   /api/courses/{id}/archive
PUT    /api/courses/{id}/outline
GET    /api/courses/{id}/references
```

### Outline Request

使用完整樹狀集合更新：

```json
{
  "sections": [
    {
      "id": "existing-or-client-temp-id",
      "title": "第一章",
      "lessons": [
        {
          "id": "existing-or-client-temp-id",
          "title": "工具介紹",
          "contentHtml": "<p>...</p>",
          "videoAssetId": "asset-id",
          "isPreview": true
        }
      ]
    }
  ]
}
```

API 回傳正式 id 與正規化 position。更新前驗證完整樹，避免刪掉舊 outline 後才發現
某個 VideoAsset 不合法。

若一次 outline 大小超過 Worker 或 D1 合理負荷，可改為 section-level 完整更新；不能
退回每個欄位各自寫入而沒有一致的儲存邊界。

## HTML Sanitization

- 後端保存前 sanitize。
- 管理與公開回應使用相同已清理 HTML。
- URL protocol allowlist。
- 圖片只允許 Luma Media Library 的已知 URL/id。
- 外部連結自動補安全的 `rel`。
- 測試 script、event handler、style、javascript URL、畸形 HTML。

## 發布驗證

Course publish 必須：

- title、slug、summary 有效。
- 至少一個 section 與 lesson。
- 所有有 `video_asset_id` 的 Lesson 指向 ready asset。
- cover 存在且可讀。
- HTML 已通過 sanitize。
- 沒有重複 position 或孤兒 Lesson。

Offer enable/商品 active 必須另外驗證所有 course component 指向 published Course。

## 公開 API

### 商品詳情擴充

回傳：

```json
{
  "containsCourse": true,
  "courses": [
    {
      "slug": "watercolor-flowers",
      "title": "水彩花卉入門",
      "summary": "...",
      "coverPath": "...",
      "instructor": {},
      "level": "beginner",
      "language": "zh-Hant",
      "lessonCount": 12,
      "durationSeconds": 12240,
      "sections": [
        {
          "title": "第一章",
          "lessons": [
            {"title": "工具介紹", "durationSeconds": 600, "isPreview": true}
          ]
        }
      ]
    }
  ]
}
```

未購買者不取得非試看 Lesson 的 HTML 或任何 private video key。

### 課程公開頁

可以提供：

```text
GET /api/courses/{slug}/public
```

只回傳 published Course 與安全的公開介紹。若課程只透過商品頁呈現，第一版可不建立
獨立公開路由，但 domain response 應可重用。

## 管理前端

- Course list：搜尋、狀態、單元數、總時長、更新時間。
- Course editor：基本資料、HTML、章節單元、影片 picker、發布檢查。
- Video picker 只允許 ready，並顯示 duration/resolution/poster。
- 離開未儲存頁面需提示。
- 儲存與發布分開。
- 顯示被哪些 Offer 使用。

## 商城前端

- ProductPage 根據 `containsCourse` 呈現課程資訊。
- 多 Course bundle 逐門顯示摘要與大綱。
- 方案卡清楚列出哪些含材料包、觀看期限與配送提示。期限型 Offer 必須寫「觀看後 N 天內有效」
  而非「購買後 N 天」，`access_days` 為 NULL 時寫「永久觀看」。
- 試看按鈕接 phase6 gateway；phase6 前隱藏或 feature flag。
- 一般實體商品頁不載入或渲染課程區塊。

## 測試範圍

- Course CRUD、slug、狀態。
- Outline 正規化、移動、刪除與 temp id mapping。
- ready/processing/failed VideoAsset 驗證。
- HTML sanitizer 攻擊字串。
- 發布檢查。
- Offer 不得啟用 draft Course。
- 公開 API 不洩漏 private key 或鎖定 Lesson HTML。
- 商品頁純實體、單課程、多課程、混合方案。

## 驗收標準

- 管理員可建立含 HTML、章節、單元與影片的 published Course。
- 同一 ready VideoAsset 可被多個 Lesson 引用。
- 課程內容只存一份，Product 不複製。
- 商品頁能清楚呈現課程資訊與不同 Offer 內容。
- 非購買者取得不到鎖定 Lesson 內容或影片位置。
- 課程商品仍以 feature flag 保護，直到 phase6 完成。
