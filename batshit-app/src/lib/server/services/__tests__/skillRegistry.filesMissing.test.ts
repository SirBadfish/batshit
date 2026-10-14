/**
 * BL-369: a user skill's text lives only in its folder under `~/.batshit/skills`. When that
 * folder is missing (a restore of a backup made before backups carried skill files, or another
 * Batshit on the same computer deleted a same-id skill, BL-342), Batshit must never write a blank
 * placeholder over the skill and never rewrite its Redis record to match one. It says so
 * instead, and a save that brings the skill's text recreates the folder.
 *
 * SAFETY: the skill root is read from `os.homedir()` when `skillRegistry` loads, so `node:os`
 * answers a temporary home before any module under test loads, and a last test checks that the
 * real `~/.batshit/skills` holds none of this suite's own skill names (never the whole tree:
 * another process's unrelated write there, such as a dev server's skill sync touching a
 * `metadata.json`, is not this suite's business and must not fail its sentinel; BL-808, BL-773).
 * Memory note: tests that save skills write to the real home.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const nodePath = await import('node:path')
  if (!testHome.current) {
    testHome.current = nodePath.join(real.tmpdir(), `batshit-skill-files-missing-home-${process.pid}-${Date.now()}`)
  }
  const homedir = () => testHome.current
  return { ...real, homedir, default: { ...real, homedir } }
})

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: { list: vi.fn(async () => []) }
}))

import os from 'node:os'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ownNamesUnder } from '$lib/test-utils/realHomeSnapshot'
import { redis } from '$lib/server/redis'
import {
  SkillFilesMissingError,
  getSkill,
  runSkillFilesystemMigrationPass,
  upsertSkill
} from '../skillRegistry'

useRedisTestServer()

const SKILLS = () => path.join(testHome.current, '.batshit', 'skills')
/**
 * Every skill folder id this suite saves — the sentinel below checks the REAL home for exactly
 * these names, and only these. Add a name here when a new fixture needs one, rather than widening
 * the sentinel to watch the whole tree.
 */
const OWN_SKILL_NAMES = ['zc_notes']
let realSkillsRoot = ''

beforeAll(async () => {
  const realOs = await vi.importActual<typeof import('node:os')>('node:os')
  realSkillsRoot = path.join(realOs.homedir(), '.batshit', 'skills')
  expect(os.homedir()).toBe(testHome.current)
})

afterAll(async () => {
  await fs.rm(testHome.current, { recursive: true, force: true })
})

beforeEach(async () => {
  // `systemSlashCommands.resolveUserSkillDir` reads `process.env.HOME`, not `os.homedir()`.
  vi.stubEnv('HOME', testHome.current)
  await fs.rm(path.join(testHome.current, '.batshit'), { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const MARKDOWN = '---\nname: zc-notes\ndescription: Keeps zcbackup notes.\n---\n# Notes\n\nThe real text.\n'

async function savedSkillWithMissingFolder() {
  await upsertSkill({
    userId: 'josh',
    commandId: 'zc_notes',
    nowIso: '2026-09-27T00:00:00.000Z',
    skill: { id: 'zc_notes', name: 'zc-notes', description: 'Keeps zcbackup notes.', markdown: MARKDOWN }
  })
  const before = await redis.json.get('skill:josh:zc_notes')
  await fs.rm(path.join(SKILLS(), 'zc_notes'), { recursive: true, force: true })
  return before
}

describe('a user skill whose files are missing (BL-369)', () => {
  it('reading it writes no placeholder, leaves its record alone, and says which folder is missing', async () => {
    const before = await savedSkillWithMissingFolder()

    const read = getSkill('josh', 'zc_notes')
    await expect(read).rejects.toBeInstanceOf(SkillFilesMissingError)
    await expect(getSkill('josh', 'zc_notes')).rejects.toThrow(path.join(SKILLS(), 'zc_notes'))
    await expect(getSkill('josh', 'zc_notes')).rejects.toMatchObject({ code: 'SKILL_FILES_MISSING' })

    await expect(fs.stat(path.join(SKILLS(), 'zc_notes'))).rejects.toThrow()
    expect(await redis.json.get('skill:josh:zc_notes')).toEqual(before)
  })

  it('the startup pass skips it and writes no placeholder', async () => {
    const before = await savedSkillWithMissingFolder()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await runSkillFilesystemMigrationPass()

    await expect(fs.stat(path.join(SKILLS(), 'zc_notes'))).rejects.toThrow()
    expect(await redis.json.get('skill:josh:zc_notes')).toEqual(before)
    expect(warn.mock.calls.some((call) => call.some((part) => String(part).includes('SKILL.md') || String(part).includes('zc_notes')))).toBe(true)
    warn.mockRestore()
  })

  it('a save without its text is refused; a save with its text recreates the folder', async () => {
    const before = await savedSkillWithMissingFolder()

    await expect(
      upsertSkill({
        userId: 'josh',
        commandId: 'zc_notes',
        skill: { id: 'zc_notes', name: 'zc-notes', trustLevel: 'trusted' }
      })
    ).rejects.toBeInstanceOf(SkillFilesMissingError)
    await expect(fs.stat(path.join(SKILLS(), 'zc_notes'))).rejects.toThrow()
    expect(await redis.json.get('skill:josh:zc_notes')).toEqual(before)

    const repaired = await upsertSkill({
      userId: 'josh',
      commandId: 'zc_notes',
      skill: { id: 'zc_notes', name: 'zc-notes', markdown: MARKDOWN }
    })
    expect(repaired.skill_markdown).toContain('The real text.')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe(MARKDOWN)
  })

  it('a skill whose files are there still reads normally', async () => {
    await upsertSkill({
      userId: 'josh',
      commandId: 'zc_notes',
      skill: { id: 'zc_notes', name: 'zc-notes', markdown: MARKDOWN }
    })
    const skill = await getSkill('josh', 'zc_notes')
    expect(skill?.skill_markdown).toContain('The real text.')
  })

  it('wrote nothing into the real home folder, under any name this suite uses', async () => {
    expect(await ownNamesUnder(realSkillsRoot, OWN_SKILL_NAMES)).toEqual([])
  })
})
