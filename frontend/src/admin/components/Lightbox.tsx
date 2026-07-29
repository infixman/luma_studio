import { useEffect } from 'preact/hooks'

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div class="lightbox-backdrop" onClick={onClose}>
      <img
        src={src}
        alt={alt}
        class="lightbox-image"
        onClick={(e) => e.stopPropagation()}
      />
      <button type="button" class="lightbox-close" onClick={onClose} aria-label="關閉">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  )
}
