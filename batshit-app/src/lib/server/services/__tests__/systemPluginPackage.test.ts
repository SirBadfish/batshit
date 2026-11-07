import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { splitFrontmatter } from '../skillFrontmatter'
import {
  BUNDLED_BATSHIT_PLUGIN_ID,
  BUILTIN_PLUGIN_SKILLS,
  BUNDLED_BATSHIT_PLUGIN_VERSION,
  isCanonicalAppActionsSkill,
  readBuiltinSkillToolGroups,
  getBundledBatshitPluginRoot,
  getBuiltinSystemSkillsRoot,
  resolveBuiltinSystemSkillDirectory
} from '../systemPluginPackage'

const GROUPS = {
  artifact_creator: ['sys.artifact.*', 'artifact.*', 'sys.model_catalog.*', 'sys.pinokio.*', 'sys.comfyui.*', 'sys.runtime_addon.*'],
  cli_tool_creator: ['sys.cli_tool.*', 'sys.runtime_addon.*'],
  voice_engine_installer: ['sys.voice.engine.*', 'sys.runtime_addon.*'],
  goon_scene_creator: ['sys.goon_scene.*'], skill_creator: ['sys.skill.*'], app_actions: ['sys.ui.*', 'sys.app_settings.*']
}
const NATIVE_LINE = 'While this skill is open, look in your DCM for its available tools and their fields.'
const OUTSIDE_LINE = 'First ask Batshit for the current controls relevant to this job with `POST /api/controls/find`, using `x-batshit-portable-token` and `includeSchema: true`; it returns only controls permitted by your token. Keep this guide\'s own scope and safety rules.'

