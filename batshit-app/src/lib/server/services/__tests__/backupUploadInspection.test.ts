// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  UPLOAD_PROBLEM_MESSAGE_PATHS,
  countUploadProblemFiles,
  describeUploadInspectionFailure,
  inspectUploadFiles,
  uploadFolderFoundNothing,
  uploadRecordFingerprint,
  type UploadInspectionTarget
} from '../backupUploadInspection'

// BL-378 / BL-1373: the one read-only upload inspection the export and the Admin check share.

let root: string

function target(relativePath: string, overrides: Partial<UploadInspectionTarget> = {}): UploadInspectionTarget {
  return {
    key: `upload:${relativePath.replace('/', ':')}`,
    relativePath,
    hasLegacyBase64: false,
    size: 3,
    uploadedAt: '2026-10-11T00:00:00.000Z',
    originalName: path.basename(relativePath),
    sha256: null,
    ...overrides
  }
}

async function inspect(targets: UploadInspectionTarget[], uploadRoot = root) {
  return inspectUploadFiles({
    uploadRoot,
    targets,
    resolvePath: (relativePath) => path.join(uploadRoot, relativePath)
  })
}

async function writeFile(relativePath: string, bytes = 'abc') {
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true })
  await fs.writeFile(path.join(root, relativePath), bytes)
}

/** Every entry under `dir` with its kind, size and modification time, for zero-write checks. */
async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as { code?: string }).code === 'EACCES') {
        out.push(`${path.relative(dir, current)} <unreadable>`)
        return
      }
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const stat = await fs.lstat(full)
      out.push(`${path.relative(dir, full)} ${entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file'} ${stat.size} ${stat.mtimeMs}`)
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(dir)
  return out
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bl378-inspection-'))
})

afterEach(async () => {
  await fs.chmod(path.join(root, 'locked'), 0o755).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
})

