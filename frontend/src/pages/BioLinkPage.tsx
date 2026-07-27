import { useEffect, useState } from 'preact/hooks'

import { BioLinkCalendar } from '../components/BioLinkCalendar'
import { SocialIcon, platformLabel } from '../components/SocialIcon'
import { api, apiUrl, bioLinkRedirectUrl } from '../lib/api'
import type { PublicBioLink } from '../lib/types'
import '../styles/bio-link.css'

export function BioLinkPage() {
  const [page, setPage] = useState<PublicBioLink | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<PublicBioLink>('/api/bio-link')
      .then((data) => {
        if (cancelled) return
        setPage(data)
        if (data.displayName) document.title = data.displayName
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '無法載入這個頁面')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The chosen appearance lives on the body so the page background follows it
  // too, not just the content column.
  useEffect(() => {
    const style = page?.style
    if (!style) return undefined
    const { body } = document
    body.dataset.theme = style.theme
    body.dataset.shape = style.buttonShape
    body.dataset.font = style.fontStyle
    return () => {
      delete body.dataset.theme
      delete body.dataset.shape
      delete body.dataset.font
    }
  }, [page?.style])

  if (error !== null) {
    return (
      <main class="bio bio-notice">
        <p class="bio-notice-title">無法載入這個頁面</p>
        <p class="bio-notice-detail">{error}</p>
      </main>
    )
  }

  if (page === null) {
    return (
      <main class="bio bio-notice" aria-live="polite">
        <p class="bio-notice-detail">載入中…</p>
      </main>
    )
  }

  // The studio logo stands in until an avatar is uploaded, so the page is
  // never headless on the day it goes live.
  const avatar = page.avatarPath ? apiUrl(page.avatarPath) : '/assets/luma-studio-logo.png'
  const hasNothing = page.links.length === 0 && page.socials.length === 0

  return (
    <main class="bio">
      <header class="bio-header">
        <img class={page.avatarPath ? 'bio-avatar' : 'bio-avatar bio-avatar-logo'} src={avatar} alt={page.displayName || '苒光繪誌'} />
        {page.displayName && <h1 class="bio-name">{page.displayName}</h1>}
        {page.bio && <p class="bio-text">{page.bio}</p>}
      </header>

      {page.socials.length > 0 && (
        <nav class="bio-socials" aria-label="社群連結">
          {page.socials.map((item) => {
            const label = item.title || platformLabel(item.platform)
            return (
              <a
                key={item.id}
                class="bio-social"
                href={bioLinkRedirectUrl(item.id)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                title={label}
              >
                <SocialIcon platform={item.platform} />
              </a>
            )
          })}
        </nav>
      )}

      {page.links.length > 0 && (
        <ul class="bio-links">
          {page.links.map((item) => (
            <li key={item.id}>
              <a class="bio-link" href={bioLinkRedirectUrl(item.id)} target="_blank" rel="noopener noreferrer">
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      )}

      {page.calendar && <BioLinkCalendar calendar={page.calendar} />}

      {hasNothing && !page.calendar && <p class="bio-notice-detail">這個頁面還沒有連結。</p>}

      <footer class="bio-footer">
        <a href="/">苒光繪誌</a>
      </footer>
    </main>
  )
}
