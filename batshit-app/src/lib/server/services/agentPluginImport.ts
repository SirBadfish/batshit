import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { getBatshitHomeDir } from './batshitHome'
import { deriveSkillDefinition, type ImportedSkillDefinition } from './skillImport'
import { capturePluginArchiveFiles, readPluginArchive } from './agentPluginArchive'
import { upsertSkill, deleteSkill } from './skillRegistry'
import { beginSlashCommandWrite, captureSlashCommandWriteBasis, saveSlashCommandRecord, deleteSlashCommandRecord } from './slashCommandRevision'
import { AgentPluginError, getAgentPlugin, registerAgentPlugin, removeAgentPlugin, finishAgentPluginImport, finishRemoveAgentPlugin, type AgentPluginRecord } from './agentPlugins'
import { acquireSettingsMutation, captureSettingsLifecycle, assertSettingsLifecycle, withSettingsRecordReplacement, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'
import type { SkillBundleFile, SlashCommandRow } from '$lib/types/database'

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MAX_FILES = 2048, MAX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 2 * 1024 * 1024
const componentNames = new Set(['mcp.json', '.mcp.json', '.lsp.json', '.app.json', 'hooks', 'agents', 'commands', 'bin', 'scripts', 'monitors', 'output-styles'])
const executableFields = new Set(['mcpServers', 'mcp', 'hooks', 'agents', 'commands', 'lspServers', 'monitors', 'scripts', 'settings', 'userConfig', 'dependencies'])
const portableFields = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
const claudeFields = new Set(['name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'skills', 'metadata'])
const fail = (message: string) => new AgentPluginError('PLUGIN_IMPORT_INVALID', message, 400)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function jsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw fail(`${label} must contain a JSON object.`) }
  if (!object(value)) throw fail(`${label} must contain a JSON object.`)
  return value
}

/** Capture all admitted bytes before parsing or saving. Never re-open the external source in the skill importer. */
export async function capturePluginPackageFiles(source: string): Promise<Map<string, Buffer>> {
  if (!path.isAbsolute(source)) throw fail('Choose an absolute local plugin folder as seen by Batshit.')
  const root = path.resolve(source)
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail('The plugin folder must be a regular directory, without a symlink.')
  const resolvedRoot = await fs.realpath(root)
  const files = new Map<string, Buffer>()
  let total = 0, count = 0
  async function walk(directory: string, relative = '', depth = 0) {
    if (depth > 12) throw fail('The plugin folder is nested too deeply.')
    const before = await fs.lstat(directory)
    if (!before.isDirectory() || before.isSymbolicLink()) throw fail('Plugin symlinks and special files are not supported.')
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.DS_Store') continue
      const local = relative ? `${relative}/${entry.name}` : entry.name
      const parts = local.split('/')
      if (++count > MAX_FILES || entry.name.toLowerCase().startsWith('.env')) throw fail('The plugin contains too many files or includes a private env file.')
      if ((parts.length === 1 && componentNames.has(entry.name)) || (parts[0] === '.claude-plugin' && parts.length > 1 && local !== '.claude-plugin/plugin.json')) {
        throw fail(`Unsupported plugin component: ${local}. Only skills-only plugins can be imported.`)
      }
      if (parts.length === 1 && entry.isFile() && !['plugin.json', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'CHANGELOG.md'].includes(entry.name)) throw fail(`Unsupported root plugin file: ${local}.`)
      if (parts.length === 1 && entry.isDirectory() && !['skills', 'assets', '.claude-plugin'].includes(entry.name)) {
        throw fail(`Unsupported plugin directory: ${local}. Only skills-only plugins can be imported.`)
      }
      if (entry.name.startsWith('.') && parts[0] !== '.claude-plugin') throw fail(`Hidden plugin files are not imported: ${local}.`)
      const full = path.join(directory, entry.name)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw fail(`Plugin symlinks and special files are not supported: ${local}.`)
      const real = await fs.realpath(full)
      if (real !== resolvedRoot && !real.startsWith(`${resolvedRoot}${path.sep}`)) throw fail(`Plugin file escapes its folder: ${local}.`)
      if (stat.isDirectory()) { await walk(full, local, depth + 1); continue }
      if (stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (total += stat.size) > MAX_BYTES) throw fail(`Plugin file is linked or exceeds the import size limit: ${local}.`)
      const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat()
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) throw fail('The plugin changed while being read. Nothing was imported.')
        const bytes = await handle.readFile()
        const after = await handle.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes.length !== stat.size) throw fail('The plugin changed while being read. Nothing was imported.')
        files.set(local, bytes)
      } finally { await handle.close() }
    }
    const after = await fs.lstat(directory)
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) throw fail('The plugin changed while being read. Nothing was imported.')
  }
  await walk(root)
  const after = await fs.lstat(root)
  if (after.ino !== rootStat.ino || after.dev !== rootStat.dev) throw fail('The plugin folder changed while being read.')
  return files
}