describe('inspectUploadFiles', () => {
  it('collects every problem in one pass instead of stopping at the first', async () => {
    await writeFile('images/present.png')
    const inspection = await inspect([
      target('images/gone-1.png'),
      target('images/present.png'),
      target('memory-media/agent_a/mem_b/gone-2.png'),
      target('goon_scenes/gone-3.jpg')
    ])

    expect(inspection.problems.map((problem) => [problem.relativePath, problem.kind, problem.code])).toEqual([
      ['images/gone-1.png', 'missing', null],
      ['memory-media/agent_a/mem_b/gone-2.png', 'missing', null],
      ['goon_scenes/gone-3.jpg', 'missing', null]
    ])
    expect(inspection.foundCount).toBe(1)
    expect(inspection.fileBackedCount).toBe(4)
    expect(inspection.found.map((entry) => entry.target.relativePath)).toEqual(['images/present.png'])

    const failure = describeUploadInspectionFailure(inspection)
    expect(failure?.status).toBe(409)
    expect(failure?.message).toContain('3 uploaded files cannot be backed up (3 missing; 1 of 4 found in')
    for (const name of ['images/gone-1.png', 'memory-media/agent_a/mem_b/gone-2.png', 'goon_scenes/gone-3.jpg']) {
      expect(failure?.message).toContain(name)
    }
    expect(failure?.details).toMatchObject({
      code: 'BACKUP_UPLOAD_FILES_UNAVAILABLE',
      problemCount: 3,
      problemFileCount: 3,
      counts: { missing: 3, unreadable: 0, notAFile: 0 },
      truncated: false
    })
    expect((failure?.details.problems as unknown[]).length).toBe(3)
    expect(failure?.message).not.toContain('None of the files were found')
  })

  it('points at the upload folder when not one file was found', async () => {
    const inspection = await inspect([target('images/a.png'), target('images/b.png')])
    const failure = describeUploadInspectionFailure(inspection)

    expect(failure?.status).toBe(409)
    expect(failure?.message).toContain('0 of 2 found')
    expect(failure?.message).toContain('None of the files were found: if the upload folder moved')
  })

  it.skipIf(process.getuid?.() === 0)('reports an unreadable file as unreadable with its code, never as missing (BL-1373)', async () => {
    await writeFile('locked/held.png')
    await fs.chmod(path.join(root, 'locked'), 0o000)

    const inspection = await inspect([target('locked/held.png'), target('images/gone.png')])

    expect(inspection.problems.map((problem) => [problem.relativePath, problem.kind, problem.code])).toEqual([
      ['locked/held.png', 'unreadable', 'EACCES'],
      ['images/gone.png', 'missing', null]
    ])
    const failure = describeUploadInspectionFailure(inspection)
    expect(failure?.status).toBe(500)
    expect(failure?.message).toContain('locked/held.png (unreadable: EACCES)')
    expect(failure?.message).toContain('1 missing, 1 unreadable')
    // Nothing was found, but this fixture's file exists behind a locked folder, so its path is
    // unreadable, not missing (stat cannot tell more): no "files not found" hint.
    expect(failure?.message).not.toContain('None of the files were found')
  })

  it('reports a link loop as unreadable (ELOOP), never as missing', async () => {
    await fs.mkdir(path.join(root, 'images'), { recursive: true })
    await fs.symlink('loop-b.png', path.join(root, 'images', 'loop-a.png'))
    await fs.symlink('loop-a.png', path.join(root, 'images', 'loop-b.png'))

    const inspection = await inspect([target('images/loop-a.png')])

    expect(inspection.problems).toMatchObject([{ kind: 'unreadable', code: 'ELOOP' }])
    expect(describeUploadInspectionFailure(inspection)?.status).toBe(500)
  })

  it('reports a folder where a file should be as not-a-file (409)', async () => {
    await fs.mkdir(path.join(root, 'images', 'folder.png'), { recursive: true })
    const inspection = await inspect([target('images/folder.png')])

    expect(inspection.problems).toMatchObject([{ kind: 'not-a-file', code: null }])
    const failure = describeUploadInspectionFailure(inspection)
    expect(failure?.status).toBe(409)
    expect(failure?.message).toContain('images/folder.png (not a file)')
  })

  it('reports an unsupported record as its own problem, without looking for its file (BL-1380)', async () => {
    // Its file is right there, and the folder check is not needed for it: neither matters,
    // because the backup cannot carry this record's file at all.
    await writeFile('avatars/string.png')
    const unsupported = target('avatars/string.png', { key: 'upload:avatars:string.png', unsupportedRecord: true })
    const absent = path.join(root, 'no-such-uploads')
    const alone = await inspect([unsupported], absent)
    expect(alone.rootProblem).toBeNull()
    // Never looked for, so it is neither found nor counted among the files looked for.
    expect(alone.foundCount).toBe(0)
    expect(alone.fileBackedCount).toBe(0)
    expect(alone.problems).toMatchObject([{ key: 'upload:avatars:string.png', relativePath: 'avatars/string.png', kind: 'unsupported-record', code: null }])

    const mixed = await inspect([unsupported, target('images/gone.png')])
    const failure = describeUploadInspectionFailure(mixed)
    expect(failure?.status).toBe(409)
    expect(failure?.message).toContain('2 uploaded files cannot be backed up (1 missing, 1 unsupported record; 0 of 1 found in')
    expect(failure?.message).toContain('avatars/string.png (unsupported record), images/gone.png.')
    // Not every problem is missing, so this is no wrong-folder case.
    expect(failure?.message).not.toContain('None of the files were found')
    expect(failure?.details).toMatchObject({ counts: { missing: 1, unreadable: 0, notAFile: 0, unsupportedRecord: 1 } })
  })

  // BL-1388 (rev 4 [C1]): one predicate, no legacy term, only while missing problems remain.
  it('asks one predicate for the folder sentence, and a legacy copy never hides it', async () => {
    const wrongFolderWithLegacy = await inspect([
      target('avatars/old.png', { hasLegacyBase64: true }),
      target('images/a.png'),
      target('images/a.png', { key: 'upload:images:alias:a.png' })
    ])
    expect(wrongFolderWithLegacy).toMatchObject({ foundCount: 0, legacyCopyCount: 1 })
    expect(uploadFolderFoundNothing(wrongFolderWithLegacy)).toBe(true)
    const failure = describeUploadInspectionFailure(wrongFolderWithLegacy)
    expect(failure?.message).toContain('1 uploaded file (2 upload records) cannot be backed up (2 missing; 0 of 3 found in')
    expect(failure?.message).toContain(
      ' None of the files were found (1 older upload is saved inside its record and does not need the folder): ' +
        'if the upload folder moved, or a drive or Docker volume is not connected, fix that first.'
    )

    const twoLegacy = await inspect([
      target('avatars/old-1.png', { hasLegacyBase64: true }),
      target('avatars/old-2.png', { hasLegacyBase64: true }),
      target('images/a.png')
    ])
    expect(describeUploadInspectionFailure(twoLegacy)?.message).toContain(
      ' None of the files were found (2 older uploads are saved inside their records and do not need the folder): '
    )

    // Something was found, a problem is not a missing file, or no missing problem remains: no.
    await writeFile('images/present.png')
    expect(uploadFolderFoundNothing(await inspect([target('images/present.png'), target('images/gone.png')]))).toBe(false)
    await fs.mkdir(path.join(root, 'images', 'dir.png'))
    expect(uploadFolderFoundNothing(await inspect([target('images/dir.png'), target('images/gone.png')]))).toBe(false)
    expect(uploadFolderFoundNothing(await inspect([
      target('images/gone.png'),
      target('avatars/string.png', { unsupportedRecord: true })
    ]))).toBe(false)
    const survivorsOnly = await inspect([target('avatars/old.png', { hasLegacyBase64: true })])
    expect(survivorsOnly).toMatchObject({ foundCount: 0, legacyCopyCount: 1, problems: [] })
    expect(uploadFolderFoundNothing(survivorsOnly)).toBe(false)
    const rootGone = await inspect([target('images/gone.png')], path.join(root, 'no-such-uploads'))
    expect(rootGone.rootProblem).not.toBeNull()
    expect(uploadFolderFoundNothing(rootGone)).toBe(false)
  })

  it('backs up an instance with no file-backed uploads without an uploads folder', async () => {
    const absent = path.join(root, 'no-such-uploads')
    const inspection = await inspect([], absent)

    expect(inspection.rootProblem).toBeNull()
    expect(describeUploadInspectionFailure(inspection)).toBeNull()
    await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks the folder only when a record needs a file from it', async () => {
    const absent = path.join(root, 'no-such-uploads')
    const legacyOnly = await inspect([target('images/legacy.png', { hasLegacyBase64: true })], absent)
    expect(legacyOnly.rootProblem).toBeNull()
    expect(legacyOnly.legacyCopyCount).toBe(1)
    expect(describeUploadInspectionFailure(legacyOnly)).toBeNull()

    // BL-378 Phase 1b: two records of one legacy path are two records and one file.
    const aliases = await inspect(
      [
        target('images/legacy.png', { hasLegacyBase64: true }),
        target('images/legacy.png', { key: 'upload:images:x:legacy.png', hasLegacyBase64: true }),
        target('images/other.png', { hasLegacyBase64: true })
      ],
      absent
    )
    expect(aliases).toMatchObject({ legacyCopyCount: 3, legacyCopyFileCount: 2 })

    const needsFile = await inspect([target('images/legacy.png', { hasLegacyBase64: true }), target('images/a.png')], absent)
    expect(needsFile.rootProblem).toEqual({ kind: 'root-missing', code: 'ENOENT' })
    expect(needsFile.problems).toEqual([])
    const failure = describeUploadInspectionFailure(needsFile)
    expect(failure?.status).toBe(500)
    expect(failure?.message).toContain(`upload folder ${absent} was not found`)
    expect(failure?.message).toContain('UPLOADS_DIR')
    expect(failure?.details).toMatchObject({ code: 'BACKUP_UPLOAD_ROOT_UNAVAILABLE', fileBackedCount: 2 })
  })

  it('refuses an upload folder that is a file', async () => {
    const notFolder = path.join(root, 'uploads-file')
    await fs.writeFile(notFolder, 'x')
    const inspection = await inspect([target('images/a.png')], notFolder)

    expect(inspection.rootProblem).toEqual({ kind: 'root-not-directory', code: null })
    expect(describeUploadInspectionFailure(inspection)?.message).toContain('is not a folder')
  })

  it('keeps the legacy Base64 fallback, but not for a folder in the file’s place', async () => {
    await fs.mkdir(path.join(root, 'images', 'dir.png'), { recursive: true })
    const inspection = await inspect([
      target('images/legacy-gone.png', { hasLegacyBase64: true }),
      target('images/dir.png', { hasLegacyBase64: true })
    ])

    expect(inspection.legacyCopyCount).toBe(1)
    expect(inspection.problems).toMatchObject([{ relativePath: 'images/dir.png', kind: 'not-a-file' }])
  })

  it('counts distinct files when two records name one file', async () => {
    const inspection = await inspect([
      target('avatars/agent_a_1.jpg', { key: 'upload:avatars:agent:agent_a_1.jpg' }),
      target('avatars/agent_a_1.jpg', { key: 'upload:avatars:agent_a_1.jpg' })
    ])

    expect(inspection.problems).toHaveLength(2)
    expect(countUploadProblemFiles(inspection.problems)).toBe(1)
    const failure = describeUploadInspectionFailure(inspection)
    expect(failure?.message).toContain('1 uploaded file (2 upload records) cannot be backed up')
    expect(failure?.details).toMatchObject({ problemCount: 2, problemFileCount: 1 })
  })

  it('keeps the sentence bounded and says honestly when the list is cut', async () => {
    const targets = Array.from({ length: 8 }, (_, index) => target(`images/gone-${index}.png`))
    const inspection = await inspect(targets)
    const failure = describeUploadInspectionFailure(inspection, { listLimit: 3 })

    const named = targets.slice(0, UPLOAD_PROBLEM_MESSAGE_PATHS).map((entry) => entry.relativePath)
    for (const name of named) expect(failure?.message).toContain(name)
    expect(failure?.message).not.toContain('images/gone-5.png')
    expect(failure?.message).toContain(', and 3 more.')
    expect(failure?.message).toContain('That list shows the first 3 of 8.')
    expect(failure?.details).toMatchObject({ problemCount: 8, truncated: true, listLimit: 3 })
    expect((failure?.details.problems as unknown[]).length).toBe(3)
  })

  it('writes nothing to the upload folder', async () => {
    await writeFile('images/present.png')
    await fs.mkdir(path.join(root, 'images', 'dir.png'))
    const before = await snapshotTree(root)

    const inspection = await inspect([target('images/present.png'), target('images/gone.png'), target('images/dir.png')])
    describeUploadInspectionFailure(inspection)

    expect(await snapshotTree(root)).toEqual(before)
  })
})

describe('uploadRecordFingerprint', () => {
  it('ignores key order and changes with any value change', () => {
    const base = uploadRecordFingerprint('upload:images:a.png', { size: 3, storage: 'filesystem', relativePath: 'images/a.png' })
    expect(uploadRecordFingerprint('upload:images:a.png', { relativePath: 'images/a.png', storage: 'filesystem', size: 3 })).toBe(base)
    expect(uploadRecordFingerprint('upload:images:a.png', { relativePath: 'images/a.png', storage: 'filesystem', size: 4 })).not.toBe(base)
    expect(uploadRecordFingerprint('upload:images:b.png', { size: 3, storage: 'filesystem', relativePath: 'images/a.png' })).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
})
