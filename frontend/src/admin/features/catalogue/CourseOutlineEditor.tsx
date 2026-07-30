import { useCallback, useEffect, useState } from 'preact/hooks'

import { Badge, Button, EmptyState, IconButton, Select, TextField, useConfirm } from '../../components/ui'
import { api } from '../../../shared/api'
import { runtime } from '../../lib/videoFacts'
import type { CourseLesson, CourseSection, VideoAsset } from '../../../shared/types'

function emptyLesson(position: number): CourseLesson {
  return { id: null, title: '', contentHtml: '', videoAssetId: null, isPreview: false, position }
}

function nameOf(titled: { title: string }): string {
  return titled.title || '未命名'
}

/**
 * Writing a course's chapters and lessons.
 *
 * The tree is edited as a whole and handed back as a whole, because that is how
 * the server replaces it. A per-row save would leave an outline half-changed on
 * any failed request, and half a course is worse than an unsaved one.
 *
 * Positions are renumbered after every change. They are what the server orders
 * by, so a move that reordered the array without renumbering would save the
 * order the author started with.
 */
export function CourseOutlineEditor({
  sections,
  onChange,
}: {
  sections: CourseSection[]
  onChange: (next: CourseSection[]) => void
}) {
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const { ask, dialog } = useConfirm()

  useEffect(() => {
    // Only finished videos. A lesson pointing at one still encoding cannot be
    // published, so offering it here would only produce an error later.
    api<{ assets: VideoAsset[] }>('/api/video-assets?status=ready')
      .then((data) => setAssets(data.assets.filter((asset) => asset.status === 'ready')))
      .catch(() => setAssets([]))
  }, [])

  const renumber = useCallback(
    (next: CourseSection[]) =>
      onChange(
        next.map((section, position) => ({
          ...section,
          position,
          lessons: section.lessons.map((lesson, lessonPosition) => ({ ...lesson, position: lessonPosition })),
        })),
      ),
    [onChange],
  )

  function patchSection(index: number, patch: Partial<CourseSection>) {
    renumber(sections.map((section, at) => (at === index ? { ...section, ...patch } : section)))
  }

  function patchLesson(sectionIndex: number, lessonIndex: number, patch: Partial<CourseLesson>) {
    patchSection(sectionIndex, {
      lessons: sections[sectionIndex]!.lessons.map((lesson, at) =>
        at === lessonIndex ? { ...lesson, ...patch } : lesson,
      ),
    })
  }

  function moveLesson(sectionIndex: number, from: number, to: number) {
    const lessons = [...sections[sectionIndex]!.lessons]
    const [moved] = lessons.splice(from, 1)
    if (!moved) return
    lessons.splice(to, 0, moved)
    patchSection(sectionIndex, { lessons })
  }

  function moveSection(from: number, to: number) {
    const next = [...sections]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    renumber(next)
  }

  async function removeSection(index: number) {
    const section = sections[index]!
    const ok = await ask({
      title: '移除章節',
      body: (
        <>
          <p>確定要移除章節「{nameOf(section)}」嗎？</p>
          {/* Not obvious, and not recoverable, so it gets said out loud. */}
          {section.lessons.length > 0 && (
            <p>裡面的 {section.lessons.length} 個單元會一起移除。已購買的會員不受影響。</p>
          )}
        </>
      ),
      confirmLabel: '移除',
    })
    if (!ok) return
    renumber(sections.filter((_, at) => at !== index))
  }

  const videoOptions = [
    { value: '', label: '文字單元（不放影片）' },
    ...assets.map((asset) => ({
      value: asset.id,
      label: runtime(asset.durationSeconds)
        ? `${asset.title}（${runtime(asset.durationSeconds)}）`
        : asset.title,
    })),
  ]

  return (
    <>
      {dialog}

      {sections.length === 0 ? (
        <EmptyState title="還沒有章節" body="課程至少要有一個章節與一個單元才能發布。" compact />
      ) : (
        <ol class="course-outline-editor">
          {sections.map((section, sectionIndex) => (
            <li key={section.id ?? `new-section-${sectionIndex}`}>
              <div class="course-section-head">
                <TextField
                  label={`第 ${sectionIndex + 1} 章`}
                  value={section.title}
                  maxLength={120}
                  onInput={(event) =>
                    patchSection(sectionIndex, { title: (event.currentTarget as HTMLInputElement).value })
                  }
                />
                <IconButton
                  label={`將章節「${nameOf(section)}」往上移`}
                  size="sm"
                  disabled={sectionIndex === 0}
                  onClick={() => moveSection(sectionIndex, sectionIndex - 1)}
                >
                  ↑
                </IconButton>
                <IconButton
                  label={`將章節「${nameOf(section)}」往下移`}
                  size="sm"
                  disabled={sectionIndex === sections.length - 1}
                  onClick={() => moveSection(sectionIndex, sectionIndex + 1)}
                >
                  ↓
                </IconButton>
                <IconButton
                  label={`移除章節「${nameOf(section)}」`}
                  size="sm"
                  onClick={() => void removeSection(sectionIndex)}
                >
                  ×
                </IconButton>
              </div>

              <ul class="course-lesson-rows">
                {section.lessons.map((lesson, lessonIndex) => (
                  <li key={lesson.id ?? `new-lesson-${lessonIndex}`}>
                    <TextField
                      label="單元名稱"
                      value={lesson.title}
                      maxLength={120}
                      onInput={(event) =>
                        patchLesson(sectionIndex, lessonIndex, {
                          title: (event.currentTarget as HTMLInputElement).value,
                        })
                      }
                    />
                    <Select
                      label="影片"
                      value={lesson.videoAssetId ?? ''}
                      options={videoOptions}
                      onChange={(value) => patchLesson(sectionIndex, lessonIndex, { videoAssetId: value || null })}
                    />
                    <label class="course-preview-toggle">
                      <input
                        type="checkbox"
                        checked={lesson.isPreview}
                        onChange={(event) =>
                          patchLesson(sectionIndex, lessonIndex, {
                            isPreview: (event.currentTarget as HTMLInputElement).checked,
                          })
                        }
                      />
                      {/* The one lesson property with a consequence outside the
                          editor: anybody may watch it without buying. */}
                      <span>試看</span>
                    </label>
                    {lesson.videoAssetId === null && <Badge tone="neutral">文字單元</Badge>}
                    <IconButton
                      label={`將「${nameOf(lesson)}」往上移`}
                      size="sm"
                      disabled={lessonIndex === 0}
                      onClick={() => moveLesson(sectionIndex, lessonIndex, lessonIndex - 1)}
                    >
                      ↑
                    </IconButton>
                    <IconButton
                      label={`將「${nameOf(lesson)}」往下移`}
                      size="sm"
                      disabled={lessonIndex === section.lessons.length - 1}
                      onClick={() => moveLesson(sectionIndex, lessonIndex, lessonIndex + 1)}
                    >
                      ↓
                    </IconButton>
                    <IconButton
                      label={`移除單元「${nameOf(lesson)}」`}
                      size="sm"
                      onClick={() =>
                        patchSection(sectionIndex, {
                          lessons: section.lessons.filter((_, at) => at !== lessonIndex),
                        })
                      }
                    >
                      ×
                    </IconButton>
                  </li>
                ))}
              </ul>

              <Button
                size="sm"
                aria-label={`在「${nameOf(section)}」新增單元`}
                onClick={() =>
                  patchSection(sectionIndex, {
                    lessons: [...section.lessons, emptyLesson(section.lessons.length)],
                  })
                }
              >
                新增單元
              </Button>
            </li>
          ))}
        </ol>
      )}

      <Button
        aria-label="新增章節"
        onClick={() => renumber([...sections, { id: null, title: '', position: sections.length, lessons: [] }])}
      >
        新增章節
      </Button>
    </>
  )
}