export interface PreparedAgentPlugin {
  id: string
  name: string
  version: string
  description: string
  skills: Array<{ directory: string; definition: ImportedSkillDefinition }>
  warnings: string[]
}

export async function prepareAgentPlugin(source: string | Buffer): Promise<PreparedAgentPlugin> {
  const files = typeof source === 'string' ? await capturePluginArchiveFiles(source) : readPluginArchive(source)
  for (const name of files.keys()) {
    const parts = name.split('/')
    if (parts.some(part => !part || part.toLowerCase().startsWith('.env')) || parts.length > 14) throw fail('The plugin ZIP contains a private or unsupported path.')
    if (componentNames.has(parts[0]) || !['plugin.json', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'CHANGELOG.md', 'skills', '.claude-plugin'].includes(parts[0])) throw fail(`Unsupported plugin component: ${name}. Only skills-only plugins can be imported.`)
    if (parts[0] === '.claude-plugin' && name !== '.claude-plugin/plugin.json' || parts.some(part => part.startsWith('.') && part !== '.claude-plugin')) throw fail(`Unsupported hidden plugin file: ${name}.`)
  }
  const manifestBytes = files.get('plugin.json')
  if (!manifestBytes) throw fail('The selected folder has no root plugin.json.')
  const manifest = jsonObject(manifestBytes, 'plugin.json')
  if (manifest.$schema !== PLUGIN_SCHEMA) throw fail('This plugin must use the Agent Plugins 1.0.0 manifest schema.')
  if (typeof manifest.name !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(manifest.name) || /--|\.\./.test(manifest.name)) throw fail('The plugin name is invalid.')
  if (manifest.name === 'batshit') throw fail('The built-in Batshit plugin cannot be replaced by an import.')
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') throw fail(`Plugin ${field} must be text.`)
  }
  if (manifest.author !== undefined && (!object(manifest.author) || Object.entries(manifest.author).some(([key, value]) => !['name', 'email', 'url'].includes(key) || typeof value !== 'string'))) throw fail('Plugin author metadata is invalid.')
  if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some(value => typeof value !== 'string'))) throw fail('Plugin keywords must be a list of text values.')
  for (const field of executableFields) if (field in manifest) throw fail(`Unsupported plugin component: ${field}. Only skills are supported.`)
  const warnings = Object.keys(manifest).filter(key => !portableFields.has(key)).map(key => `Ignored unknown manifest field: ${key}.`)
  if (object(manifest.extensions)) {
    for (const [namespace, extension] of Object.entries(manifest.extensions)) {
      // Common portable OpenAI packages carry display metadata here; it is never executable.
      if (namespace !== 'com.openai' || !object(extension) || Object.keys(extension).some(key => key !== 'interface')) throw fail('Client extensions are not supported by skills-only plugin import.')
      if ('interface' in extension) warnings.push('Client-specific presentation metadata is ignored; Batshit imports the included skills.')
    }
  }
  if (manifest.extensions !== undefined && !object(manifest.extensions)) warnings.push('Ignored non-object extensions metadata.')
  const claudeBytes = files.get('.claude-plugin/plugin.json')
  if (claudeBytes) {
    const claude = jsonObject(claudeBytes, '.claude-plugin/plugin.json')
    if (claude.name !== manifest.name) throw fail('The portable and Claude plugin names must match.')
    for (const key of Object.keys(claude)) if (!claudeFields.has(key)) throw fail(`Unsupported Claude plugin component: ${key}.`)
    if (claude.skills !== undefined && !['./skills', './skills/'].includes(String(claude.skills))) throw fail('Only the standard skills/ folder is supported.')
  }
  const directories = [...new Set([...files.keys()].filter(file => file.startsWith('skills/')).map(file => file.split('/')[1]))].sort()
  if (!directories.length || directories.length > 32) throw fail('A plugin must contain between 1 and 32 skills.')
  const skills: PreparedAgentPlugin['skills'] = []
  for (const directory of directories) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory) || directory.length > 64) throw fail(`Invalid skill folder: ${directory}.`)
    const prefix = `skills/${directory}/`
    const markdown = files.get(`${prefix}SKILL.md`)
    if (!markdown) throw fail(`Skill ${directory} has no SKILL.md.`)
    const bundleFiles: SkillBundleFile[] = []
    for (const [file, bytes] of files) {
      if (!file.startsWith(prefix) || file === `${prefix}SKILL.md`) continue
      const relative = file.slice(prefix.length)
      const folder = relative.split('/')[0]
      if (!['references', 'assets', 'scripts', 'agents'].includes(folder)) throw fail(`Unsupported skill file: ${file}.`)
      // agents/openai.yaml is presentation metadata; it is not a Batshit execution source.
      if (folder === 'agents') {
        if (relative !== 'agents/openai.yaml') throw fail(`Unsupported agent component: ${file}.`)
        continue
      }
      bundleFiles.push({ path: relative, kind: folder === 'scripts' ? 'script' : folder === 'assets' ? 'asset' : 'reference', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length, sha256: hash(bytes) })
    }
    const definition = deriveSkillDefinition({ markdown: markdown.toString('utf8'), sourceRef: typeof source === 'string' ? path.join(source, 'skills', directory) : `uploaded-plugin:${manifest.name}/skills/${directory}`, sourceType: 'local', trustLevel: 'untrusted',
      hasScripts: bundleFiles.some(file => file.kind === 'script'), hasReferences: bundleFiles.some(file => file.kind === 'reference'), hasAssets: bundleFiles.some(file => file.kind === 'asset'), bundleFiles })
    if (definition.standardsStatus !== 'full' || definition.name !== directory) throw fail(`Skill ${directory} needs valid Agent Skills frontmatter with the same name as its folder.`)
    skills.push({ directory, definition })
  }
  return { id: manifest.name, name: manifest.name, version: String(manifest.version ?? ''), description: String(manifest.description ?? ''), skills,
    warnings: [...warnings, 'Imported skills are untrusted. Enabling this plugin does not grant tools or change token scopes.'] }
}

