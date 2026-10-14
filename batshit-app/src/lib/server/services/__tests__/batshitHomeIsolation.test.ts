import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'

const fixture = vi.hoisted(() => ({ home: '', records: new Map<string, any>() }))
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>()
  const homedir = () => {
    if (!fixture.home) throw new Error('No disposable home exists.')
    return fixture.home
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('$lib/server/redis', () => ({ redis: {
  json: {
    get: async (key: string) => fixture.records.get(key) ?? null,
    set: async (key: string, _path: string, value: unknown) => fixture.records.set(key, value)
  },
  getUserSettings: async () => ({}),
  del: async (key: string) => fixture.records.delete(key)
} }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: { list: async () => [] } }))

beforeEach(async () => {
  const realOs = await vi.importActual<typeof import('node:os')>('node:os')
  fixture.home = await realpath(await mkdtemp(path.join(realOs.tmpdir(), 'batshit-home-isolation-')))
  fixture.records.clear()
  vi.stubEnv('BATSHIT_HOME_DIR', '')
  vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', '')
  vi.stubEnv('BATSHIT_SANDBOX_PROTECTED_HOME_DIR', '')
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.resetModules()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(fixture.home, { recursive: true, force: true })
  fixture.home = ''
})

describe('BL-342 default and disposable lane ownership', () => {
  it('preserves defaults and shares one explicit agents-parent override', async () => {
    const home = await import('../batshitHome')
    expect(home.getBatshitHomeDir()).toBe(path.join(fixture.home, '.batshit'))
    expect(home.getManagedAgentRootDir()).toBe(path.join(fixture.home, '.batshit', 'agents'))
    vi.stubEnv('BATSHIT_HOME_DIR', path.join(fixture.home, 'lane'))
    expect(home.getManagedAgentRootDir()).toBe(path.join(fixture.home, 'lane', 'agents'))
    vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', path.join(fixture.home, 'profiles'))
    expect(home.getManagedAgentRootDir()).toBe(path.join(fixture.home, 'profiles', 'agents'))
    vi.stubEnv('BATSHIT_HOME_DIR', 'relative-home')
    expect(() => home.getBatshitHomeDir()).toThrow('absolute folder')
  })

  it('writes and deletes same-id skills only in their lane, with portable and voice files alongside', async () => {
    const laneA = path.join(fixture.home, 'lane-a')
    const laneB = path.join(fixture.home, 'lane-b')
    vi.stubEnv('BATSHIT_HOME_DIR', laneA)
    const skillsA = await import('../skillRegistry')
    await skillsA.upsertSkill({ userId: 'a', commandId: 'same', skill: { id: 'same', name: 'same', markdown: '# A\n\nKeep lane A text.' } })
    const textA = await readFile(path.join(laneA, 'skills/same/SKILL.md'), 'utf8')
    vi.stubEnv('BATSHIT_HOME_DIR', laneB)
    vi.resetModules()
    const skillsB = await import('../skillRegistry')
    await skillsB.upsertSkill({ userId: 'b', commandId: 'same', skill: { id: 'same', name: 'same', markdown: '# B\n\nLane B text.' } })
    await skillsB.deleteSkill('b', 'same')
    expect(await readFile(path.join(laneA, 'skills/same/SKILL.md'), 'utf8')).toBe(textA)
    await expect(readFile(path.join(laneB, 'skills/same/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const portable = await import('../portableSkillTokens')
    const templates = await portable.ensurePortableSkillEnvTemplates('http://127.0.0.1:5650')
    expect(templates[0].path).toBe(path.join(laneB, 'portable-skills/portable-skills.env'))
    const placeholderFile = await readFile(templates[0].path, 'utf8')
    expect(placeholderFile).toContain('paste-your-portable-skill-token-here')
    // BL-341: the file names this lane's own address.
    expect(placeholderFile).toContain('BATSHIT_BASE_URL=http://127.0.0.1:5650\n')
    const voice = await import('../voiceProfileRecords')
    const saved = await voice.saveReferenceAudioForByoClone({ profileId: 'voice-probe', audio: new Uint8Array([1, 2, 3]), filename: 'sample.wav' })
    expect(saved.audioPath).toBe(path.join(laneB, 'voice-profiles/voice-probe/reference.wav'))
    const backup = await import('../backupHostFiles')
    expect(backup.resolveHostFileRoot('skills')).toBe(path.join(laneB, 'skills'))
    expect(backup.resolveHostFileRoot('voice-profiles')).toBe(path.join(laneB, 'voice-profiles'))
    // A saved absolute path from another home is not rewritten or deleted by this lane.
    const otherAudio = path.join(laneA, 'voice-profiles/voice-probe/reference.wav')
    await mkdir(path.dirname(otherAudio), { recursive: true })
    await writeFile(otherAudio, 'keep')
    await voice.deleteManagedVoiceProfileArtifacts({ settings: { batshitManagedReferenceAudioPath: otherAudio } } as never)
    expect(await readFile(otherAudio, 'utf8')).toBe('keep')
  })

  it('splits writable mounts and refuses custom/shared protected aliases and separate agents roots', async () => {
    const home = path.join(fixture.home, 'custom-home')
    const shared = path.join(fixture.home, '.batshit')
    const profiles = path.join(fixture.home, 'separate-profiles')
    const originalHost = path.join(fixture.home, 'original-host', '.batshit')
    vi.stubEnv('BATSHIT_SANDBOX_PROTECTED_HOME_DIR', originalHost)
    vi.stubEnv('BATSHIT_HOME_DIR', home)
    vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', profiles)
    const mounts = await import('../sandboxHomeMounts')
    const sandbox = await import('../dockerSandboxSbx')
    const paths = await mounts.ensureBatshitHomeSandboxMountPaths()
    expect(paths).toContain(path.join(home, 'skills'))
    expect(paths).toContain(path.join(shared, 'installs'))
    expect(paths).not.toContain(path.join(home, 'agents'))
    const args = sandbox.sbxCreateArgs({ sandboxName: 'probe', workspaceRoot: path.join(fixture.home, 'project'), extraWorkspaces: [home] })
    expect(args).toEqual(expect.arrayContaining(paths))
    expect(args).not.toContain(home)
    for (const protectedRoot of [path.join(home, 'agents'), path.join(shared, 'runtime'), path.join(profiles, 'agents'), ...['agents', 'runtime', 'pinokio'].map((name) => path.join(originalHost, name))]) {
      await mkdir(protectedRoot, { recursive: true })
      const alias = `${protectedRoot}-alias`
      await symlink(protectedRoot, alias)
      for (const workspaceRoot of [protectedRoot, alias, path.dirname(protectedRoot)]) {
        expect(() => sandbox.sbxCreateArgs({ sandboxName: 'probe', workspaceRoot })).toThrow(/protected runtime/)
      }
    }
    const nameA = sandbox.buildSbxSandboxName({ workspaceRoot: '/project' })
    vi.stubEnv('BATSHIT_HOME_DIR', path.join(fixture.home, 'another-home'))
    expect(sandbox.buildSbxSandboxName({ workspaceRoot: '/project' })).not.toBe(nameA)
    vi.stubEnv('BATSHIT_HOME_DIR', home)
    const originalHome = fixture.home
    try {
      fixture.home = path.join(originalHome, 'another-user-home')
      expect(sandbox.buildSbxSandboxName({ workspaceRoot: '/project' })).not.toBe(nameA)
    } finally {
      fixture.home = originalHome
    }
  })
})
