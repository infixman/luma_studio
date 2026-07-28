import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

import { Button, type ButtonTone } from './Button'

/**
 * A dialog, and the confirmation prompt built on it.
 *
 * The back office asked seventeen questions through `confirm()`. That call
 * freezes the tab, looks like whatever the operating system feels like, and
 * can only carry one string — so every one of those prompts had to describe
 * what was about to be deleted inside a sentence, or not at all. A dialog can
 * show the thing itself, and can tell the destructive button apart from the
 * one that backs out.
 *
 * Focus is the part that has to be right: it moves into the dialog on open,
 * cannot leave it while it is up, and goes back to whatever opened it on
 * close. Without the last one, dismissing a dialog drops the keyboard user at
 * the top of the document.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  title: string
  open: boolean
  onClose: () => void
  /** The buttons along the bottom. */
  footer?: ComponentChildren
  children: ComponentChildren
  width?: 'sm' | 'md' | 'lg'
}

export function Modal({ title, open, onClose, footer, children, width = 'sm' }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    returnTo.current = document.activeElement as HTMLElement | null
    // The first control, or the panel itself when the dialog is only text.
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel.current)?.focus()

    // The page behind must not scroll under the dialog.
    const scroll = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = scroll
      returnTo.current?.focus()
    }
  }, [open])

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!

      // Wrap at both ends, so tab cannot walk out into the page behind.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  if (!open) return null

  return (
    <div class="ui-backdrop" onClick={onClose}>
      <div
        class={`ui-modal width-${width}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onKeyDown={onKeyDown}
        // The backdrop closes on click; the panel is not the backdrop.
        onClick={(event) => event.stopPropagation()}
      >
        <h2 class="ui-modal-title">{title}</h2>
        <div class="ui-modal-body">{children}</div>
        {footer && <div class="ui-modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

interface Question {
  title: string
  body: ComponentChildren
  confirmLabel: string
  tone: ButtonTone
  resolve: (answer: boolean) => void
}

export interface AskOptions {
  title: string
  /** What is about to happen — and to what. This is the part `confirm()` could not do well. */
  body: ComponentChildren
  confirmLabel?: string
  tone?: ButtonTone
}

/**
 * `const { ask, dialog } = useConfirm()` — call `await ask({...})` where a
 * `confirm()` used to be, and render `{dialog}` once in the page.
 *
 * It hands back a promise so the calling code keeps its shape: the line that
 * read `if (!confirm(...)) return` becomes `if (!(await ask(...))) return`
 * rather than being turned inside out into callbacks.
 */
export function useConfirm() {
  const [question, setQuestion] = useState<Question | null>(null)

  const ask = useCallback(
    (options: AskOptions) =>
      new Promise<boolean>((resolve) => {
        setQuestion({
          title: options.title,
          body: options.body,
          confirmLabel: options.confirmLabel ?? '確定',
          tone: options.tone ?? 'danger',
          resolve,
        })
      }),
    [],
  )

  const answer = useCallback(
    (value: boolean) => {
      question?.resolve(value)
      setQuestion(null)
    },
    [question],
  )

  const dialog = (
    <Modal
      title={question?.title ?? ''}
      open={question !== null}
      onClose={() => answer(false)}
      footer={
        <>
          <Button tone="ghost" onClick={() => answer(false)}>
            取消
          </Button>
          <Button tone={question?.tone ?? 'danger'} onClick={() => answer(true)}>
            {question?.confirmLabel ?? '確定'}
          </Button>
        </>
      }
    >
      {question?.body}
    </Modal>
  )

  return { ask, dialog }
}