export async function importAgentPlugin(userId: string, source: string | Buffer): Promise<{ plugin: AgentPluginRecord; warnings: string[] }> {
  const lifecycle = captureSettingsLifecycle([])
  const prepared = await prepareAgentPlugin(source)
  return withSettingsRecordReplacement(`agent_plugin:${userId}:${prepared.id}`, () => importPreparedAgentPlugin(userId, prepared, lifecycle))
}

async function importPreparedAgentPlugin(userId: string, prepared: PreparedAgentPlugin, lifecycle: SettingsLifecycleSnapshot) {
  if (await getAgentPlugin(userId, prepared.id)) throw new AgentPluginError('PLUGIN_ALREADY_EXISTS', 'This plugin is already installed. Remove it before importing a replacement.')
  const namespace = hash(`${userId}\0${prepared.id}`).slice(0, 16)
  const members = prepared.skills.map(({ directory, definition }) => ({ directory, definition,
    commandId: `plugin_${namespace}_${directory}`, skillId: `plugin_${namespace}_${directory.replaceAll('-', '_')}` }))
  const preparation = beginSlashCommandWrite(userId)
  // The catalogue revision is captured before the complete collision read. Any later foreign writer refuses staging.
  await captureSlashCommandWriteBasis(preparation, members.map(member => member.commandId))
  const invocations = new Set(members.map(member => `/${prepared.id}:${member.directory}`.toLowerCase()))
  for (const key of await redis.execute(client => client.keys(`slash_command:${userId}:*`))) {
    const row = await redis.json.get(key) as SlashCommandRow | null
    if (!row || typeof row.id !== 'string' || row.user_id !== userId) throw fail('The saved command catalogue is unreadable. Nothing was imported.')
    if (invocations.has((row.invocation_pattern || `/${row.id}`).trim().toLowerCase())) throw new AgentPluginError('PLUGIN_INVOCATION_COLLISION', 'A command already uses one of this plugin’s invocations. No existing command was replaced.')
  }
  for (const member of members) {
    if (await redis.json.get(`slash_command:${userId}:${member.commandId}`) || await redis.json.get(`skill:${userId}:${member.skillId}`)) throw new AgentPluginError('PLUGIN_IMPORT_COLLISION', 'An existing or unfinished import owns this plugin skill. No existing skill was replaced.')
    try { await fs.lstat(path.join(getBatshitHomeDir(), 'skills', member.skillId)); throw new AgentPluginError('PLUGIN_IMPORT_COLLISION', 'An existing skill folder owns this import ID. No existing files were replaced.') }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  // A complete, access-off manifest owns interrupted work. Readers omit pending members; the user can remove the retained import.
  const installing = await registerAgentPlugin(userId, { id: prepared.id, name: prepared.name, description: prepared.description, version: prepared.version, builtIn: false, installing: true,
    skills: members.map(member => ({ commandId: member.commandId, skillId: member.skillId, name: member.definition.displayName || member.directory, invocation: `/${prepared.id}:${member.directory}` })),
    enabled_for_all_agents: false, enabled_agent_ids: [] }, lifecycle)
  for (const member of members) {
    const basis = await captureSlashCommandWriteBasis(preparation, [member.commandId])
    assertSettingsLifecycle(lifecycle)
    const lease = acquireSettingsMutation(lifecycle)
    const skillDirectory = path.join(getBatshitHomeDir(), 'skills', member.skillId)
    let metadataIssued = false
    let skill: Awaited<ReturnType<typeof upsertSkill>>
    try {
      await fs.mkdir(path.dirname(skillDirectory), { recursive: true })
      await fs.mkdir(skillDirectory)
      await fs.writeFile(path.join(skillDirectory, '.plugin-import-owner'), prepared.id, { flag: 'wx' })
      lease.check()
      metadataIssued = true
      skill = await upsertSkill({ userId, commandId: member.commandId, skill: { ...member.definition, id: member.skillId, isSystem: false, isActive: true,
        metadata: { ...member.definition.metadata, agentPluginId: prepared.id } } })
      lease.settle()
    } catch (error) {
      if (metadataIssued) { lease.unknown(); throw new AgentPluginError('PLUGIN_IMPORT_UNKNOWN', 'The skill import could not be confirmed. Its incomplete plugin was retained; refresh before another action.', 503, 'unknown') }
      lease.settle(); throw error
    }
    const now = new Date().toISOString()
    const command: SlashCommandRow = { id: member.commandId, user_id: userId, name: member.directory, displayName: skill.displayName || member.directory,
      description: skill.description, type: 'skill', skill_id: member.skillId, skill_source: 'local', skill_source_ref: skill.source_ref,
      plugin_id: prepared.id, invocation_pattern: `/${prepared.id}:${member.directory}`, enabled_for_all_agents: false, enabled_agent_ids: [],
      can_be_attached_to_agents: false, can_be_invoked_in_chat: true, is_active: true, is_system: false, trust_level: 'untrusted',
      created_at: now, updated_at: now }
    await saveSlashCommandRecord(userId, { record: command, mode: 'create' }, basis)
  }
  const plugin = await finishAgentPluginImport(userId, installing.id, installing.revision, lifecycle)
  return { plugin, warnings: prepared.warnings }
}

/** Keep the disabled cleanup manifest until every exact owned member is gone. */
export async function uninstallAgentPlugin(userId: string, pluginId: string, expectedRevision: string) {
  const lifecycle = captureSettingsLifecycle([])
  return withSettingsRecordReplacement(`agent_plugin:${userId}:${pluginId}`, () => removeOwnedPlugin(userId, pluginId, expectedRevision, lifecycle))
}

async function removeOwnedPlugin(userId: string, pluginId: string, expectedRevision: string, lifecycle: SettingsLifecycleSnapshot) {
  const plugin = await removeAgentPlugin(userId, pluginId, lifecycle, expectedRevision)
  if (!plugin) return
  const preparation = beginSlashCommandWrite(userId)
  const lease = acquireSettingsMutation(lifecycle)
  let skillDeletionIssued = false
  try {
    for (const member of plugin.skills) {
      lease.check()
      const basis = await captureSlashCommandWriteBasis(preparation, [member.commandId])
      const row = await redis.json.get(`slash_command:${userId}:${member.commandId}`) as SlashCommandRow | null
      const skill = await redis.json.get(`skill:${userId}:${member.skillId}`) as { metadata?: Record<string, string> } | null
      const skillDirectory = path.join(getBatshitHomeDir(), 'skills', member.skillId)
      let marker: string | null = null
      let directoryExists = false
      try {
        const directory = await fs.lstat(skillDirectory)
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new AgentPluginError('PLUGIN_REMOVE_OWNERSHIP', 'An unrecognized skill folder was preserved.', 503)
        directoryExists = true
        const markerHandle = await fs.open(path.join(skillDirectory, '.plugin-import-owner'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await markerHandle.stat()
          if (!stat.isFile() || stat.size > 64 || stat.nlink !== 1) throw new AgentPluginError('PLUGIN_REMOVE_OWNERSHIP', 'The imported skill ownership marker is unreadable.', 503)
          marker = await markerHandle.readFile('utf8')
        } finally { await markerHandle.close() }
      } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      if (row && (row.plugin_id !== pluginId || row.skill_id !== member.skillId) || skill && skill.metadata?.agentPluginId !== pluginId || marker !== null && marker !== pluginId) throw new AgentPluginError('PLUGIN_REMOVE_OWNERSHIP', 'Plugin access was removed, but changed skill ownership prevented file cleanup.', 503)
      if (directoryExists && marker !== pluginId) throw new AgentPluginError('PLUGIN_REMOVE_OWNERSHIP', 'Plugin access was removed, but an unrecognized skill folder was preserved.', 503)
      lease.check()
      await deleteSlashCommandRecord(userId, member.commandId, basis)
      skillDeletionIssued = true
      await deleteSkill(userId, member.skillId)
      skillDeletionIssued = false
    }
    lease.check()
    await finishRemoveAgentPlugin(userId, pluginId, plugin.revision, lifecycle)
    lease.settle()
  } catch (error) {
    // The tombstone is the durable retry owner. Issued unknown command writes retain their own custody.
    if (skillDeletionIssued) lease.unknown()
    else lease.settle()
    throw error
  }
}
