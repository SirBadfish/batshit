/**
 * BL-373 / BL-369: a backup carries the files that live outside Redis and the upload store: a
 * user skill's folder (`~/.batshit/skills/{id}/`, the only copy of its text) and a clone voice's
 * reference recording (`~/.batshit/voice-profiles/{id}/`).
 *
 * SAFETY: the skill and voice roots come from `os.homedir()` (the skill root when its module
 * loads), so `node:os` answers a temporary home through both import styles before any module
 * under test loads, and a last test checks that the REAL home's two folders contain none of
 * this suite's own skill/voice names (never the whole tree - another process's unrelated write
 * under the real home, such as a dev server's skill sync touching a codex_skills metadata file,
 * is not this suite's business and must not fail its sentinel)
 * (memory note: tests that save skills write to the real home).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { unzipSync, zipSync } from 'fflate/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const nodePath = await import('node:path')
  if (!testHome.current) {
    testHome.current = nodePath.join(real.tmpdir(), `batshit-backup-host-home-${process.pid}-${Date.now()}`)
  }
  const homedir = () => testHome.current
  return { ...real, homedir, default: { ...real, homedir } }
})

import os from 'node:os'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  createBackupBundle,
  createBackupBundleStream,
  preflightBackupRestore,
  preflightStagedBackupRestore,
  restoreBackupBundle
} from '../backupRestoreService'

useRedisTestServer()

const SKILLS = () => path.join(testHome.current, '.batshit', 'skills')
const VOICES = () => path.join(testHome.current, '.batshit', 'voice-profiles')
const MIB = 1024 * 1024

/**
 * Every skill folder id and voice profile id this suite ever seeds, writes directly, or names in
 * a rebuilt archive — the sentinel below checks the REAL home for exactly these names, and only
 * these. A name not in this list is not this suite's business; add it here when a new fixture
 * needs one, rather than widening the sentinel to watch the whole tree.
 */
const OWN_SKILL_NAMES = [
  'zc_notes', 'ZC_Notes', 'batshit_guide', 'zc_other_lane', 'zc_a', 'zc_b', 'zc_gone',
  'zc_linked_file', 'zc_linked_folder', 'zc_locked', 'zc_keyed', 'zc_other_id',
  'zc_big_file', 'zc_many_files', 'zc_intruder', 'zc_swapped', 'zc_many'
]
const OWN_VOICE_NAMES = ['voice_zc_1', 'voice_zc_silent', 'voice_zc_2']

let uploadRoot = ''
let stagingRoot = ''
let realHomeRoots: Array<{ root: string; names: string[] }> = []

async function listDir(dir: string) {
  return (await fs.readdir(dir).catch(() => [] as string[])).sort()
}

beforeAll(async () => {
  const realOs = await vi.importActual<typeof import('node:os')>('node:os')
  realHomeRoots = [
    { root: path.join(realOs.homedir(), '.batshit', 'skills'), names: OWN_SKILL_NAMES },
    { root: path.join(realOs.homedir(), '.batshit', 'voice-profiles'), names: OWN_VOICE_NAMES }
  ]
  expect(os.homedir()).toBe(testHome.current)
  expect(testHome.current.startsWith(realOs.tmpdir())).toBe(true)
})

afterAll(async () => {
  await fs.rm(testHome.current, { recursive: true, force: true })
})

beforeEach(async () => {
  // `systemSlashCommands.resolveUserSkillDir` reads `process.env.HOME`, not `os.homedir()`.
  vi.stubEnv('HOME', testHome.current)
  vi.stubEnv('BATSHIT_TOKEN', 'backup-host-files-test-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/api\/upload\/asset-maintenance\/(begin|end)$/)
    const { token } = JSON.parse(String(init.body))
    return Response.json({ success: true, token, state: url.endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
  }))
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-host-files-uploads-'))
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-host-files-staging-'))
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', stagingRoot)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  await fs.rm(path.join(testHome.current, '.batshit'), { recursive: true, force: true })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.rm(uploadRoot, { recursive: true, force: true })
  await fs.rm(stagingRoot, { recursive: true, force: true })
})

