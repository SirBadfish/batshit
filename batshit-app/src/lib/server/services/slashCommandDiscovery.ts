import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import type { SlashCommandDescriptor, SlashCommandScope } from '$lib/types/slashCommands'
import { buildAgentProfileId } from '$lib/server/services/codexProfileManager'

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { timestamp: number; commands: SlashCommandDescriptor[] }>()

const HOME_DIR = os.homedir()
const BATSHIT_MANAGED_ROOT = path.join(HOME_DIR, '.batshit', 'agents')
const CODEX_DIR_NAME = '.codex'
const CLAUDE_DIR_NAME = '.claude'
const CLAUDE_PLUGIN_DIR_NAME = 'plugins'
const CLAUDE_MARKETPLACE_ROOT = path.join(HOME_DIR, '.claude', 'plugins', 'marketplaces')
const CLAUDE_CACHE_ROOT = path.join(HOME_DIR, '.claude', 'plugins', 'cache')
const CLAUDE_SETTINGS_PATH = path.join(HOME_DIR, '.claude', 'settings.json')

function getCache(key: string) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.commands
}

function setCache(key: string, commands: SlashCommandDescriptor[]) {
  cache.set(key, { timestamp: Date.now(), commands })
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn('[slashCommandDiscovery] Failed to read dir', dir, error)
    return []
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn('[slashCommandDiscovery] Failed to read file', filePath, error)
    return null
  }
}

function parseFrontmatterValue(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseFrontmatter(contents: string): { data: Record<string, any>; body: string } {
  if (!contents.startsWith('---')) {
    return { data: {}, body: contents }
  }

  const endIndex = contents.indexOf('\n---', 3)
  if (endIndex === -1) {
    return { data: {}, body: contents }
  }

  const raw = contents.slice(3, endIndex).trim()
  const body = contents.slice(endIndex + 4).trimStart()
  const data: Record<string, any> = {}

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sepIndex = trimmed.indexOf(':')
    if (sepIndex === -1) continue
    const key = trimmed.slice(0, sepIndex).trim()
    const value = trimmed.slice(sepIndex + 1).trim()
    data[key] = parseFrontmatterValue(value)
  }

  return { data, body }
}

async function readCommandMetadata(filePath: string) {
  const contents = await safeReadFile(filePath)
  if (!contents) return {}
  const { data } = parseFrontmatter(contents)
  const invocation = typeof data.invocation === 'string' ? normalizeInvocation(data.invocation) : undefined
  return {
    description: typeof data.description === 'string' ? data.description : undefined,
    argumentHint:
      typeof data['argument-hint'] === 'string'
        ? data['argument-hint']
        : typeof data.argumentHint === 'string'
          ? data.argumentHint
          : undefined,
    invocation: invocation && invocation !== '/' ? invocation : undefined
  }
}

