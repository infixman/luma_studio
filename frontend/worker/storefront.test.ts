import { describe, expect, it } from 'vitest'

import { escapeHtml, isLinkPreviewer, oneLine, pageTitle } from './storefront'

describe('escapeHtml', () => {
  it('neutralises the characters that would break out of an attribute', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
    expect(escapeHtml('"><script>alert(1)</script>')).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes the ampersand first so entities are not double-broken', () => {
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('苒光繪誌｜台中・桃園')).toBe('苒光繪誌｜台中・桃園')
  })
})

describe('oneLine', () => {
  it('collapses the line breaks a preview card cannot show', () => {
    expect(oneLine('台中開課\n兒童美術\n\n成人肌理畫')).toBe('台中開課 兒童美術 成人肌理畫')
  })

  it('trims the ends', () => {
    expect(oneLine('  hello  ')).toBe('hello')
  })

  it('truncates with an ellipsis past the limit', () => {
    const result = oneLine('a'.repeat(200))
    expect(result).toHaveLength(160)
    expect(result.endsWith('…')).toBe(true)
  })

  it('leaves text at exactly the limit alone', () => {
    expect(oneLine('a'.repeat(160))).toBe('a'.repeat(160))
  })
})

describe('pageTitle', () => {
  it('appends the studio name', () => {
    expect(pageTitle('喬喬老師')).toBe('喬喬老師 | 苒光繪誌')
  })

  it('does not repeat a studio name the display name already carries', () => {
    expect(pageTitle('苒光繪誌｜喬喬老師')).toBe('苒光繪誌｜喬喬老師')
  })

  it('falls back to the studio name when nothing is set', () => {
    expect(pageTitle('')).toBe('苒光繪誌')
  })
})

describe('isLinkPreviewer', () => {
  // Real user agents. A false negative here costs a preview card on a shared
  // link, which is the whole reason this Worker exists.
  const crawlers = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Twitterbot/1.0',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1)',
    'Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)',
    'Pinterest/0.2 (+https://www.pinterest.com/bot.html)',
    'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)',
  ]

  it.each(crawlers)('waits for the profile: %s', (agent) => {
    expect(isLinkPreviewer(agent)).toBe(true)
  })

  // People. Matching one of these means every visitor pays for a round trip
  // to the API before the page starts rendering.
  const people = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    // Instagram's and LINE's in-app browsers, which is where most of this
    // page's visitors arrive from.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 336.0.0.35.90',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.10.0',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.32.108;]',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  ]

  it.each(people)('does not make a person wait: %s', (agent) => {
    expect(isLinkPreviewer(agent)).toBe(false)
  })

  it('treats a missing user agent as a person', () => {
    expect(isLinkPreviewer('')).toBe(false)
  })
})