async function writeFiles(dir: string, files: Record<string, string | Buffer>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

async function seedSkill(userId: string, id: string, files: Record<string, string> | null, extra: Record<string, unknown> = {}) {
  const dir = path.join(SKILLS(), id)
  if (files) await writeFiles(dir, files)
  await redis.json.set(`skill:${userId}:${id}`, '$', {
    id,
    user_id: userId,
    name: id,
    displayName: `Skill ${id}`,
    skill_markdown: '',
    bundle_files: [],
    cache_path: path.join(dir, 'SKILL.md'),
    source: 'custom',
    is_system: false,
    ...extra
  })
}

async function seedCloneVoice(userId: string, id: string, recording: string | null) {
  const audioPath = path.join(VOICES(), id, 'reference.wav')
  if (recording !== null) await writeFiles(path.dirname(audioPath), { 'reference.wav': recording })
  await redis.sAdd(`user:${userId}:voice_profiles`, id)
  await redis.json.set(`voice_profile:${id}`, '$', {
    id,
    user_id: userId,
    name: `Voice ${id}`,
    provider: 'byo_mlx',
    voiceId: id,
    isClone: true,
    settings: {
      providerOptions: { byo_mlx: { ref_audio: audioPath, ref_text: 'hello there' } },
      batshitManagedReferenceAudioPath: audioPath,
      cloneMethod: 'reference-audio'
    },
    created_at: '2026-09-27T00:00:00.000Z',
    updated_at: '2026-09-27T00:00:00.000Z'
  })
  return audioPath
}

function entriesOf(bytes: Uint8Array) {
  return unzipSync(bytes)
}

function manifestOf(bytes: Uint8Array) {
  return JSON.parse(Buffer.from(entriesOf(bytes)['manifest.json']).toString('utf8'))
}

/** Rewrite an archive: edit records, add or drop entries, and keep the manifest counts true. */
function rebuild(
  bytes: Uint8Array,
  edit: {
    record?: (record: any) => any
    drop?: (name: string) => boolean
    add?: Record<string, string>
    manifest?: (manifest: any) => void
  }
) {
  const entries: Record<string, Uint8Array> = { ...entriesOf(bytes) }
  for (const name of Object.keys(entries)) {
    if (edit.drop?.(name)) {
      delete entries[name]
      continue
    }
    if (edit.record && name.startsWith('redis/records/')) {
      const record = JSON.parse(Buffer.from(entries[name]).toString('utf8'))
      entries[name] = new Uint8Array(Buffer.from(JSON.stringify(edit.record(record)), 'utf8'))
    }
  }
  for (const [name, content] of Object.entries(edit.add ?? {})) entries[name] = new Uint8Array(Buffer.from(content))
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  const hostNames = Object.keys(entries).filter((name) => name.startsWith('files/host/'))
  manifest.contents.hostFileCount = hostNames.length
  manifest.contents.hostFileBytes = hostNames.reduce((sum, name) => sum + entries[name].byteLength, 0)
  edit.manifest?.(manifest)
  entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest), 'utf8'))
  return zipSync(entries)
}

async function stage(bytes: Uint8Array, userId: string) {
  const stageId = '11111111-2222-4333-8444-5555555555aa'
  const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
  const archivePath = path.join(stagingRoot, `${storageKey}.zip`)
  await fs.writeFile(archivePath, bytes)
  await fs.writeFile(
    path.join(stagingRoot, `${storageKey}.json`),
    `${JSON.stringify({
      contract: 'batshit-backup-stage/v1',
      stageId,
      userId,
      filename: 'batshit-backup.zip',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      stagedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      archivePath
    })}\n`
  )
  return stageId
}

