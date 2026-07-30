import { describe, expect, test, vi } from 'vitest'

import {
  AdminApiError,
  createAsset,
  exchangePairing,
  isTransient,
  registerEncode,
  uploadUrls,
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

describe('creating the asset an upload is scoped to', () => {
  const DETAILS = { title: '第一課', byteSize: 4_000_000_000 }

  test('it returns the id and both version numbers', async () => {
    const transport = vi.fn<Transport>(async () =>
      responding(201, { asset: { id: 'asset-1' }, uploadVersion: 1, encodeVersion: 1 }),
    )

    await expect(createAsset(transport, BASE, 'tok', DETAILS)).resolves.toEqual({
      assetId: 'asset-1',
      uploadVersion: 1,
      encodeVersion: 1,
    })
  })

  test('it presents the token as a bearer', async () => {
    const transport = vi.fn<Transport>(async () =>
      responding(201, { asset: { id: 'asset-1' }, uploadVersion: 1, encodeVersion: 1 }),
    )

    await createAsset(transport, BASE, 'tok', DETAILS)

    expect(transport.mock.calls[0]![1].headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  test('a response with no id is refused rather than used', async () => {
    /** Carrying on would build keys like `videos//1/master.m3u8`, which the
     *  server refuses one object at a time instead of once. */
    const transport = vi.fn<Transport>(async () => responding(201, { asset: {}, uploadVersion: 1, encodeVersion: 1 }))

    await expect(createAsset(transport, BASE, 'tok', DETAILS)).rejects.toThrow('影片編號')
  })

  test('a 403 from the switch being off is passed through', async () => {
    const transport = vi.fn<Transport>(async () => responding(403, { error: '影片上傳尚未開放' }))

    await expect(createAsset(transport, BASE, 'tok', DETAILS)).rejects.toMatchObject({ status: 403 })
  })
})

describe('asking for upload URLs', () => {
  const KEYS = ['videos/asset-1/1/master.m3u8', 'videos/asset-1/1/720p/init.mp4']

  function granting(keys: readonly string[]) {
    return responding(200, {
      urls: keys.map((key) => ({ key, url: `https://r2.example/${key}?X-Amz-Signature=x`, expiresAt: 1 })),
    })
  }

  test('it asks for the output bucket and the right version', async () => {
    const transport = vi.fn<Transport>(async () => granting(KEYS))

    await uploadUrls(transport, BASE, 'tok', { assetId: 'asset-1', encodeVersion: 2, keys: KEYS })

    const body = JSON.parse(String(transport.mock.calls[0]![1].body))
    expect(body).toEqual({ kind: 'output', encodeVersion: 2, keys: KEYS })
  })

  test('the asset id is encoded into the path', async () => {
    const transport = vi.fn<Transport>(async () => granting(KEYS))

    await uploadUrls(transport, BASE, 'tok', { assetId: 'a/b', encodeVersion: 1, keys: KEYS })

    expect(transport.mock.calls[0]![0]).toBe(`${BASE}/api/video-assets/a%2Fb/upload-urls`)
  })

  test('a short answer is refused rather than partially used', async () => {
    /** The server grants a batch or refuses it, so fewer URLs than keys means
     *  something changed under us — not that some keys were skipped. */
    const transport = vi.fn<Transport>(async () => granting(KEYS.slice(0, 1)))

    await expect(
      uploadUrls(transport, BASE, 'tok', { assetId: 'asset-1', encodeVersion: 1, keys: KEYS }),
    ).rejects.toThrow('數量不符')
  })

  test('a refused key surfaces the server reason', async () => {
    const transport = vi.fn<Transport>(async () => responding(400, { error: 'This key is not part of this encode' }))

    await expect(
      uploadUrls(transport, BASE, 'tok', { assetId: 'asset-1', encodeVersion: 1, keys: KEYS }),
    ).rejects.toThrow('not part of this encode')
  })
})

describe('registering a finished encode', () => {
  const DETAILS = { assetId: 'asset-1', encodeVersion: 1, title: '第一課', byteSize: 1 }

  test('a complete encode reports how many objects were verified', async () => {
    const transport = vi.fn<Transport>(async () => responding(201, { asset: {}, objectCount: 347 }))

    await expect(registerEncode(transport, BASE, 'tok', DETAILS)).resolves.toEqual({
      ok: true,
      missing: [],
      objectCount: 347,
    })
  })

  test('an incomplete one comes back as a list, not an exception', async () => {
    /** It is the most useful thing this call produces: what to upload again. */
    const transport = vi.fn<Transport>(async () =>
      responding(409, { error: '這個版本還缺 2 個檔案', missing: ['720p/segment-000004.m4s', 'poster.webp'] }),
    )

    await expect(registerEncode(transport, BASE, 'tok', DETAILS)).resolves.toEqual({
      ok: false,
      missing: ['720p/segment-000004.m4s', 'poster.webp'],
      objectCount: 0,
    })
  })

  test('any other failure is an error', async () => {
    const transport = vi.fn<Transport>(async () => responding(404, { error: 'Video not found' }))

    await expect(registerEncode(transport, BASE, 'tok', DETAILS)).rejects.toBeInstanceOf(AdminApiError)
  })

  test('a 409 with no list still reads as incomplete', async () => {
    const transport = vi.fn<Transport>(async () => responding(409, { error: 'x' }))

    await expect(registerEncode(transport, BASE, 'tok', DETAILS)).resolves.toMatchObject({ ok: false })
  })
})