function normalizeInvocation(invocation: string) {
  const trimmed = invocation.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function buildDescriptorId(source: SlashCommandDescriptor['source'], invocation: string) {
  return `${source}:${invocation}`
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await safeReadDir(dir)
  return entries.filter((entry) => entry.toLowerCase().endsWith('.md'))
}

async function readClaudePluginCommands(params: {
  pluginDir: string
  pluginName: string
  scope: SlashCommandScope
}): Promise<SlashCommandDescriptor[]> {
  const commandsDir = path.join(params.pluginDir, 'commands')
  const files = await listMarkdownFiles(commandsDir)
  const commands: SlashCommandDescriptor[] = []

  for (const file of files) {
    const commandName = path.basename(file, '.md')
    const invocation = normalizeInvocation(
      commandName === params.pluginName
        ? params.pluginName
        : `${params.pluginName}:${commandName}`
    )
    const metadata = await readCommandMetadata(path.join(commandsDir, file))
    commands.push({
      id: buildDescriptorId('claude', invocation),
      name: invocation.slice(1),
      invocation,
      description: metadata.description,
      argumentHint: metadata.argumentHint,
      source: 'claude',
      plugin: params.pluginName,
      scope: params.scope
    })
  }

  return commands
}

async function findClaudePluginDir(marketplace: string, pluginName: string): Promise<string | null> {
  const marketplaceDir = path.join(CLAUDE_MARKETPLACE_ROOT, marketplace, 'plugins', pluginName)
  try {
    const stat = await fs.stat(marketplaceDir)
    if (stat.isDirectory()) return marketplaceDir
  } catch {}

  const cacheRoot = path.join(CLAUDE_CACHE_ROOT, marketplace, pluginName)
  const versions = await safeReadDir(cacheRoot)
  if (versions.length === 0) return null
  const sorted = [...versions].sort().reverse()
  for (const version of sorted) {
    const candidate = path.join(cacheRoot, version)
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {}
  }
  return null
}

async function readClaudeProjectCommands(projectPath: string): Promise<SlashCommandDescriptor[]> {
  const commandsDir = path.join(projectPath, '.claude', 'commands')
  const files = await listMarkdownFiles(commandsDir)
  const commands: SlashCommandDescriptor[] = []

  for (const file of files) {
    const commandName = path.basename(file, '.md')
    const invocation = normalizeInvocation(commandName)
    const metadata = await readCommandMetadata(path.join(commandsDir, file))
    commands.push({
      id: buildDescriptorId('claude', invocation),
      name: invocation.slice(1),
      invocation,
      description: metadata.description,
      argumentHint: metadata.argumentHint,
      source: 'claude',
      plugin: 'project',
      scope: 'project'
    })
  }

  return commands
}

async function readCodexProjectCommands(projectPath: string): Promise<SlashCommandDescriptor[]> {
  const promptsDir = path.join(projectPath, '.codex', 'prompts')
  const files = await listMarkdownFiles(promptsDir)
  const commands: SlashCommandDescriptor[] = []

  for (const file of files) {
    const promptName = path.basename(file, '.md')
    const metadata = await readCommandMetadata(path.join(promptsDir, file))
    const invocation = metadata.invocation || normalizeInvocation(`prompts:${promptName}`)
    commands.push({
      id: buildDescriptorId('codex', invocation),
      name: invocation.slice(1),
      invocation,
      description: metadata.description,
      argumentHint: metadata.argumentHint,
      source: 'codex',
      scope: 'project'
    })
  }

  return commands
}

export async function discoverClaudeCommands(params: {
  scope: 'managed' | 'global'
  agentId?: string | null
  projectPath?: string | null
}): Promise<SlashCommandDescriptor[]> {
  const cacheKey = `claude:${params.scope}:${params.agentId ?? ''}:${params.projectPath ?? ''}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  const commands: SlashCommandDescriptor[] = []
  const seen = new Set<string>()

  if (params.projectPath) {
    const projectCommands = await readClaudeProjectCommands(params.projectPath)
    for (const command of projectCommands) {
      if (seen.has(command.invocation)) continue
      seen.add(command.invocation)
      commands.push(command)
    }
  }

  if (params.scope === 'managed') {
    if (params.agentId) {
      const profileId = buildAgentProfileId(params.agentId)
      const managedPluginsDir = path.join(BATSHIT_MANAGED_ROOT, profileId, CLAUDE_DIR_NAME, CLAUDE_PLUGIN_DIR_NAME)
      const pluginDirs = await safeReadDir(managedPluginsDir)
      for (const pluginName of pluginDirs) {
        const pluginDir = path.join(managedPluginsDir, pluginName)
        const pluginCommands = await readClaudePluginCommands({
          pluginDir,
          pluginName,
          scope: 'managed'
        })
        for (const command of pluginCommands) {
          if (seen.has(command.invocation)) continue
          seen.add(command.invocation)
          commands.push(command)
        }
      }
    }
    setCache(cacheKey, commands)
    return commands
  }

  const settingsRaw = await safeReadFile(CLAUDE_SETTINGS_PATH)
  let enabledPlugins: string[] = []
  if (settingsRaw) {
    try {
      const settings = JSON.parse(settingsRaw)
      const enabled = settings?.enabledPlugins && typeof settings.enabledPlugins === 'object'
        ? (settings.enabledPlugins as Record<string, any>)
        : {}
      enabledPlugins = Object.entries(enabled)
        .filter(([, value]) => Boolean(value))
        .map(([key]) => key)
    } catch (error) {
      console.warn('[slashCommandDiscovery] Failed to parse Claude settings.json', error)
    }
  }

  for (const pluginKey of enabledPlugins) {
    const [pluginName, marketplace] = pluginKey.split('@')
    if (!pluginName) continue
    const marketplaceName = marketplace || 'claude-code-plugins'
    const pluginDir = await findClaudePluginDir(marketplaceName, pluginName)
    if (!pluginDir) continue

    const pluginCommands = await readClaudePluginCommands({
      pluginDir,
      pluginName,
      scope: 'global'
    })

    for (const command of pluginCommands) {
      if (seen.has(command.invocation)) continue
      seen.add(command.invocation)
      commands.push(command)
    }
  }

  setCache(cacheKey, commands)
  return commands
}

export async function discoverCodexCommands(params: {
  scope: 'managed' | 'global'
  agentId?: string | null
  projectPath?: string | null
}): Promise<SlashCommandDescriptor[]> {
  const cacheKey = `codex:${params.scope}:${params.agentId ?? ''}:${params.projectPath ?? ''}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  const commands: SlashCommandDescriptor[] = []
  const seen = new Set<string>()

  if (params.projectPath) {
    const projectCommands = await readCodexProjectCommands(params.projectPath)
    for (const command of projectCommands) {
      if (seen.has(command.invocation)) continue
      seen.add(command.invocation)
      commands.push(command)
    }
  }

  let codexHome = path.join(HOME_DIR, CODEX_DIR_NAME)
  if (params.scope === 'managed') {
    if (!params.agentId) return []
    const profileId = buildAgentProfileId(params.agentId)
    codexHome = path.join(BATSHIT_MANAGED_ROOT, profileId, CODEX_DIR_NAME)
  }

  const promptsDir = path.join(codexHome, 'prompts')
  const files = await listMarkdownFiles(promptsDir)

  for (const file of files) {
    const promptName = path.basename(file, '.md')
    const metadata = await readCommandMetadata(path.join(promptsDir, file))
    const invocation = metadata.invocation || normalizeInvocation(`prompts:${promptName}`)
    if (seen.has(invocation)) continue
    seen.add(invocation)
    commands.push({
      id: buildDescriptorId('codex', invocation),
      name: invocation.slice(1),
      invocation,
      description: metadata.description,
      argumentHint: metadata.argumentHint,
      source: 'codex',
      scope: params.scope
    })
  }

  setCache(cacheKey, commands)
  return commands
}
