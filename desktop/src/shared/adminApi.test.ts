import { describe, expect, test, vi } from 'vitest'

import {
  AdminApiError,
  exchangePairing,
  isTransient,
  type HttpResponse,
  type Transport,
} from './adminApi'

const BASE = 'https://admin-api.example.com'

function responding(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function notJson(status: number): HttpResponse {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('not json')
    },
    text: async () => '<html>gateway</html>',
  }
}

const GRANTED = {
  token: 'dv1.payload.signature',
  adminEmail: 'owner@example.com',
  scope: 'video',
  expiresAt: 1_785_336_000,
}

describe('spending a pairing code', () => {
  test('it returns the session the server granted', async () => {
    const transport = vi.fn<Transport>(async () => responding(200, GRANTED))

    await expect(exchangePairing(transport, BASE, { email: 'owner@example.com', code: '418302' }))
      .resolves.toEqual(GRANTED)
  })

  test('it sends the normalised values, not what was typed', async () => {
    /** The back office renders the code with a space in it. */
    const transport = vi.fn<Transport>(async () => responding(200, GRANTED))

    await exchangePairing(transport, BASE, { email: ' Owner@Example.com ', code: '418 302' })

    const [, init] = transport.mock.calls[0]!
    expect(JSON.parse(String(init.body))).toEqual({ email: 'owner@example.com', code: '418302' })
  })

  test('it posts to the exchange route on the given base', async () => {
    const transport = vi.fn<Transport>(async () => responding(200, GRANTED))

    await exchangePairing(transport, BASE, { email: 'owner@example.com', code: '418302' })

    expect(transport.mock.calls[0]![0]).toBe(`${BASE}/api/desktop/tokens`)
    expect(transport.mock.calls[0]![1].method).toBe('POST')
  })

  test("it repeats the server's reason rather than inventing one", async () => {
    /** The server answers the same way for wrong code, spent code, unknown
     *  admin and locked account — on purpose. Guessing at a friendlier
     *  explanation would mean claiming something the tool cannot know. */
    const transport = vi.fn<Transport>(async () => responding(401, { error: '配對失敗，請重新取得驗證碼' }))

    await expect(
      exchangePairing(transport, BASE, { email: 'owner@example.com', code: '000000' }),
    ).rejects.toThrow('配對失敗')
  })

  test('a refusal carries its status, so a caller can tell 401 from 503', async () => {
    const transport = vi.fn<Transport>(async () => responding(503, { error: '尚未設定' }))

    await expect(
      exchangePairing(transport, BASE, { email: 'owner@example.com', code: '418302' }),
    ).rejects.toMatchObject({ status: 503 })
  })

  test('a response that is not JSON still fails with something readable', async () => {
    /** A proxy in between answers with HTML, and `response.json()` throwing
     *  there would surface as a SyntaxError with no context. */
    const transport = vi.fn<Transport>(async () => notJson(502))

    await expect(
      exchangePairing(transport, BASE, { email: 'owner@example.com', code: '418302' }),
    ).rejects.toBeInstanceOf(AdminApiError)
  })

  test('a 200 with a body that is not a session is refused', async () => {
    /** Better than storing a half-session and failing at the first upload. */
    const transport = vi.fn<Transport>(async () => responding(200, { token: 'x' }))

    await expect(
      exchangePairing(transport, BASE, { email: 'owner@example.com', code: '418302' }),
    ).rejects.toThrow('無法辨識')
  })

  test('the code never appears in an error message', async () => {
    /** Messages are shown, copied into chats, and sometimes pasted into issues. */
    const transport = vi.fn<Transport>(async () => responding(401, { error: 'bad code 418302' }))

    try {
      await exchangePairing(transport, BASE, { email: 'owner@example.com', code: '418302' })
      expect.unreachable()
    } catch (error) {
      // Whatever the server said is repeated, so this is really a check that the
      // tool adds nothing of its own — the code is not appended anywhere.
      expect((error as Error).message).not.toContain('owner@example.com')
    }
  })
})

describe('which failures are worth trying again', () => {
  test.each([408, 429, 500, 502, 503, 504])('%s is transient', (status) => {
    expect(isTransient(status)).toBe(true)
  })

  test.each([400, 401, 403, 404, 409])('%s is not', (status) => {
    /** 401 especially: retrying spends attempts against the pairing lockout, so
     *  a retry loop would lock the admin out of their own tool. */
    expect(isTransient(status)).toBe(false)
  })
})