describe('the canonical built-in Batshit plugin', () => {
  it('resolves stable IDs and old folder aliases to one owned skill directory', () => {
    for (const skill of BUILTIN_PLUGIN_SKILLS) {
      const expected = path.join(getBuiltinSystemSkillsRoot(), skill.directory)
      for (const alias of [skill.skillId, skill.commandId, skill.legacyDirectory, skill.legacyDirectory.replace(/-/g, '_'), `/batshit:${skill.directory}`]) {
        expect(resolveBuiltinSystemSkillDirectory(alias), alias).toBe(expected)
      }
    }
    for (const unowned of ['other-skill', '../artifact-creator', 'batshit:../artifact-creator', 'other:artifact-creator', '/tmp/artifacts']) {
      expect(resolveBuiltinSystemSkillDirectory(unowned)).toBeNull()
    }
  })

  it('ships two matching manifests around the same eight skill folders', async () => {
    const root = getBundledBatshitPluginRoot()
    const portable = JSON.parse(await fs.readFile(path.join(root, 'plugin.json'), 'utf8'))
    const claude = JSON.parse(await fs.readFile(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
    expect(portable.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(portable.name).toBe(BUNDLED_BATSHIT_PLUGIN_ID)
    expect(claude.name).toBe(portable.name)
    expect(claude.version).toBe(portable.version)
    expect(portable.version).toBe(BUNDLED_BATSHIT_PLUGIN_VERSION)
    expect(BUILTIN_PLUGIN_SKILLS).toHaveLength(8)
    expect((await fs.readdir(getBuiltinSystemSkillsRoot())).sort()).toEqual(BUILTIN_PLUGIN_SKILLS.map((skill) => skill.directory).sort())
    for (const skill of BUILTIN_PLUGIN_SKILLS) {
      const skillRoot = path.join(getBuiltinSystemSkillsRoot(), skill.directory)
      const entrypoint = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')
      expect(entrypoint.length).toBeLessThan(4_500)
      const { frontmatter } = splitFrontmatter(entrypoint)
      expect(frontmatter.name).toBe(skill.directory)
      const metadata = frontmatter.metadata as Record<string, string>
      expect(metadata.command).toBe(`/batshit:${skill.directory}`)
      const expectedTools = ['native_batshit_tool_search', 'native_batshit_tool_use', ...(skill.skillId === 'app_actions' ? [] : ['native_skill'])]
      if (['cli-tool-creator', 'voice-engine-installer'].includes(skill.directory)) expectedTools.push('native_bash_execute')
      expect(metadata.allowedTools.split(',').sort()).toEqual(expectedTools.sort())
      for (const match of entrypoint.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = path.resolve(skillRoot, match[1])
        expect(target.startsWith(`${skillRoot}${path.sep}`), match[1]).toBe(true)
        expect((await fs.stat(target)).isFile(), match[1]).toBe(true)
      }
      if (skill.skillId !== 'goon_guide') {
        const native = splitFrontmatter(await fs.readFile(path.join(skillRoot, 'references/native.md'), 'utf8'))
        if (skill.skillId === 'artifact_creator') {
          // BL-2351: the thin entrypoint owns metadata; duplicating it here broke
          // the native guide's one-read budget. Keep the operational guide body.
          expect(native.frontmatter).toEqual({})
          expect(native.body.trimStart()).toMatch(/^# Artifact Creator \(Batshit System Skill\)/)
        } else if (skill.skillId !== 'app_actions') {
          const oldMetadata = native.frontmatter.metadata as Record<string, string>
          expect(oldMetadata.allowedTools).toBe(metadata.allowedTools)
        }
        expect((await fs.stat(path.join(skillRoot, 'references/outside.md'))).isFile()).toBe(true)
      }
    }
  })

  it('reads only official frontmatter metadata without seeding, and surfaces known-package failures', () => {
    const unused = vi.fn(() => { throw new Error('not a built-in') })
    expect(readBuiltinSkillToolGroups('custom-skill', unused)).toEqual([])
    expect(unused).not.toHaveBeenCalled()
    for (const [skillId, groups] of Object.entries(GROUPS)) expect(readBuiltinSkillToolGroups(skillId)).toEqual(groups)
    expect(readBuiltinSkillToolGroups('batshit_guide')).toEqual([])
    expect(readBuiltinSkillToolGroups('goon_guide')).toEqual([])
    expect(() => readBuiltinSkillToolGroups('artifact_creator', () => { throw new Error('injected package read failure') })).toThrow('package read failure')
    expect(() => readBuiltinSkillToolGroups('artifact_creator', () => '# No metadata')).toThrow('metadata')
    expect(() => readBuiltinSkillToolGroups('artifact_creator', () => '---\nname: artifact-creator\nmetadata: {"toolGroups":null}\n---\n# Skill')).toThrow('comma-separated string')
  })

  it('keeps approved shared lines on operational lanes, without changing informational Guides or scope metadata', async () => {
    for (const skill of BUILTIN_PLUGIN_SKILLS) {
      const root = path.join(getBuiltinSystemSkillsRoot(), skill.directory)
      const entry = splitFrontmatter(await fs.readFile(path.join(root, 'SKILL.md'), 'utf8'))
      if (skill.skillId in GROUPS) {
        expect((await fs.readFile(path.join(root, 'references/native.md'), 'utf8')).split(NATIVE_LINE)).toHaveLength(2)
        expect((await fs.readFile(path.join(root, 'references/outside.md'), 'utf8')).split(OUTSIDE_LINE)).toHaveLength(2)
      } else {
        expect((entry.frontmatter.metadata as Record<string, unknown>).toolGroups).toBeUndefined()
        expect(entry.body).not.toContain(NATIVE_LINE)
      }
      if (['artifact_creator', 'goon_scene_creator'].includes(skill.skillId)) {
        expect(entry.frontmatter.metadata).toMatchObject({ mcp_scope_mode: 'replace', mcp_scope_gateways: 'all' })
      }
    }
  })

  it('binds only positively owned App Actions system metadata, including restored Windows package paths', () => {
    const owned = { id: 'app_actions', user_id: 'owner', is_system: true, source: 'system', source_ref: '/old/server/system-plugins/batshit/skills/app-actions' }
    expect(isCanonicalAppActionsSkill(owned, 'owner')).toBe(true)
    expect(isCanonicalAppActionsSkill({ ...owned, source_ref: 'C:\\old\\server\\system-plugins\\batshit\\skills\\app-actions\\SKILL.md' }, 'owner')).toBe(true)
    expect(isCanonicalAppActionsSkill({ ...owned, source: 'custom' }, 'owner')).toBe(false)
    expect(isCanonicalAppActionsSkill({ ...owned, source_ref: '/user/skills/app_actions' }, 'owner')).toBe(false)
  })

  it('ships the exact approved App Actions guides and token loader, with the approved shared outside line and panel rename', async () => {
    const root = path.join(getBuiltinSystemSkillsRoot(), 'app-actions')
    const native = await fs.readFile(path.join(root, 'references/native.md'))
    const outside = await fs.readFile(path.join(root, 'references/outside.md'))
    // Frozen approved bytes keep this public suite independent of private teaching drafts.
    expect(native.byteLength).toBe(2339)
    expect(createHash('sha256').update(native).digest('hex')).toBe('c3b6f5ae79e9bbf5b0d9856b736c95a9b439a6bc918a7076a53bcf59305e2d6e')
    expect(outside.byteLength).toBe(6206)
    expect(createHash('sha256').update(outside).digest('hex')).toBe('66a5c582bb1b84e895cd7f0947b07e50913f10c692a2e3c820a671f76bc97b3b')
    expect(outside.toString('utf8')).toContain('$PORTABLE_SKILL_ENV_DIR/app-actions.env')
    expect(outside.toString('utf8')).not.toContain('open_skills')
  })

  it('declares tool-group namespaces that have an actual owning registry ID or generated ID prefix', async () => {
    const source = (await Promise.all(['fabricRegistry.ts', 'nativeFabricHelperCatalog.ts'].map(file => fs.readFile(path.resolve(process.cwd(), 'src/lib/server/services', file), 'utf8')))).join('\n')
    const ids = [...source.matchAll(/controlId:\s*['"`]([^'"`]+)['"`]/g)].map(match => match[1])
    // Scoped Settings controls are registered from this fixed executor map, not inline IDs.
    const settings = await fs.readFile(path.resolve(process.cwd(), 'src/lib/server/services/appActions/settings/managementActor.ts'), 'utf8')
    expect(source).toContain('Object.entries(SETTINGS_MANAGEMENT_CONTROL_IDS)')
    ids.push(...[...settings.matchAll(/(?:nativeReport|nativeChange|portableReport|portableChange):\s*['"]([^'"]+)['"]/g)].map(match => match[1]))
    for (const group of new Set(Object.values(GROUPS).flat())) {
      expect(ids.some(id => id.startsWith(group.slice(0, -1))), group).toBe(true)
    }
  })

  it('retains the Goon Guide text byte-for-byte', async () => {
    const guide = await fs.readFile(path.join(getBuiltinSystemSkillsRoot(), 'goon-guide/references/goon-guide.md'))
    // Frozen pre-transfer receipt; the retired clip backup is no longer an authored source.
    expect(guide.byteLength).toBe(24_380)
    expect(createHash('sha256').update(guide).digest('hex')).toBe('666a97e822b90646d611b3c528e62c36daad99fbad7a0dac54e317465e98da44')
  })
})
