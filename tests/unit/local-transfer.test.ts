/**
 * The local SFTP stand-in must accept ssh2's (src, dest, options, callback)
 * form. It used to treat the options object as the callback, so imports on a
 * single-host install copied the archive and then waited forever.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { localTransfer } from '../../src/lib/vps/local-exec'

const dir = mkdtempSync(path.join(tmpdir(), 'local-transfer-'))
const src = path.join(dir, 'src.bin')
writeFileSync(src, Buffer.alloc(4096, 1))

const run = (dest: string, ...rest: unknown[]) =>
  new Promise<{ err?: Error | null; steps: number[] }>((resolve) => {
    const steps: number[] = []
    if (rest.length === 0) {
      localTransfer(src, dest, (err) => resolve({ err, steps }))
    } else {
      localTransfer(src, dest, { step: (t: number) => steps.push(t) }, (err) => resolve({ err, steps }))
    }
  })

describe('localTransfer', () => {
  test('callback-only form completes', async () => {
    const dest = path.join(dir, 'a.bin')
    const r = await run(dest)
    expect(r.err).toBeFalsy()
    expect(readFileSync(dest).length).toBe(4096)
  })

  test('options + callback form completes and reports progress', async () => {
    const dest = path.join(dir, 'b.bin')
    const r = await run(dest, 'opts')
    expect(r.err).toBeFalsy()
    expect(r.steps).toEqual([4096])
  })

  test('a failed copy reaches the callback as an error', async () => {
    const r = await new Promise<Error | null | undefined>((resolve) =>
      localTransfer(path.join(dir, 'missing.bin'), path.join(dir, 'c.bin'), {}, (err) => resolve(err))
    )
    expect(r).toBeInstanceOf(Error)
  })
})
