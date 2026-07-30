/**
 * Turning system errors into sentences.
 *
 * The one that prompted this: dropping a PNG on the tool produced
 * `Error invoking remote method 'upload:scan': Error: ENOTDIR: not a directory,
 * scandir 'C:\...\car_h64.png'`, which names the syscall, the wrapper it came
 * through and the errno, and does not say the one thing that mattered — that a
 * PNG is not something this tool can upload.
 *
 * These are tested rather than eyeballed because the whole point is the wording,
 * and wording is what gets quietly reverted by a refactor that only reads code.
 */

import { expect, test } from 'vitest'

import { explain } from './failures'

function nodeError(code: string, message: string): Error {
  const error = new Error(message)
  Object.assign(error, { code })
  return error
}

const PNG = 'C:\\Users\\enzoz\\OneDrive\\Desktop\\car_h64.png'

test('a file dropped where a folder was expected says so, and says what to drop', () => {
  const said = explain(nodeError('ENOTDIR', `ENOTDIR: not a directory, scandir '${PNG}'`), {
    path: PNG,
  })

  expect(said).toContain('car_h64.png')
  expect(said).toContain('資料夾')
  expect(said).toContain('.mp4')
  expect(said).not.toContain('ENOTDIR')
  expect(said).not.toContain('scandir')
})

test('it names the file rather than the whole path', () => {
  /** The full path is most of a sentence on its own and the last part is the
   *  part somebody recognises. */
  const said = explain(nodeError('ENOTDIR', 'ENOTDIR: not a directory'), { path: PNG })

  expect(said).not.toContain('OneDrive')
})

test('something that is not there says that, not ENOENT', () => {
  const said = explain(nodeError('ENOENT', "ENOENT: no such file or directory, stat 'x'"), {
    path: 'D:\\encode\\output',
  })

  expect(said).toContain('output')
  expect(said).toContain('找不到')
  expect(said).not.toContain('ENOENT')
})

test('a permission refusal says permission', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const said = explain(nodeError(code, `${code}: permission denied`), { path: 'D:\\x' })

    expect(said).toContain('權限')
    expect(said).not.toContain(code)
  }
})

test('a file in use says which file and that something else has it', () => {
  const said = explain(nodeError('EBUSY', 'EBUSY: resource busy or locked'), {
    path: 'D:\\a\\video.mp4',
  })

  expect(said).toContain('video.mp4')
  expect(said).toContain('其他程式')
})

test('a full disk says the disk is full', () => {
  const said = explain(nodeError('ENOSPC', 'ENOSPC: no space left on device'), { path: 'D:\\x' })

  expect(said).toContain('空間')
})

test('an error with no code keeps its own message rather than being flattened', () => {
  /** Everything this tool raises deliberately — 「已取消」, a server's refusal —
   *  arrives here too, and rewriting those as a generic failure would lose the
   *  only sentence anybody wrote on purpose. */
  expect(explain(new Error('這台機器沒有 FFmpeg'), {})).toBe('這台機器沒有 FFmpeg')
})

test('and something that is not an Error at all still produces a sentence', () => {
  expect(explain('nope', {})).toBeTruthy()
  expect(explain(undefined, {})).toBeTruthy()
})

test('an unrecognised code keeps the original text, so it stays diagnosable', () => {
  /** Hiding it would trade one unreadable message for an unreadable message
   *  with nothing to search for. */
  const said = explain(nodeError('EIO', 'EIO: i/o error, read'), { path: 'D:\\x' })

  expect(said).toContain('EIO')
})