describe('host files in the backup (BL-373, BL-369)', () => {
  it("carries a user skill's folder and a clone voice's recording, never a built-in skill", async () => {
    await seedSkill('source', 'zc_notes', {
      'SKILL.md': '---\nname: zc-notes\n---\n# Notes\n',
      'scripts/run.sh': 'echo notes\n',
      'references/guide.md': '# Guide\n'
    })
    await seedSkill('source', 'batshit_guide', null, { is_system: true, source: 'system' })
    await seedCloneVoice('source', 'voice_zc_1', 'RIFF-wav-bytes')

    const bundle = await createBackupBundle('source')
    const names = Object.keys(entriesOf(bundle.bytes)).filter((name) => name.startsWith('files/host/')).sort()
    expect(names).toEqual([
      'files/host/skills/zc_notes/SKILL.md',
      'files/host/skills/zc_notes/references/guide.md',
      'files/host/skills/zc_notes/scripts/run.sh',
      'files/host/voice-profiles/voice_zc_1/reference.wav'
    ])
    expect(bundle.manifest.contents.hostFileCount).toBe(4)
    expect(bundle.manifest.hostFiles?.notCarried).toEqual([])
    expect(bundle.manifest.hostFiles?.limits).toEqual({ maxFileBytes: 100 * MIB, maxFolderBytes: 500 * MIB, maxFolderFiles: 2000 })
    const groups = Object.fromEntries(bundle.manifest.contents.groups.map((group) => [group.id, group.fileAssetCount]))
    expect(groups.tools).toBe(3)
    expect(groups.voice).toBe(1)
  })

  it('restores them onto a computer that has neither, at the paths of THIS computer', async () => {
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n', 'scripts/run.sh': 'echo notes\n' })
    await seedCloneVoice('source', 'voice_zc_1', 'RIFF-wav-bytes')
    const exported = await createBackupBundle('source')
    // As another computer would have written it: its own home in every stored path.
    const elsewhere = '/Users/someone-else/.batshit'
    const bytes = rebuild(exported.bytes, {
      record: (record) => {
        if (record.key === 'skill:source:zc_notes') record.value.cache_path = `${elsewhere}/skills/zc_notes/SKILL.md`
        if (record.key === 'voice_profile:voice_zc_1') {
          const old = `${elsewhere}/voice-profiles/voice_zc_1/reference.wav`
          record.value.settings.batshitManagedReferenceAudioPath = old
          record.value.settings.providerOptions.byo_mlx.ref_audio = old
        }
        return record
      }
    })
    await fs.rm(path.join(testHome.current, '.batshit'), { recursive: true, force: true })

    const preflight = await preflightStagedBackupRestore('target', await stage(bytes, 'target'))
    expect(preflight.hostFileCount).toBe(3)
    const result = await restoreBackupBundle('target', bytes, { confirmReplace: true })
    expect(result.hostFileCount).toBe(3)

    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe('# Notes\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'scripts', 'run.sh'), 'utf8')).toBe('echo notes\n')
    const audioPath = path.join(VOICES(), 'voice_zc_1', 'reference.wav')
    expect(await fs.readFile(audioPath, 'utf8')).toBe('RIFF-wav-bytes')

    const skill = (await redis.json.get('skill:target:zc_notes')) as Record<string, any>
    expect(skill.cache_path).toBe(path.join(SKILLS(), 'zc_notes', 'SKILL.md'))
    const voice = (await redis.json.get('voice_profile:voice_zc_1')) as Record<string, any>
    expect(voice.settings.batshitManagedReferenceAudioPath).toBe(audioPath)
    expect(voice.settings.providerOptions.byo_mlx.ref_audio).toBe(audioPath)
    expect(voice.settings.providerOptions.byo_mlx.ref_text).toBe('hello there')
    // No transaction folders are left beside the roots.
    expect((await listDir(SKILLS())).filter((name) => name.startsWith('.restore-'))).toEqual([])
    expect((await listDir(VOICES())).filter((name) => name.startsWith('.restore-'))).toEqual([])
  })

  it('replaces only the folders the backup carries, never a whole root', async () => {
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes from the backup\n' })
    const bundle = await createBackupBundle('source')
    // This computer: a newer copy of the same skill (with a file the backup does not have),
    // and a folder the backup does not name (another Batshit's skill, BL-342).
    await writeFiles(path.join(SKILLS(), 'zc_notes'), { 'SKILL.md': '# Notes, edited later\n', 'extra.md': 'later\n' })
    await writeFiles(path.join(SKILLS(), 'zc_other_lane'), { 'SKILL.md': '# Another lane\n' })

    await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })

    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe('# Notes from the backup\n')
    await expect(fs.stat(path.join(SKILLS(), 'zc_notes', 'extra.md'))).rejects.toThrow()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_other_lane', 'SKILL.md'), 'utf8')).toBe('# Another lane\n')
    expect((await listDir(SKILLS())).filter((name) => !name.startsWith('.replaced-'))).toEqual(['zc_notes', 'zc_other_lane'])
  })

  it('names a folder it will replace, and keeps the current copy instead of deleting it (review 1)', async () => {
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes from the backup\n' })
    const bundle = await createBackupBundle('source')
    // Another Batshit on this computer holds a newer copy under the same id.
    await writeFiles(path.join(SKILLS(), 'zc_notes'), { 'SKILL.md': '# Newer text from another lane\n', 'extra.md': 'later\n' })

    const preflight = await preflightBackupRestore('target', bundle.bytes)
    expect(preflight.warnings).toContain(
      `Restore will replace your current copy of skill "Skill zc_notes" (${path.join(SKILLS(), 'zc_notes')}). ` +
        `Batshit keeps that copy in a ".replaced-…" folder in ${SKILLS()}, because another Batshit on this computer may use it.`
    )

    const result = await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
    expect(result.keptHostFolders).toHaveLength(1)
    const kept = result.keptHostFolders[0]
    expect(kept).toMatchObject({ root: 'skills', folder: 'zc_notes' })
    expect(path.basename(path.dirname(kept.path))).toMatch(/^\.replaced-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
    expect(await fs.readFile(path.join(kept.path, 'SKILL.md'), 'utf8')).toBe('# Newer text from another lane\n')
    expect(await fs.readFile(path.join(kept.path, 'extra.md'), 'utf8')).toBe('later\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe('# Notes from the backup\n')
    // A folder that did not exist here is not named and nothing is kept for it.
    await fs.rm(path.join(SKILLS()), { recursive: true, force: true })
    const fresh = await preflightBackupRestore('target', bundle.bytes)
    expect(fresh.warnings.some((warning) => warning.startsWith('Restore will replace'))).toBe(false)
  })

  it('stops before changing anything when another Batshit changes a folder during the restore (review 2)', async () => {
    await seedSkill('source', 'zc_a', { 'SKILL.md': '# A from backup\n' })
    await seedSkill('source', 'zc_b', { 'SKILL.md': '# B from backup\n' })
    const bundle = await createBackupBundle('source')
    await writeFiles(path.join(SKILLS(), 'zc_a'), { 'SKILL.md': '# A here\n' })
    await writeFiles(path.join(SKILLS(), 'zc_b'), { 'SKILL.md': '# B here\n' })
    await redis.json.set('user:target:settings', '$', { marker: 'before' })
    // An upload already here: the restore would move it aside first, if it changed anything.
    await fs.writeFile(path.join(uploadRoot, 'zc-upload-here.txt'), 'upload here')

    // Right after the journal is first written (the folders are extracted and recorded), another
    // Batshit deletes zc_a and saves it again: a new folder with the same name.
    const rename = fs.rename.bind(fs)
    const movedAside: string[] = []
    let swapped = false
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).includes('.restore-old-')) movedAside.push(String(target))
      await rename(source, target)
      if (!swapped && String(target).endsWith('.restore-journal.json')) {
        swapped = true
        await fs.rm(path.join(SKILLS(), 'zc_a'), { recursive: true })
        await writeFiles(path.join(SKILLS(), 'zc_a'), { 'SKILL.md': '# A saved again by another lane\n' })
      }
    })
    try {
      await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('Another Batshit on this computer changed the skill folder "zc_a"')
      })
    } finally {
      spy.mockRestore()
    }
    // It stopped before its first change: nothing was moved aside, uploads included.
    expect(movedAside).toEqual([])
    expect(await fs.readFile(path.join(uploadRoot, 'zc-upload-here.txt'), 'utf8')).toBe('upload here')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_a', 'SKILL.md'), 'utf8')).toBe('# A saved again by another lane\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_b', 'SKILL.md'), 'utf8')).toBe('# B here\n')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
    // Rolled back cleanly: no journal left for the next start to get stuck on.
    expect((await listDir(stagingRoot)).filter((name) => name.endsWith('.restore-journal.json'))).toEqual([])
    expect((await listDir(SKILLS())).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('refuses a new creation with the recorded inode before the first restore move', async () => {
    await seedSkill('source', 'zc_a', { 'SKILL.md': '# from backup\n' })
    const bundle = await createBackupBundle('source')
    await writeFiles(path.join(SKILLS(), 'zc_a'), { 'SKILL.md': '# original here\n' })
    await redis.json.set('user:target:settings', '$', { marker: 'before' })
    await fs.writeFile(path.join(uploadRoot, 'unchanged.txt'), 'upload before')
    const livePath = path.join(SKILLS(), 'zc_a')
    const rename = fs.rename.bind(fs)
    const lstat = fs.lstat.bind(fs)
    const movedAside: string[] = []
    let recorded: { device: string; inode: string; birthtimeNs: string } | undefined
    vi.spyOn(fs, 'lstat').mockImplementation(async (target: any, options: any) => {
      const stat = await lstat(target, options)
      return recorded && String(target) === livePath && options?.bigint
        ? Object.assign(stat, { dev: BigInt(recorded.device), ino: BigInt(recorded.inode), birthtimeNs: BigInt(recorded.birthtimeNs) + 1n })
        : stat
    })
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).includes('.restore-old-')) movedAside.push(String(target))
      await rename(source, target)
      if (!recorded && String(target).endsWith('.restore-journal.json')) {
        const journal = JSON.parse(await fs.readFile(target, 'utf8'))
        expect(journal.contract).toBe('batshit-backup-restore-journal/v4')
        recorded = journal.hostEntries[0].original
        await fs.rm(livePath, { recursive: true })
        await writeFiles(livePath, { 'SKILL.md': '# new creation\n' })
      }
    })

    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('changed the skill folder "zc_a"')
    })
    expect(recorded).toBeDefined()
    expect(movedAside).toEqual([])
    expect(await fs.readFile(path.join(livePath, 'SKILL.md'), 'utf8')).toBe('# new creation\n')
    expect(await fs.readFile(path.join(uploadRoot, 'unchanged.txt'), 'utf8')).toBe('upload before')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
  })

  it.each([undefined, 0n])('refuses unavailable creation time (%s) before publishing host recovery authority', async (birthtimeNs) => {
    await seedSkill('source', 'zc_a', { 'SKILL.md': '# from backup\n' })
    const bundle = await createBackupBundle('source')
    await writeFiles(path.join(SKILLS(), 'zc_a'), { 'SKILL.md': '# original here\n' })
    await redis.json.set('user:target:settings', '$', { marker: 'before' })
    await fs.writeFile(path.join(uploadRoot, 'unchanged.txt'), 'upload before')
    const lstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (target: any, options: any) => {
      const stat = await lstat(target, options)
      return String(target) === path.join(SKILLS(), 'zc_a') && options?.bigint
        ? Object.assign(stat, { birthtimeNs }) : stat
    })

    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true }))
      .rejects.toThrow(/cannot safely identify.*manual recovery/)
    expect(await fs.readFile(path.join(SKILLS(), 'zc_a', 'SKILL.md'), 'utf8')).toBe('# original here\n')
    expect(await fs.readFile(path.join(uploadRoot, 'unchanged.txt'), 'utf8')).toBe('upload before')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
    expect((await listDir(stagingRoot)).filter((name) => name.endsWith('.restore-journal.json'))).toEqual([])
  })

  it('keeps copies and the journal when creation time changes on rename, then retries with verified identity', async () => {
    await seedSkill('source', 'zc_a', { 'SKILL.md': '# from backup\n' })
    const bundle = await createBackupBundle('source')
    await writeFiles(path.join(SKILLS(), 'zc_a'), { 'SKILL.md': '# original here\n' })
    await redis.json.set('user:target:settings', '$', { marker: 'before' })
    await fs.writeFile(path.join(uploadRoot, 'unchanged.txt'), 'upload before')
    const rename = fs.rename.bind(fs)
    const lstat = fs.lstat.bind(fs)
    let changedPath = ''
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target)
      if (String(target).startsWith(SKILLS() + path.sep) && String(target).includes('.restore-old-') && path.basename(String(target)) === 'zc_a') {
        changedPath = String(target)
      }
    })
    const statSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target: any, options: any) => {
      const stat = await lstat(target, options)
      return changedPath && String(target) === changedPath && options?.bigint
        ? Object.assign(stat, { birthtimeNs: (stat as any).birthtimeNs + 1n }) : stat
    })

    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toMatchObject({
      status: 500, message: expect.stringContaining('kept the recovery journal')
    })
    const journals = (await listDir(stagingRoot)).filter((name) => name.endsWith('.restore-journal.json'))
    expect(journals).toHaveLength(1)
    const key = journals[0].replace('.restore-journal.json', '')
    const journalPath = path.join(stagingRoot, journals[0])
    const journalBefore = await fs.readFile(journalPath, 'utf8')
    expect(JSON.parse(journalBefore)).toMatchObject({ contract: 'batshit-backup-restore-journal/v4', phase: 'prepared' })
    expect(await fs.readFile(path.join(SKILLS(), `.restore-old-${key}`, 'zc_a', 'SKILL.md'), 'utf8')).toBe('# original here\n')
    expect(await fs.readFile(path.join(SKILLS(), `.restore-new-${key}`, 'zc_a', 'SKILL.md'), 'utf8')).toBe('# from backup\n')
    expect(await fs.readFile(path.join(uploadRoot, `.restore-old-${key}`, 'unchanged.txt'), 'utf8')).toBe('upload before')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
    const { ensureBackupRestoreRecovery } = await import('../backupRestoreService')
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow(/could not be verified/)
    expect(await fs.readFile(journalPath, 'utf8')).toBe(journalBefore)
    expect(await fs.readFile(path.join(SKILLS(), `.restore-old-${key}`, 'zc_a', 'SKILL.md'), 'utf8')).toBe('# original here\n')
    expect(await fs.readFile(path.join(SKILLS(), `.restore-new-${key}`, 'zc_a', 'SKILL.md'), 'utf8')).toBe('# from backup\n')

    statSpy.mockRestore()
    renameSpy.mockRestore()
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_a', 'SKILL.md'), 'utf8')).toBe('# original here\n')
    expect(await fs.readFile(path.join(uploadRoot, 'unchanged.txt'), 'utf8')).toBe('upload before')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it('a folder missing at export does not stop the backup, and the preflight names it', async () => {
    await seedSkill('source', 'zc_gone', null)
    await seedCloneVoice('source', 'voice_zc_silent', null)
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.hostFiles?.notCarried).toEqual([
      { root: 'skills', folder: 'zc_gone', ownerKey: 'skill:source:zc_gone', label: 'Skill zc_gone', reason: 'missing' },
      {
        root: 'voice-profiles',
        folder: 'voice_zc_silent',
        ownerKey: 'voice_profile:voice_zc_silent',
        label: 'Voice voice_zc_silent',
        reason: 'missing'
      }
    ])
    expect(Object.keys(entriesOf(bundle.bytes))).toContain('files/host/skills/zc_notes/SKILL.md')

    const preflight = await preflightBackupRestore('target', bundle.bytes)
    expect(preflight.warnings).toContain(
      'Skill "Skill zc_gone" is not fully in this backup: its folder was missing when the backup was made. The skill comes back with its settings but without its files.'
    )
    expect(preflight.warnings.some((warning) => warning.startsWith('Clone voice "Voice voice_zc_silent" is not fully in this backup'))).toBe(true)
  })

  it("names a clone voice whose folder exists but whose recording is gone", async () => {
    await seedCloneVoice('source', 'voice_zc_2', 'RIFF')
    await fs.rm(path.join(VOICES(), 'voice_zc_2', 'reference.wav'))
    await writeFiles(path.join(VOICES(), 'voice_zc_2'), { 'reference.normalized.wav': 'derived' })

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.hostFiles?.notCarried.map((entry) => entry.reason)).toEqual(['recording-missing'])
    expect(Object.keys(entriesOf(bundle.bytes)).filter((name) => name.startsWith('files/host/'))).toEqual([])
  })

  it('never follows a symbolic link, inside a folder or as the folder', async () => {
    const outside = path.join(testHome.current, 'private-notes.txt')
    await fs.mkdir(testHome.current, { recursive: true })
    await fs.writeFile(outside, 'zcbackup-private-text')
    await seedSkill('source', 'zc_linked_file', { 'SKILL.md': '# Linked\n' })
    await fs.symlink(outside, path.join(SKILLS(), 'zc_linked_file', 'notes.txt'))
    const realFolder = path.join(testHome.current, 'dev-skill')
    await writeFiles(realFolder, { 'SKILL.md': '# Dev\n' })
    await seedSkill('source', 'zc_linked_folder', null)
    await fs.symlink(realFolder, path.join(SKILLS(), 'zc_linked_folder'))

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.folder, entry.reason])).toEqual([
      ['zc_linked_file', 'symlink'],
      ['zc_linked_folder', 'symlink']
    ])
    const archiveText = Object.values(entriesOf(bundle.bytes)).map((entry) => Buffer.from(entry).toString('utf8')).join('\n')
    expect(archiveText).not.toContain('zcbackup-private-text')
    expect(Object.keys(entriesOf(bundle.bytes)).filter((name) => name.startsWith('files/host/'))).toEqual([])
  })

  it('a folder Batshit cannot read does not stop the backup either', async () => {
    await seedSkill('source', 'zc_locked', { 'SKILL.md': '# Locked\n', 'scripts/run.sh': 'echo locked\n' })
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
    const locked = path.join(SKILLS(), 'zc_locked', 'scripts')
    await fs.chmod(locked, 0o000)
    try {
      const bundle = await createBackupBundle('source')
      expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.folder, entry.reason])).toEqual([
        ['zc_locked', 'unreadable']
      ])
      expect(Object.keys(entriesOf(bundle.bytes))).toContain('files/host/skills/zc_notes/SKILL.md')
    } finally {
      await fs.chmod(locked, 0o755)
    }
  })

  it("does not carry a skill folder named by a record whose id disagrees with its key", async () => {
    await seedSkill('source', 'zc_keyed', { 'SKILL.md': '# Keyed\n' }, { id: 'zc_other_id' })
    await writeFiles(path.join(SKILLS(), 'zc_other_id'), { 'SKILL.md': '# Other\n' })

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.folder, entry.reason])).toEqual([
      ['zc_keyed', 'unsafe-name']
    ])
    expect(Object.keys(entriesOf(bundle.bytes)).filter((name) => name.startsWith('files/host/'))).toEqual([])
    // The restore of that backup does not fail on it.
    await expect(preflightBackupRestore('target', bundle.bytes)).resolves.toMatchObject({ ok: true })
  })

  it('leaves a folder over the limits out whole', async () => {
    await seedSkill('source', 'zc_big_file', { 'SKILL.md': '# Big\n' })
    // A sparse file: over the per-file limit on paper, no disk used.
    const handle = await fs.open(path.join(SKILLS(), 'zc_big_file', 'assets.bin'), 'w')
    await handle.truncate(100 * MIB + 1)
    await handle.close()
    const many: Record<string, string> = { 'SKILL.md': '# Many\n' }
    for (let index = 0; index < 2000; index += 1) many[`references/r${index}.md`] = 'x'
    await seedSkill('source', 'zc_many_files', many)

    const bundle = await createBackupBundle('source')
    expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.folder, entry.reason])).toEqual([
      ['zc_big_file', 'too-large'],
      ['zc_many_files', 'too-many-files']
    ])
    expect(Object.keys(entriesOf(bundle.bytes)).filter((name) => name.startsWith('files/host/'))).toEqual([])
    // This boundary uses 2,001 real files, written sequentially. A full parallel lane can
    // spend more than the default 5 seconds on setup alone; timing out leaves that writer
    // racing the next test's cleanup. Keep a bounded filesystem budget for this row only.
  }, 30_000)

  it('refuses two folder names that differ only in capitalization (review 6)', async () => {
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
    await seedSkill('source', 'ZC_Notes', { 'SKILL.md': '# Other\n' })
    const bundle = await createBackupBundle('source')
    await expect(preflightBackupRestore('target', bundle.bytes)).rejects.toThrow('differ only in capitalization')
    const sameFileTwice = rebuild(bundle.bytes, {
      drop: (name) => name.includes('/ZC_Notes/'),
      add: { 'files/host/skills/zc_notes/skill.md': '# twin\n' }
    })
    await expect(preflightBackupRestore('target', sameFileTwice)).rejects.toThrow('differ only in capitalization')
  })

  it('refuses an archive that carries files for no record, for an unknown place, or with an unsafe name', async () => {
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
    const bundle = await createBackupBundle('source')

    const intruder = rebuild(bundle.bytes, { add: { 'files/host/skills/zc_intruder/SKILL.md': '# Not mine\n' } })
    await expect(preflightBackupRestore('target', intruder)).rejects.toThrow(
      'Backup carries files for skill "zc_intruder" but no matching record'
    )
    await expect(restoreBackupBundle('target', intruder, { confirmReplace: true })).rejects.toThrow('no matching record')
    await expect(fs.stat(path.join(SKILLS(), 'zc_intruder'))).rejects.toThrow()

    const unknownRoot = rebuild(bundle.bytes, { add: { 'files/host/agents/zc/config.toml': 'x' } })
    await expect(preflightBackupRestore('target', unknownRoot)).rejects.toThrow('a place Batshit does not restore')

    const hiddenFolder = rebuild(bundle.bytes, { add: { 'files/host/skills/.restore-old-x/SKILL.md': 'x' } })
    await expect(preflightBackupRestore('target', hiddenFolder)).rejects.toThrow('unsafe skill or voice folder name')

    const miscounted = rebuild(bundle.bytes, { manifest: (manifest) => { manifest.contents.hostFileCount += 1 } })
    await expect(preflightBackupRestore('target', miscounted)).rejects.toThrow('inventory does not match')

    // A backup Batshit made never carries a folder over the limits, so one that does is refused.
    const extra: Record<string, string> = {}
    for (let index = 0; index < 2000; index += 1) extra[`files/host/skills/zc_notes/references/r${index}.md`] = 'x'
    const overLimit = rebuild(bundle.bytes, { add: extra })
    await expect(preflightBackupRestore('target', overLimit)).rejects.toThrow('over the backup limits for one folder')
    await expect(preflightStagedBackupRestore('target', await stage(overLimit, 'target'))).rejects.toThrow(
      'over the backup limits for one folder'
    )
  })

  it('an older backup without host files restores the records and says which skills and voices come without files', async () => {
    await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
    await seedCloneVoice('source', 'voice_zc_1', 'RIFF')
    const bundle = await createBackupBundle('source')
    const older = rebuild(bundle.bytes, {
      drop: (name) => name.startsWith('files/host/'),
      manifest: (manifest) => {
        delete manifest.hostFiles
        delete manifest.contents.hostFileCount
        delete manifest.contents.hostFileBytes
      }
    })
    await fs.rm(path.join(testHome.current, '.batshit'), { recursive: true, force: true })

    const preflight = await preflightBackupRestore('target', older)
    expect(preflight.warnings.find((warning) => warning.startsWith('This backup is from a Batshit that did not save skill files'))).toContain(
      'skills Skill zc_notes; clone voices Voice voice_zc_1'
    )
    const result = await restoreBackupBundle('target', older, { confirmReplace: true })
    expect(result.hostFileCount).toBe(0)
    expect(await redis.json.get('skill:target:zc_notes')).toBeTruthy()
    await expect(fs.stat(path.join(SKILLS(), 'zc_notes'))).rejects.toThrow()
  })

  describe('in Docker', () => {
    it('lists a clone voice as host-only at export and still carries skills', async () => {
      await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
      await seedCloneVoice('source', 'voice_zc_1', 'RIFF')
      vi.stubEnv('BATSHIT_CONTAINERIZED', '1')

      const bundle = await createBackupBundle('source')
      expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.root, entry.reason])).toEqual([
        ['voice-profiles', 'host-only']
      ])
      expect(Object.keys(entriesOf(bundle.bytes))).toContain('files/host/skills/zc_notes/SKILL.md')
    })

    it('restores skills but leaves voice recordings out, and says so', async () => {
      await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
      const audioPath = await seedCloneVoice('source', 'voice_zc_1', 'RIFF')
      const bundle = await createBackupBundle('source')
      await fs.rm(path.join(testHome.current, '.batshit'), { recursive: true, force: true })
      vi.stubEnv('BATSHIT_CONTAINERIZED', '1')

      const preflight = await preflightBackupRestore('target', bundle.bytes)
      expect(preflight.warnings).toContain(
        'This Docker Batshit cannot place clone voice recordings on the host computer yet, so these clone voices come back without their recording: Voice voice_zc_1. Record or upload each sample again in Voice Studio.'
      )
      await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
      expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe('# Notes\n')
      await expect(fs.stat(path.join(VOICES(), 'voice_zc_1'))).rejects.toThrow()
      const voice = (await redis.json.get('voice_profile:voice_zc_1')) as Record<string, any>
      expect(voice.settings.batshitManagedReferenceAudioPath).toBe(audioPath)
    })
  })

  it('puts every replaced folder back when the restore fails partway', async () => {
    await seedSkill('source', 'zc_a', { 'SKILL.md': '# A from backup\n' })
    await seedSkill('source', 'zc_b', { 'SKILL.md': '# B from backup\n' })
    const bundle = await createBackupBundle('source')
    await writeFiles(path.join(SKILLS(), 'zc_a'), { 'SKILL.md': '# A on this computer\n' })
    await fs.rm(path.join(SKILLS(), 'zc_b'), { recursive: true, force: true })

    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === path.join(SKILLS(), 'zc_b')) throw new Error('injected move failure')
      return rename(source, target)
    })
    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toThrow('injected move failure')
    spy.mockRestore()

    expect(await fs.readFile(path.join(SKILLS(), 'zc_a', 'SKILL.md'), 'utf8')).toBe('# A on this computer\n')
    await expect(fs.stat(path.join(SKILLS(), 'zc_b'))).rejects.toThrow()
    expect(await listDir(SKILLS())).toEqual(['zc_a'])
    expect((await listDir(stagingRoot)).filter((name) => name.endsWith('.restore-journal.json'))).toEqual([])
  })

  describe('a file that changes between the folder check and the export (review 4)', () => {
    async function seedAndSwapOnOpen() {
      await seedSkill('source', 'zc_notes', { 'SKILL.md': '# Notes\n' })
      await seedSkill('source', 'zc_swapped', { 'SKILL.md': '# Swapped\n', 'scripts/run.sh': 'echo swapped\n' })
      const outside = path.join(testHome.current, 'zc-outside.txt')
      await fs.writeFile(outside, 'zcbackup-outside-text')
      const open = fs.open.bind(fs)
      const target = path.join(SKILLS(), 'zc_swapped', 'scripts', 'run.sh')
      let swapped = false
      // After the walk, before the export opens it, the file becomes a link to a file outside.
      return vi.spyOn(fs, 'open').mockImplementation(async (file: any, ...rest: any[]) => {
        if (!swapped && String(file) === target) {
          swapped = true
          await fs.rm(target)
          await fs.symlink(outside, target)
        }
        return (open as any)(file, ...rest)
      })
    }

    function expectSwappedLeftOut(bytes: Uint8Array, manifest: any) {
      const names = Object.keys(entriesOf(bytes))
      expect(names).toContain('files/host/skills/zc_notes/SKILL.md')
      expect(names.filter((name) => name.includes('/zc_swapped/'))).toEqual([])
      const archiveText = Object.values(entriesOf(bytes)).map((entry) => Buffer.from(entry).toString('utf8')).join('\n')
      expect(archiveText).not.toContain('zcbackup-outside-text')
      expect(manifest.hostFiles.notCarried.map((entry: any) => [entry.folder, entry.reason])).toEqual([['zc_swapped', 'changed']])
      expect(manifest.contents.hostFileCount).toBe(1)
    }

    async function exportWithSwap(swap: (runSh: string) => Promise<void>) {
      await seedSkill('source', 'zc_swapped', { 'SKILL.md': '# Swapped\n', 'scripts/run.sh': 'echo swapped\n' })
      const target = path.join(SKILLS(), 'zc_swapped', 'scripts', 'run.sh')
      const open = fs.open.bind(fs)
      let swapped = false
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (file: any, ...rest: any[]) => {
        if (!swapped && String(file) === target) {
          swapped = true
          await swap(target)
        }
        return (open as any)(file, ...rest)
      })
      try {
        return await createBackupBundle('source')
      } finally {
        spy.mockRestore()
      }
    }

    it('a folder inside that became a link to a folder outside is left out (the opened file is not the one walked)', async () => {
      const outsideDir = path.join(testHome.current, 'zc-outside-scripts')
      await fs.mkdir(outsideDir, { recursive: true })
      // Same name and size as the walked file, so only its identity tells them apart.
      await fs.writeFile(path.join(outsideDir, 'run.sh'), 'echo outside\n')
      expect('echo outside\n'.length).toBe('echo swapped\n'.length)
      const bundle = await exportWithSwap(async (runSh) => {
        await fs.rm(path.dirname(runSh), { recursive: true })
        await fs.symlink(outsideDir, path.dirname(runSh))
      })
      expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.folder, entry.reason])).toEqual([['zc_swapped', 'changed']])
      const archiveText = Object.values(entriesOf(bundle.bytes)).map((entry) => Buffer.from(entry).toString('utf8')).join('\n')
      expect(archiveText).not.toContain('echo outside')
    })

    it('a file moved out of the folder and linked back is left out (never opened through a link)', async () => {
      const outside = path.join(testHome.current, 'zc-moved-out.sh')
      const bundle = await exportWithSwap(async (runSh) => {
        await fs.rename(runSh, outside)
        await fs.symlink(outside, runSh)
      })
      expect(bundle.manifest.hostFiles?.notCarried.map((entry) => [entry.folder, entry.reason])).toEqual([['zc_swapped', 'changed']])
      expect(Object.keys(entriesOf(bundle.bytes)).filter((name) => name.includes('/zc_swapped/'))).toEqual([])
    })

    it('checks a large folder one file handle at a time, and reports running out of handles as that (re-review 3)', async () => {
      const files: Record<string, string> = { 'SKILL.md': '# Many\n' }
      for (let index = 0; index < 60; index += 1) files[`references/r${index}.md`] = `r${index}`
      await seedSkill('source', 'zc_many', files)
      const open = fs.open.bind(fs)
      let openNow = 0
      let openMost = 0
      const counting = vi.spyOn(fs, 'open').mockImplementation(async (file: any, ...rest: any[]) => {
        const handle = await (open as any)(file, ...rest)
        if (!String(file).startsWith(SKILLS())) return handle
        openNow += 1
        openMost = Math.max(openMost, openNow)
        const close = handle.close.bind(handle)
        handle.close = async () => {
          openNow -= 1
          return close()
        }
        return handle
      })
      try {
        const bundle = await createBackupBundle('source')
        expect(bundle.manifest.contents.hostFileCount).toBe(61)
      } finally {
        counting.mockRestore()
      }
      expect(openMost).toBe(1)

      const exhausted = vi.spyOn(fs, 'open').mockImplementation(async (file: any, ...rest: any[]) => {
        if (String(file).startsWith(SKILLS())) {
          throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
        }
        return (open as any)(file, ...rest)
      })
      try {
        await expect(createBackupBundle('source')).rejects.toMatchObject({
          status: 503,
          message: expect.stringContaining('ran out of open files')
        })
      } finally {
        exhausted.mockRestore()
      }
    })

    it('leaves that folder out whole and still makes a restorable backup (buffer export)', async () => {
      const spy = await seedAndSwapOnOpen()
      let bundle: Awaited<ReturnType<typeof createBackupBundle>>
      try {
        bundle = await createBackupBundle('source')
      } finally {
        spy.mockRestore()
      }
      expectSwappedLeftOut(bundle.bytes, manifestOf(bundle.bytes))
      expect(bundle.manifest.hostFiles?.notCarried.map((entry) => entry.reason)).toEqual(['changed'])
      await expect(preflightBackupRestore('target', bundle.bytes)).resolves.toMatchObject({ ok: true, hostFileCount: 1 })
    })

    it('leaves that folder out whole and writes the manifest last (streamed export)', async () => {
      const spy = await seedAndSwapOnOpen()
      let bytes: Uint8Array
      try {
        const bundle = await createBackupBundleStream('source')
        bytes = new Uint8Array(await new Response(bundle.stream).arrayBuffer())
        // The route read the manifest before streaming; it now says what was written.
        expect(bundle.manifest.hostFiles?.notCarried.map((entry) => entry.reason)).toEqual(['changed'])
      } finally {
        spy.mockRestore()
      }
      expectSwappedLeftOut(bytes, manifestOf(bytes))
      await expect(preflightBackupRestore('target', bytes)).resolves.toMatchObject({ ok: true, hostFileCount: 1 })
    })
  })

  it('wrote nothing into the real home folder, under any name this suite uses', async () => {
    for (const { root, names } of realHomeRoots) {
      const entries = await listDir(root)
      for (const name of names) expect(entries).not.toContain(name)
      // A restore that keeps a replaced copy nests it inside a ".replaced-…" wrapper named after
      // the folder it replaced (see "review 1" above) — check inside every such wrapper too.
      for (const wrapper of entries.filter((name) => name.startsWith('.replaced-'))) {
        const inner = await listDir(path.join(root, wrapper))
        for (const name of names) expect(inner).not.toContain(name)
      }
    }
  })
})
