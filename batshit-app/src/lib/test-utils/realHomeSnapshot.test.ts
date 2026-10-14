/**
 * BL-808: the sentinel of a suite that could write under the real home folder must fail only when
 * THIS suite's own names appear there, never because another process touched an unrelated file
 * during a full lane (a dev server's startup skill sync rewriting a `metadata.json` did exactly
 * that). `ownNamesUnder` is the check; the "real home" below is a temporary folder, so nothing
 * here touches the real `~/.batshit`.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ownNamesUnder } from './realHomeSnapshot'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-real-home-sentinel-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('ownNamesUnder (BL-808)', () => {
  it('reports a name the suite owns when it leaks into the real folder', async () => {
    await fs.mkdir(path.join(root, 'zc_notes'))
    expect(await ownNamesUnder(root, ['zc_notes', 'zc_other'])).toEqual(['zc_notes'])
  })

  it('stays empty while an unrelated entry appears and changes during the run', async () => {
    await fs.mkdir(path.join(root, 'codex_skills_abc'))
    const metadata = path.join(root, 'codex_skills_abc', 'metadata.json')
    await fs.writeFile(metadata, '{"synced":1}')
    expect(await ownNamesUnder(root, ['zc_notes'])).toEqual([])

    // A dev server's skill sync rewrites the file (new size, new modification time) and adds a folder.
    await fs.writeFile(metadata, '{"synced":2,"more":"text"}')
    await fs.utimes(metadata, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'))
    await fs.mkdir(path.join(root, 'codex_skills_new'))
    expect(await ownNamesUnder(root, ['zc_notes'])).toEqual([])
  })

  it('reports only the owned names when a leak sits next to unrelated entries', async () => {
    await fs.mkdir(path.join(root, 'codex_skills_abc'))
    await fs.mkdir(path.join(root, 'zc_notes'))
    expect(await ownNamesUnder(root, ['zc_notes', 'zc_other'])).toEqual(['zc_notes'])
  })

  it('reports a leaked plain file too, not only folders', async () => {
    await fs.writeFile(path.join(root, 'zc_notes'), 'stray')
    expect(await ownNamesUnder(root, ['zc_notes'])).toEqual(['zc_notes'])
  })

  it('treats a missing folder as empty', async () => {
    expect(await ownNamesUnder(path.join(root, 'not-there'), ['zc_notes'])).toEqual([])
  })
})
