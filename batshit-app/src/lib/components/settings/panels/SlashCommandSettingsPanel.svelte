<script lang="ts">
import { onDestroy, onMount } from 'svelte'
import { toast } from '$lib/components/ui/sonner/settings-toast'
import * as Card from '$lib/components/ui/card'
import { Button } from '$lib/components/ui/button'
import { Input } from '$lib/components/ui/input'
import { Label } from '$lib/components/ui/label'
import * as Select from '$lib/components/ui/select'
import * as Collapsible from '$lib/components/ui/collapsible'
import * as Switch from '$lib/components/ui/switch'
import * as Tabs from '$lib/components/ui/tabs'
import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
import PortableSkillsSettingsPanel from './PortableSkillsSettingsPanel.svelte'
import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
import IconPicker from '$lib/components/icons/IconPicker.svelte'
import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
import { confirmDialog } from '$lib/stores/confirmDialog'
import {
  DEFAULT_PROMPT_ICON_REF,
  DEFAULT_SKILL_ICON_REF
} from '$lib/icons/iconCatalog'
import { normalizeIconRef } from '$lib/icons/iconLegacy'
import type { CustomIconRecord, IconLibraryPrefs, IconRef } from '$lib/icons/iconTypes'
import { iconLibraryService } from '$lib/services/iconLibraryService'
import { debounce } from '$lib/utils/debounce'
import { dispatchSlashCommandsUpdated } from '$lib/utils/liveSettingsEvents'
import {
  Sparkles,
  Plus,
  Trash2,
  Save,
  RefreshCw,
  FileText,
  ChevronDown,
  KeyRound,
  Loader2,
  FolderOpen
} from '@lucide/svelte'
import type {
  AgentRow,
  SkillBundleFile,
  SkillBundleManifest,
  SkillSourceRow,
  SlashCommandRow
} from '$lib/types/database'
import type { SlashCommandDescriptor } from '$lib/types/slashCommands'

interface Props {
  data?: {
    user?: {
      id: string
      email?: string | null
    } | null
  } | null
}

type CommandType = 'prompt' | 'skill'
type SkillsPromptsTab = 'skills' | 'skill-sources' | 'prompts' | 'portable-skills'

type SkillSource = 'custom' | 'system' | 'github' | 'git' | 'local' | 'url'
type ImportSourceType = 'github' | 'url' | 'git' | 'local'
type SkillStandardsStatus = 'full' | 'degraded'

type TrustLevel = 'trusted' | 'untrusted'

interface CliCollisionEntry extends SlashCommandDescriptor {
  agentId?: string
  agentName?: string
}

interface FormState {
  id: string
  name: string
  displayName: string
  type: CommandType
  invocation_pattern: string
  iconRef: IconRef
  is_active: boolean
  prompt_template: string
  argsCsv: string
  skillId: string
  skillName: string
  skillDescription: string
  skillMarkdown: string
  skillSource: SkillSource
  skillSourceRef: string
  dependenciesCsv: string
  skillLicense: string
  skillCompatibility: string
  skillMetadataJson: string
  skillAllowedToolsCsv: string
  skillStandardsStatus: SkillStandardsStatus
  skillStandardsIssues: string[]
  skillBundleManifest: SkillBundleManifest | null
  skillBundleFiles: SkillBundleFile[]
  trustLevel: TrustLevel
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
  enabledForAllAgents: boolean
  enabledAgentIds: string[]
}

let { data = null }: Props = $props()

let slashCommands = $state<SlashCommandRow[]>([])
let loading = $state(true)
let bootstrapping = $state(false)
let saving = $state(false)
let deleting = $state(false)
let activeSkillsPromptsTab = $state<SkillsPromptsTab>('skills')
let selectedCommandId = $state<string | null>(null)
let isEditing = $state(false)
let showEditor = $state(false)
let loadingAgents = $state(false)
let commandSaveState = $state<'idle' | 'saving' | 'saved'>('idle')
let commandSaveError = $state<string | null>(null)
let persistedCommandSignature = $state<string | null>(null)
let promptTemplateEditorOpen = $state(false)
let promptTemplateEditSession = $state(0)
let commandSaveResetTimeout: ReturnType<typeof setTimeout> | null = null
let skillDetailsOpen = $state(false)
let deleteDisclosureOpen = $state(false)
let systemSkillsOpen = $state(true)
let systemPromptsOpen = $state(true)
let yourSkillsOpen = $state(true)
let yourPromptsOpen = $state(true)
let customIcons = $state<CustomIconRecord[]>([])
let iconLibraryPrefs = $state<IconLibraryPrefs>({ favorites: [], recents: [] })
let iconUploadInput = $state<HTMLInputElement | null>(null)
let iconUploading = $state(false)

let importingSkill = $state(false)
let importSourceType = $state<ImportSourceType>('github')
let importSource = $state('')
let importSkillPath = $state('')
let importInstallCommand = $state('')
let importWarnings = $state<string[]>([])
let cliInvocationIndex = $state<Record<string, CliCollisionEntry[]>>({})
let skillSources = $state<SkillSourceRow[]>([])
let skillSourcesLoading = $state(false)
let skillSourceSaving = $state(false)
let skillSourceScanningId = $state<string | null>(null)
let skillSourceDeletingId = $state<string | null>(null)
let selectedSkillSourceId = $state<string | null>(null)
let showSkillSourceForm = $state(false)
let skillSourceLabel = $state('')
let skillSourcePath = $state('')
let skillSourceTrustLevel = $state<TrustLevel>('untrusted')
let skillSourceEnableForAllAgents = $state(false)
let skillSourceWarnings = $state<string[]>([])

const COMMAND_AUTOSAVE_DEBOUNCE_MS = 650

const emptyForm = (): FormState => ({
  id: '',
  name: '',
  displayName: '',
  type: 'prompt',
  invocation_pattern: '',
  iconRef: DEFAULT_PROMPT_ICON_REF,
  is_active: true,
  prompt_template: '',
  argsCsv: '',
  skillId: '',
  skillName: '',
  skillDescription: '',
  skillMarkdown: '# Skill\n\nDescribe what this skill does and how to run it safely.',
  skillSource: 'custom',
  skillSourceRef: '',
  dependenciesCsv: '',
  skillLicense: '',
  skillCompatibility: '',
  skillMetadataJson: '',
  skillAllowedToolsCsv: '',
  skillStandardsStatus: 'degraded',
  skillStandardsIssues: [],
  skillBundleManifest: null,
  skillBundleFiles: [],
  trustLevel: 'untrusted',
  hasScripts: false,
  hasReferences: false,
  hasAssets: false,
  enabledForAllAgents: false,
  enabledAgentIds: []
})

let form = $state<FormState>(emptyForm())

const sortedCommands = $derived.by(() => {
  return [...slashCommands].sort((a, b) => {
    if ((a.is_system ? 1 : 0) !== (b.is_system ? 1 : 0)) {
      return (b.is_system ? 1 : 0) - (a.is_system ? 1 : 0)
    }
    return (a.displayName || a.name).localeCompare(b.displayName || b.name)
  })
})

const selectedCommand = $derived.by(() =>
  selectedCommandId ? slashCommands.find((command) => command.id === selectedCommandId) ?? null : null
)

const systemCommands = $derived.by(() => sortedCommands.filter((command) => command.is_system === true))
const userCommands = $derived.by(() => sortedCommands.filter((command) => command.is_system !== true))
const systemSkillCommands = $derived.by(() => systemCommands.filter((command) => command.type === 'skill'))
const systemPromptCommands = $derived.by(() => systemCommands.filter((command) => command.type === 'prompt'))
const userSkillCommands = $derived.by(() => userCommands.filter((command) => command.type === 'skill'))
const userPromptCommands = $derived.by(() => userCommands.filter((command) => command.type === 'prompt'))
const skillCommands = $derived.by(() => [...systemSkillCommands, ...userSkillCommands])
const promptCommands = $derived.by(() => [...systemPromptCommands, ...userPromptCommands])
const sortedSkillSources = $derived.by(() =>
  [...skillSources].sort((a, b) => a.label.localeCompare(b.label))
)
const selectedSkillSource = $derived.by(() =>
  selectedSkillSourceId
    ? sortedSkillSources.find((source) => source.id === selectedSkillSourceId) ?? null
    : null
)
const isNewSkillForm = $derived.by(() => form.type === 'skill' && !isEditing)
const isEditingSystemCommand = $derived.by(() => Boolean(isEditing && selectedCommand?.is_system === true))

const untrustedSkillWarning = $derived.by(() => {
  if (form.type !== 'skill') return null
  if (form.trustLevel === 'trusted' && !form.hasScripts) return null

  if (form.hasScripts) {
    return 'This skill is marked as containing scripts. Only enable it from trusted sources.'
  }

  return 'This skill is marked untrusted. Review the SKILL.md content before enabling broad usage.'
})

const skillBundleSummary = $derived.by(() => {
  if (form.type !== 'skill') return null

  const bundleFiles = Array.isArray(form.skillBundleFiles) ? form.skillBundleFiles : []
  const manifest = form.skillBundleManifest
  const countByKind = {
    script: 0,
    reference: 0,
    asset: 0
  }

  for (const file of bundleFiles) {
    if (!file || typeof file !== 'object') continue
    const kind = (file as SkillBundleFile).kind
    if (kind === 'script') countByKind.script += 1
    else if (kind === 'reference') countByKind.reference += 1
    else if (kind === 'asset') countByKind.asset += 1
  }

  const scriptCount = manifest?.script_count ?? countByKind.script
  const referenceCount = manifest?.reference_count ?? countByKind.reference
  const assetCount = manifest?.asset_count ?? countByKind.asset
  const totalCount = manifest?.file_count ?? bundleFiles.length
  const sourceLabel = manifest ? 'manifest-backed' : bundleFiles.length > 0 ? 'bundle-files-backed' : 'flags-only'

  return {
    scriptCount,
    referenceCount,
    assetCount,
    totalCount,
    sourceLabel,
    hasManifest: Boolean(manifest?.checksum)
  }
})

const skillCompatibilityNotice = $derived.by(() => {
  if (form.type !== 'skill') return null
  const standardsIssues = form.skillStandardsIssues.filter((issue) => issue.trim().length > 0)
  const isFull = form.skillStandardsStatus === 'full'
  const title = isFull ? 'Compatibility status: full support' : 'Compatibility status: degraded'
  const summary = isFull
    ? 'This skill matches Batshit standards for this source path.'
    : 'This skill loaded with reduced compatibility. Review the notes below before relying on every feature.'

  return {
    tone: isFull ? 'success' : 'warning',
    title,
    summary,
    issues: standardsIssues
  }
})

const skillGuidanceLines = $derived.by(() => {
  if (form.type !== 'skill') return []

  const lines: string[] = []
  const dependencies = parseDependenciesCsv(form.dependenciesCsv).map((dependency) => dependency.id)
  const bundleSummary = skillBundleSummary

  if (form.trustLevel !== 'trusted') {
    lines.push('This skill is marked untrusted, so verify source and intent before enabling it broadly.')
  }

  if (form.hasScripts || (bundleSummary?.scriptCount ?? 0) > 0) {
    lines.push(
      'Scripts never run automatically. Any script run still goes through normal Batshit bash safety and approval boundaries.'
    )
  }

  if ((bundleSummary?.referenceCount ?? 0) > 0) {
    lines.push('Reference files load on demand while the skill is active, which keeps normal prompts smaller.')
  }

  if (dependencies.length > 0) {
    lines.push(`This skill expects these integrations: ${dependencies.join(', ')}.`)
  }

  return lines
})

const normalizedInvocation = $derived.by(() =>
  normalizeInvocation(form.invocation_pattern || `/${form.name}`)
)

const invocationCliCollisions = $derived.by(() => {
  const key = normalizedInvocation
  if (!key) return []
  return cliInvocationIndex[key] ?? []
})

const invocationBatshitCollisions = $derived.by(() => {
  const key = normalizedInvocation
  if (!key) return []
  return slashCommands.filter((command) => {
    if (selectedCommandId && command.id === selectedCommandId) return false
    return normalizeBatshitInvocation(command) === key
  })
})

function getDefaultCommandIconRef(type: CommandType) {
  return type === 'skill' ? DEFAULT_SKILL_ICON_REF : DEFAULT_PROMPT_ICON_REF
}

function getCommandIconRef(command: SlashCommandRow) {
  return normalizeIconRef(command.icon_ref ?? command.icon, getDefaultCommandIconRef(command.type))
}

async function loadIconLibrary() {
  try {
    const snapshot = await iconLibraryService.list()
    customIcons = snapshot.icons
    iconLibraryPrefs = snapshot.prefs
  } catch (error) {
    console.error('Failed to load icon library:', error)
  }
}

function requestIconUpload() {
  iconUploadInput?.click()
}

async function handleIconUpload(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  iconUploading = true
  try {
    const icon = await iconLibraryService.upload(file)
    customIcons = [icon, ...customIcons.filter((entry) => entry.id !== icon.id)]
    form.iconRef = { kind: 'custom', iconId: icon.id }
    iconLibraryPrefs = await iconLibraryService.addRecent(form.iconRef, iconLibraryPrefs)
    toast.success('Icon added to your library.')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to upload icon.')
  } finally {
    iconUploading = false
    input.value = ''
  }
}

onMount(async () => {
  await Promise.all([refreshPanelData(), loadIconLibrary()])
})

onDestroy(() => {
  clearCommandSaveResetTimeout()
})

$effect(() => {
  if (sortedSkillSources.length === 0) {
    selectedSkillSourceId = null
    return
  }

  if (!selectedSkillSourceId || !sortedSkillSources.some((source) => source.id === selectedSkillSourceId)) {
    selectedSkillSourceId = sortedSkillSources[0]?.id ?? null
  }
})

$effect(() => {
  const activeTab = activeSkillsPromptsTab
  const selectedType = selectedCommand?.type

  if (activeTab === 'skills' && selectedType === 'prompt') {
    hideEditor()
  } else if (activeTab === 'prompts' && selectedType === 'skill') {
    hideEditor()
  }
})

function clearCommandSaveResetTimeout() {
  if (commandSaveResetTimeout) {
    clearTimeout(commandSaveResetTimeout)
    commandSaveResetTimeout = null
  }
}

function resetCommandSaveStatus() {
  clearCommandSaveResetTimeout()
  commandSaveState = 'idle'
  commandSaveError = null
}

function markCommandSaved() {
  clearCommandSaveResetTimeout()
  commandSaveState = 'saved'
  commandSaveError = null
  commandSaveResetTimeout = setTimeout(() => {
    commandSaveState = 'idle'
    commandSaveResetTimeout = null
  }, 1800)
}

function normalizeInvocation(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function getItemLabel(type: CommandType | null | undefined) {
  return type === 'skill' ? 'Skill' : 'Prompt'
}

function normalizeBatshitInvocation(command: SlashCommandRow) {
  const fromPattern = command.invocation_pattern?.trim()
  const fallback = command.id || command.name
  return normalizeInvocation(fromPattern && fromPattern.length > 0 ? fromPattern : `/${fallback}`)
}

function normalizeAgentIds(input: string[]) {
  return Array.from(
    new Set(
      input
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )
}

function formatScopeLabel(scope: SlashCommandDescriptor['scope']) {
  if (scope === 'project') return 'project'
  if (scope === 'managed') return 'managed'
  if (scope === 'global') return 'global'
  return 'unknown'
}

function formatSourceLabel(source: SlashCommandDescriptor['source']) {
  if (source === 'codex') return 'Codex'
  if (source === 'claude') return 'Claude'
  return 'Batshit'
}

function formatSkillSourceTrust(source: SkillSourceRow | null) {
  if (!source?.trust_level || source.trust_level === 'untrusted') return 'Untrusted'
  return 'Trusted'
}

function formatSkillSourceAccess(source: SkillSourceRow | null) {
  if (!source) return 'Selected Agents'
  if (source.enabled_for_all_agents === true) return 'All Agents'
  const agentCount = Array.isArray(source.enabled_agent_ids) ? source.enabled_agent_ids.length : 0
  if (agentCount > 0) return `${agentCount} Selected`
  return 'Selected Agents'
}

function formatSkillSourceScan(source: SkillSourceRow | null) {
  if (!source?.last_scanned_at) return 'Never scanned'
  return new Date(source.last_scanned_at).toLocaleString()
}

function sanitizeIdentifier(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/[-_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function parametersToCsv(command: SlashCommandRow) {
  return (command.parameters ?? [])
    .map((param) => {
      const requiredSuffix = param.required ? '*' : ''
      const defaultSuffix = param.default !== undefined ? `=${String(param.default)}` : ''
      return `${param.name}${requiredSuffix}${defaultSuffix}`
    })
    .join(', ')
}

function dependenciesToCsv(command: SlashCommandRow) {
  return (command.skill_dependencies ?? []).map((dep) => dep.id).join(', ')
}

function parseArgsCsv(csv: string) {
  if (!csv.trim()) return []
  return csv
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [rawName, ...rest] = entry.split('=')
      const required = rawName.endsWith('*')
      const name = sanitizeIdentifier(required ? rawName.slice(0, -1) : rawName)
      return {
        name,
        type: 'string' as const,
        required,
        default: rest.length ? rest.join('=') : undefined
      }
    })
    .filter((entry) => entry.name.length > 0)
}

function parseDependenciesCsv(csv: string) {
  if (!csv.trim()) return []
  return Array.from(
    new Set(
      csv
        .split(',')
        .map((entry) => sanitizeIdentifier(entry))
        .filter((entry) => entry.length > 0)
    )
  ).map((id) => ({ id, required: true }))
}

function parseAllowedToolsCsv(csv: string) {
  if (!csv.trim()) return []
  return Array.from(
    new Set(
      csv
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  )
}

function parseSkillMetadataJson(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const output: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = key.trim()
      if (!normalizedKey) continue
      const normalizedValue = String(value ?? '').trim()
      if (!normalizedValue) continue
      output[normalizedKey] = normalizedValue
    }
    return Object.keys(output).length > 0 ? output : undefined
  } catch {
    return undefined
  }
}

function buildSkillMetadataPayload(formState: FormState): Record<string, string> | undefined {
  const metadata = parseSkillMetadataJson(formState.skillMetadataJson) ?? {}
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function buildPayloadFromForm(
  formState: FormState,
  options?: {
    editing?: boolean
    selectedCommandType?: CommandType | null
    systemCommand?: SlashCommandRow | null
  }
) {
  const type = options?.editing ? (options?.selectedCommandType ?? formState.type) : formState.type
  const invocation = normalizeInvocation(formState.invocation_pattern || `/${formState.name}`)
  const enabledAgentIds = normalizeAgentIds(formState.enabledAgentIds)
  const isSystemCommand = options?.editing === true && options?.systemCommand?.is_system === true

  if (isSystemCommand) {
    const payload: Record<string, unknown> = {
      is_active: formState.is_active,
      enabled_for_all_agents: formState.enabledForAllAgents,
      enabled_agent_ids: enabledAgentIds,
      can_be_attached_to_agents: formState.enabledForAllAgents || enabledAgentIds.length > 0
    }

    if (type === 'skill') {
      payload.skill = {
        trustLevel: formState.trustLevel
      }
    }

    return payload
  }

  const payload: Record<string, unknown> = {
    id: formState.id.trim() || undefined,
    name: formState.name.trim(),
    displayName: formState.displayName.trim() || formState.name.trim(),
    description: type === 'skill' ? formState.skillDescription.trim() : '',
    invocation_pattern: invocation,
    icon_ref: formState.iconRef,
    icon: null,
    is_active: formState.is_active,
    parameters: parseArgsCsv(formState.argsCsv),
    enabled_for_all_agents: formState.enabledForAllAgents,
    enabled_agent_ids: enabledAgentIds,
    can_be_attached_to_agents: formState.enabledForAllAgents || enabledAgentIds.length > 0
  }

  if (!options?.editing) {
    payload.type = type
  }

  if (type === 'prompt') {
    payload.prompt_template = formState.prompt_template
  }

  if (type === 'skill') {
    const skillId = formState.skillId.trim() || formState.id.trim() || formState.name.trim()
    const skillName =
      formState.skillName.trim() || formState.displayName.trim() || formState.name.trim()
    const skillMetadata = buildSkillMetadataPayload(formState)

    payload.skill = options?.editing
      ? {
          id: skillId,
          name: skillName,
          trustLevel: formState.trustLevel,
          metadata: skillMetadata
        }
      : {
          id: skillId,
          name: skillName,
          description: formState.skillDescription.trim() || undefined,
          markdown: formState.skillMarkdown.trim() ? formState.skillMarkdown : undefined,
          source: formState.skillSource,
          sourceRef: formState.skillSourceRef.trim() || undefined,
          dependencies: parseDependenciesCsv(formState.dependenciesCsv),
          license: formState.skillLicense.trim() || undefined,
          compatibility: formState.skillCompatibility.trim() || undefined,
          metadata: skillMetadata,
          allowedTools: parseAllowedToolsCsv(formState.skillAllowedToolsCsv),
          standardsStatus: formState.skillStandardsStatus,
          standardsIssues: formState.skillStandardsIssues,
          trustLevel: formState.trustLevel,
          hasScripts: formState.hasScripts,
          hasReferences: formState.hasReferences,
          hasAssets: formState.hasAssets,
          bundleManifest: formState.skillBundleManifest ?? undefined,
          bundleFiles: formState.skillBundleFiles
        }
  }

  return payload
}

function buildPayload() {
  return buildPayloadFromForm(form, {
    editing: isEditing,
    selectedCommandType: selectedCommand?.type ?? form.type,
    systemCommand: selectedCommand ?? null
  })
}

function buildPersistedCommandSignature(
  formState: FormState,
  options: { editing: boolean; selectedCommandType?: CommandType | null; systemCommand?: SlashCommandRow | null }
) {
  return JSON.stringify(buildPayloadFromForm(formState, options))
}

function canAutosaveCurrentCommand(formState: FormState): boolean {
  const effectiveType = selectedCommand?.type ?? formState.type
  if (!formState.name.trim()) return false
  if (effectiveType === 'prompt' && !formState.prompt_template.trim()) return false
  return true
}

function selectCommand(command: SlashCommandRow) {
  activeSkillsPromptsTab = command.type === 'skill' ? 'skills' : 'prompts'
  selectedCommandId = command.id
  isEditing = true
  showEditor = true
  resetCommandSaveStatus()
  deleteDisclosureOpen = false
  skillDetailsOpen = false
  importWarnings = []
  const commandSkillMetadata =
    command.skill_metadata && typeof command.skill_metadata === 'object' && !Array.isArray(command.skill_metadata)
      ? (command.skill_metadata as Record<string, unknown>)
      : {}
  const nextForm: FormState = {
    id: command.id,
    name: command.name,
    displayName: command.displayName || command.name,
    type: command.type,
    invocation_pattern: command.invocation_pattern || `/${command.id}`,
    iconRef: getCommandIconRef(command),
    is_active: command.is_active !== false,
    prompt_template: command.prompt_template || '',
    argsCsv: parametersToCsv(command),
    skillId: command.skill_id || command.id,
    skillName: command.displayName || command.name,
    skillDescription: command.skill_summary || command.description || '',
    skillMarkdown: '',
    skillSource: command.skill_source || 'custom',
    skillSourceRef: command.skill_source_ref || '',
    dependenciesCsv: dependenciesToCsv(command),
    skillLicense: command.skill_license || '',
    skillCompatibility: command.skill_compatibility || '',
    skillMetadataJson:
      Object.keys(commandSkillMetadata).length > 0
        ? JSON.stringify(commandSkillMetadata, null, 2)
        : '',
    skillAllowedToolsCsv: Array.isArray(command.skill_allowed_tools) ? command.skill_allowed_tools.join(', ') : '',
    skillStandardsStatus: command.skill_standards_status || 'degraded',
    skillStandardsIssues: Array.isArray(command.skill_standards_issues) ? command.skill_standards_issues : [],
    skillBundleManifest:
      command.skill_bundle_manifest && typeof command.skill_bundle_manifest === 'object'
        ? command.skill_bundle_manifest
        : null,
    skillBundleFiles: Array.isArray(command.skill_bundle_files)
      ? command.skill_bundle_files
      : [],
    trustLevel: command.trust_level || 'untrusted',
    hasScripts: command.has_scripts === true,
    hasReferences: command.has_references === true,
    hasAssets: command.has_assets === true,
    enabledForAllAgents: command.enabled_for_all_agents === true,
    enabledAgentIds: Array.isArray(command.enabled_agent_ids)
      ? normalizeAgentIds(command.enabled_agent_ids.map((value) => String(value)))
      : []
  }
  form = nextForm
  persistedCommandSignature = buildPersistedCommandSignature(nextForm, {
    editing: true,
    selectedCommandType: command.type,
    systemCommand: command
  })
}

function openCreateForm(type: CommandType = 'prompt') {
  activeSkillsPromptsTab = type === 'skill' ? 'skills' : 'prompts'
  selectedCommandId = null
  isEditing = false
  showEditor = true
  resetCommandSaveStatus()
  persistedCommandSignature = null
  deleteDisclosureOpen = false
  skillDetailsOpen = false
  importWarnings = []
  form = emptyForm()
  form.type = type
  form.iconRef = getDefaultCommandIconRef(type)
}

function openCreatePromptForm() {
  openCreateForm('prompt')
}

function openCreateSkillForm() {
  openCreateForm('skill')
}

function hideEditor() {
  selectedCommandId = null
  isEditing = false
  showEditor = false
  resetCommandSaveStatus()
  persistedCommandSignature = null
  deleteDisclosureOpen = false
  skillDetailsOpen = false
  importWarnings = []
  form = emptyForm()
}

async function loadSlashCommands() {
  try {
    loading = true
    const response = await fetch('/api/slash-commands')
    const payload = await response.json()
    slashCommands = Array.isArray(payload.slashCommands) ? payload.slashCommands : []

    if (selectedCommandId) {
      const nextSelection = slashCommands.find((command) => command.id === selectedCommandId)
      if (nextSelection) {
        selectCommand(nextSelection)
      } else {
        hideEditor()
      }
    }
  } catch (error) {
    console.error('Failed to load slash commands:', error)
    toast.error('Failed to load Skills and Prompts')
  } finally {
    loading = false
  }
}

async function loadAgentsAndCliInvocations() {
  try {
    loadingAgents = true
    const agentsResponse = await fetch('/api/agents')
    const agentsPayload = await agentsResponse.json()
    const rawAgents = Array.isArray(agentsPayload?.agents) ? agentsPayload.agents : []
    const agents = rawAgents
      .map((agent: AgentRow) => ({
        id: String(agent.id ?? '').trim(),
        displayName: String(agent.displayName ?? agent.id ?? '').trim()
      }))
      .filter((agent: { id: string; displayName: string }) => agent.id.length > 0)
      .sort((a: { displayName: string }, b: { displayName: string }) =>
        a.displayName.localeCompare(b.displayName)
      )

    const requests: Array<{
      provider: 'codex' | 'claude'
      scope: 'managed' | 'global'
      agentId?: string
      agentName?: string
    }> = [
      { provider: 'codex', scope: 'global' },
      { provider: 'claude', scope: 'global' }
    ]

    for (const agent of agents) {
      requests.push({
        provider: 'codex',
        scope: 'managed',
        agentId: agent.id,
        agentName: agent.displayName
      })
      requests.push({
        provider: 'claude',
        scope: 'managed',
        agentId: agent.id,
        agentName: agent.displayName
      })
    }

    const index: Record<string, CliCollisionEntry[]> = {}

    await Promise.all(
      requests.map(async (request) => {
        try {
          const params = new URLSearchParams()
          params.set('provider', request.provider)
          params.set('scope', request.scope)
          if (request.agentId) params.set('agentId', request.agentId)
          const response = await fetch(`/api/slash-commands/cli?${params.toString()}`)
          const payload = await response.json()
          const commands = Array.isArray(payload?.commands) ? payload.commands : []
          for (const command of commands) {
            const invocation = normalizeInvocation(String(command?.invocation ?? ''))
            if (!invocation) continue
            const entry: CliCollisionEntry = {
              id: String(command.id ?? `${request.provider}:${invocation}`),
              name: String(command.name ?? invocation.slice(1)),
              invocation,
              description: typeof command.description === 'string' ? command.description : undefined,
              source: request.provider,
              scope: request.scope,
              plugin: typeof command.plugin === 'string' ? command.plugin : undefined,
              argumentHint:
                typeof command.argumentHint === 'string'
                  ? command.argumentHint
                  : typeof command.argument_hint === 'string'
                    ? command.argument_hint
                    : undefined,
              agentId: request.agentId,
              agentName: request.agentName
            }

            const existing = index[invocation] ?? []
            if (!existing.some((candidate) =>
              candidate.source === entry.source &&
              candidate.scope === entry.scope &&
              (candidate.agentId ?? '') === (entry.agentId ?? '') &&
              candidate.id === entry.id
            )) {
              existing.push(entry)
              index[invocation] = existing
            }
          }
        } catch (error) {
          console.warn('Failed to load CLI commands for collision index', request, error)
        }
      })
    )

    cliInvocationIndex = index
  } catch (error) {
    console.error('Failed to load agents/CLI collision index', error)
    cliInvocationIndex = {}
  } finally {
    loadingAgents = false
  }
}

async function refreshPanelData() {
  await Promise.all([loadSlashCommands(), loadAgentsAndCliInvocations(), loadSkillSources()])
}

async function loadSkillSources() {
  try {
    skillSourcesLoading = true
    const response = await fetch('/api/skill-sources')
    const payload = await response.json()
    skillSources = Array.isArray(payload.skillSources) ? payload.skillSources : []
  } catch (error) {
    console.error('Failed to load skill sources:', error)
    toast.error('Failed to load skill sources')
  } finally {
    skillSourcesLoading = false
  }
}

function replaceSkillSource(source: SkillSourceRow) {
  const existing = skillSources.filter((entry) => entry.id !== source.id)
  skillSources = [...existing, source].sort((a, b) => a.label.localeCompare(b.label))
}

function resetSkillSourceForm() {
  skillSourceLabel = ''
  skillSourcePath = ''
  skillSourceTrustLevel = 'untrusted'
  skillSourceEnableForAllAgents = false
}

function openSkillSourceForm() {
  showSkillSourceForm = true
  skillSourceWarnings = []
}

function closeSkillSourceForm() {
  showSkillSourceForm = false
  resetSkillSourceForm()
}

async function addSkillSource() {
  if (!skillSourcePath.trim()) {
    toast.error('Skill source folder path is required')
    return
  }

  try {
    skillSourceSaving = true
    skillSourceWarnings = []
    const response = await fetch('/api/skill-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: skillSourceLabel.trim() || undefined,
        rootPath: skillSourcePath.trim(),
        trustLevel: skillSourceTrustLevel,
        enabledForAllAgents: skillSourceEnableForAllAgents,
        scope: 'global',
        scan: true
      })
    })
    const result = await response.json()

    if (!response.ok) {
      toast.error(result.error || 'Failed to add skill source')
      return
    }

    if (result.skillSource) {
      replaceSkillSource(result.skillSource as SkillSourceRow)
      selectedSkillSourceId = (result.skillSource as SkillSourceRow).id
    }
    skillSourceWarnings = Array.isArray(result.warnings)
      ? result.warnings.map((warning: unknown) => String(warning)).filter(Boolean)
      : []
    resetSkillSourceForm()
    showSkillSourceForm = false
    await loadSlashCommands()
    dispatchSlashCommandsUpdated({ source: 'skill-source' })
    toast.success(`Skill source scanned: ${Number(result.scanned ?? 0)} skill(s) found`)
  } catch (error) {
    console.error('Failed to add skill source:', error)
    toast.error('Failed to add skill source')
  } finally {
    skillSourceSaving = false
  }
}

async function rescanSkillSource(source: SkillSourceRow) {
  try {
    skillSourceScanningId = source.id
    skillSourceWarnings = []
    const response = await fetch(`/api/skill-sources/${source.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const result = await response.json()

    if (!response.ok) {
      toast.error(result.error || 'Failed to rescan skill source')
      return
    }

    if (result.skillSource) {
      replaceSkillSource(result.skillSource as SkillSourceRow)
    }
    skillSourceWarnings = Array.isArray(result.warnings)
      ? result.warnings.map((warning: unknown) => String(warning)).filter(Boolean)
      : []
    await loadSlashCommands()
    dispatchSlashCommandsUpdated({ source: 'skill-source' })
    toast.success(`Skill source rescanned: ${Number(result.scanned ?? 0)} skill(s) found`)
  } catch (error) {
    console.error('Failed to rescan skill source:', error)
    toast.error('Failed to rescan skill source')
  } finally {
    skillSourceScanningId = null
  }
}

async function removeSkillSource(source: SkillSourceRow) {
  try {
    skillSourceDeletingId = source.id
    const response = await fetch(`/api/skill-sources/${source.id}`, { method: 'DELETE' })
    const result = await response.json().catch(() => ({}))

    if (!response.ok) {
      toast.error(result.error || 'Failed to remove skill source')
      return
    }

    skillSources = skillSources.filter((entry) => entry.id !== source.id)
    await loadSlashCommands()
    dispatchSlashCommandsUpdated({ source: 'skill-source' })
    toast.success('Skill source removed')
  } catch (error) {
    console.error('Failed to remove skill source:', error)
    toast.error('Failed to remove skill source')
  } finally {
    skillSourceDeletingId = null
  }
}

function applyImportedSkill(skill: Record<string, unknown>) {
  const importedId = String(skill.id ?? '').trim()
  const importedName = String(skill.name ?? '').trim() || importedId
  const importedDisplayName = String(skill.displayName ?? importedName).trim() || importedName
  const importedDescription = String(skill.description ?? '').trim()
  const importedMarkdown = String(skill.markdown ?? '').trim()
  const importedSource = String(skill.source ?? '').trim() as SkillSource
  const importedSourceRef = String(skill.sourceRef ?? '').trim()
  const importedLicense = String(skill.license ?? '').trim()
  const importedCompatibility = String(skill.compatibility ?? '').trim()
  const importedMetadata =
    skill.metadata && typeof skill.metadata === 'object' && !Array.isArray(skill.metadata)
      ? (skill.metadata as Record<string, unknown>)
      : {}
  const importedAllowedTools = Array.isArray(skill.allowedTools)
    ? skill.allowedTools.map((value) => String(value).trim()).filter((value) => value.length > 0)
    : []
  const importedStandardsStatus: SkillStandardsStatus =
    skill.standardsStatus === 'full' ? 'full' : 'degraded'
  const importedStandardsIssues = Array.isArray(skill.standardsIssues)
    ? skill.standardsIssues.map((issue) => String(issue).trim()).filter((issue) => issue.length > 0)
    : []
  const importedBundleManifest =
    skill.bundleManifest && typeof skill.bundleManifest === 'object'
      ? (skill.bundleManifest as SkillBundleManifest)
      : null
  const importedBundleFiles = Array.isArray(skill.bundleFiles)
    ? (skill.bundleFiles as SkillBundleFile[])
    : []
  const importedDependencies = Array.isArray(skill.dependencies)
    ? skill.dependencies
        .map((dependency) => {
          if (!dependency || typeof dependency !== 'object') return ''
          return sanitizeIdentifier(String((dependency as any).id ?? '').trim())
        })
        .filter((value) => value.length > 0)
    : []

  form.type = 'skill'
  form.skillId = importedId || sanitizeIdentifier(importedName || form.name || 'imported-skill')
  form.skillName = importedName || form.skillName || form.displayName || form.name
  form.skillDescription = importedDescription || form.skillDescription
  form.skillMarkdown = importedMarkdown || form.skillMarkdown
  form.skillSource = (['custom', 'system', 'github', 'git', 'local', 'url'] as SkillSource[]).includes(importedSource)
    ? importedSource
    : 'custom'
  form.skillSourceRef = importedSourceRef || form.skillSourceRef
  form.dependenciesCsv = importedDependencies.join(', ')
  form.skillLicense = importedLicense
  form.skillCompatibility = importedCompatibility
  form.skillMetadataJson =
    Object.keys(importedMetadata).length > 0
      ? JSON.stringify(importedMetadata, null, 2)
      : ''
  form.skillAllowedToolsCsv = importedAllowedTools.join(', ')
  form.skillStandardsStatus = importedStandardsStatus
  form.skillStandardsIssues = importedStandardsIssues
  form.skillBundleManifest = importedBundleManifest
  form.skillBundleFiles = importedBundleFiles
  form.trustLevel = skill.trustLevel === 'trusted' ? 'trusted' : 'untrusted'
  form.hasScripts = skill.hasScripts === true
  form.hasReferences = skill.hasReferences === true
  form.hasAssets = skill.hasAssets === true

  if (!form.name.trim()) {
    form.name = sanitizeIdentifier(importedId || importedName || 'imported-skill')
  }
  if (!form.displayName.trim()) {
    form.displayName = importedDisplayName
  }
  if (!form.invocation_pattern.trim()) {
    form.invocation_pattern = `/${sanitizeIdentifier(form.name || importedId || importedName || 'imported-skill')}`
  }
}

async function importSkill(mode: 'source' | 'command') {
  try {
    importingSkill = true
    importWarnings = []

    const payload: Record<string, unknown> =
      mode === 'command'
        ? { installCommand: importInstallCommand }
        : {
            sourceType: importSourceType,
            source: importSource,
            skillPath: importSkillPath || undefined
          }

    const response = await fetch('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const result = await response.json()

    if (!response.ok) {
      toast.error(result.error || 'Skill import failed')
      return
    }

    if (!result?.skill || typeof result.skill !== 'object') {
      toast.error('Skill import returned invalid payload')
      return
    }

    applyImportedSkill(result.skill as Record<string, unknown>)
    importWarnings = Array.isArray(result.warnings)
      ? result.warnings.map((warning: unknown) => String(warning)).filter(Boolean)
      : []

    toast.success('Skill imported into the form. Save the Skill to persist it.')
  } catch (error) {
    console.error('Failed to import skill:', error)
    toast.error('Failed to import skill')
  } finally {
    importingSkill = false
  }
}

async function bootstrapSystemSlashCommands() {
  try {
    bootstrapping = true
    const response = await fetch('/api/slash-commands/bootstrap', { method: 'POST' })
    const payload = await response.json()

    if (payload.success) {
      await loadSlashCommands()
      dispatchSlashCommandsUpdated({ source: 'bootstrap' })
      toast.success('System skills refreshed')
      return
    }

    toast.message(payload.message || 'System skills already exist')
  } catch (error) {
    console.error('Failed to bootstrap slash commands:', error)
    toast.error('Failed to create system skills')
  } finally {
    bootstrapping = false
  }
}

async function saveCommand(options?: {
  autosave?: boolean
  suppressSuccessToast?: boolean
  suppressValidationToast?: boolean
}) {
  const autosave = options?.autosave === true
  const effectiveType = selectedCommand?.type ?? form.type

  if (!form.name.trim()) {
    if (!options?.suppressValidationToast) {
      toast.error(`${getItemLabel(effectiveType)} name is required`)
    }
    if (autosave) {
      commandSaveState = 'idle'
    }
    return false
  }

  if (effectiveType === 'prompt' && !form.prompt_template.trim()) {
    if (!options?.suppressValidationToast) {
      toast.error('Prompt needs a template')
    }
    if (autosave) {
      commandSaveState = 'idle'
    }
    return false
  }

  if (effectiveType === 'skill' && !isEditing && !form.skillMarkdown.trim()) {
    if (!options?.suppressValidationToast) {
      toast.error('Import a skill first, or use the Skill Creator skill from chat')
    }
    return false
  }

  try {
    if (autosave) {
      commandSaveState = 'saving'
      commandSaveError = null
    } else {
      saving = true
    }

    const payload = buildPayload()
    const endpoint =
      isEditing && selectedCommandId
        ? `/api/slash-commands/${selectedCommandId}`
        : '/api/slash-commands'

    const method = isEditing && selectedCommandId ? 'PUT' : 'POST'

    const response = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const result = await response.json()

    if (!response.ok) {
      const message = result.error || `Failed to save ${getItemLabel(effectiveType).toLowerCase()}`
      if (autosave) {
        commandSaveState = 'idle'
        commandSaveError = message
      } else {
        toast.error(message)
      }
      return false
    }

    if (!options?.suppressSuccessToast) {
      toast.success(isEditing ? `${getItemLabel(effectiveType)} updated` : `${getItemLabel(effectiveType)} created`)
    }

    await loadSlashCommands()
    const updatedCommandId = String(result.slashCommand?.id ?? selectedCommandId ?? '').trim()
    dispatchSlashCommandsUpdated({
      source: 'settings',
      ...(updatedCommandId ? { commandId: updatedCommandId } : {})
    })

    if (!isEditing && result.slashCommand?.id) {
      selectCommand(result.slashCommand)
    } else if (isEditing) {
      persistedCommandSignature = buildPersistedCommandSignature(form, {
        editing: true,
        selectedCommandType: selectedCommand?.type ?? effectiveType,
        systemCommand: selectedCommand ?? null
      })
    }

    if (autosave) {
      markCommandSaved()
    }

    return true
  } catch (error) {
    console.error('Failed to save command:', error)
    const message =
      error instanceof Error ? error.message : `Failed to save ${getItemLabel(effectiveType).toLowerCase()}`
    if (autosave) {
      commandSaveState = 'idle'
      commandSaveError = message
    } else {
      toast.error(message)
    }
    return false
  } finally {
    if (!autosave) {
      saving = false
    }
  }
}

const debouncedAutosaveCommand = debounce(async () => {
  await saveCommand({
    autosave: true,
    suppressSuccessToast: true,
    suppressValidationToast: true
  })
}, COMMAND_AUTOSAVE_DEBOUNCE_MS)

async function savePromptTemplateFromEditor(nextValue: string) {
  form.prompt_template = nextValue
  promptTemplateEditSession += 1

  if (!isEditing) {
    return
  }

  await saveCommand({
    autosave: true,
    suppressSuccessToast: true,
    suppressValidationToast: true
  })
}

$effect(() => {
  if (!showEditor || !isEditing || !selectedCommandId) return

  promptTemplateEditSession

  const signature = buildPersistedCommandSignature(form, {
    editing: true,
    selectedCommandType: selectedCommand?.type ?? form.type,
    systemCommand: selectedCommand ?? null
  })

  if (!persistedCommandSignature || signature === persistedCommandSignature) {
    return
  }

  if (!canAutosaveCurrentCommand(form)) {
    commandSaveState = 'idle'
    return
  }

  commandSaveState = 'saving'
  commandSaveError = null
  debouncedAutosaveCommand()
})

async function deleteCommand(command: SlashCommandRow) {
  if (command.is_system) {
    toast.error('System skills cannot be deleted')
    return
  }

  const itemLabel = getItemLabel(command.type)
  const confirmed = await confirmDialog({
    title: `Delete ${command.displayName || command.name}?`,
    description: `This permanently deletes this ${itemLabel.toLowerCase()}.`,
    confirmLabel: `Delete ${itemLabel}`,
    tone: 'destructive'
  })
  if (!confirmed) return

  try {
    deleting = true
    const response = await fetch(`/api/slash-commands/${command.id}`, { method: 'DELETE' })
    const result = await response.json().catch(() => ({}))

    if (!response.ok) {
      toast.error(result.error || `Failed to delete ${itemLabel.toLowerCase()}`)
      return
    }

    toast.success(`${itemLabel} deleted`)
    await loadSlashCommands()
    dispatchSlashCommandsUpdated({ source: 'settings', commandId: command.id })
  } catch (error) {
    console.error('Failed to delete slash command:', error)
    toast.error(`Failed to delete ${itemLabel.toLowerCase()}`)
  } finally {
    deleting = false
  }
}

</script>

<div class="space-y-4">
  <input
    bind:this={iconUploadInput}
    type="file"
    accept="image/svg+xml,image/png,.svg,.png"
    class="hidden"
    onchange={handleIconUpload}
  />

  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex items-center gap-2">
      <BatshitIcon id="skills" class="h-5 w-5 text-muted-foreground" />
      <h3 class="batshit-settings-section-title">Skills & Prompts</h3>
      <SettingsInfoMenu ariaLabel="About Skills & Prompts" contentClass="w-80">
        <p>
          Create reusable Skills and Prompts for slash invocation in chat. Skill Sources manage
          folders that scan into the normal Skills library.
        </p>
        <p class="mt-2">
          Per-agent assignment stays in `Agent Settings -> Access`.
        </p>
      </SettingsInfoMenu>
    </div>
    {#if activeSkillsPromptsTab !== 'portable-skills'}
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onclick={refreshPanelData} disabled={loading || loadingAgents}>
        <RefreshCw  />
        Refresh
      </Button>
      {#if slashCommands.length === 0}
        <Button size="sm" onclick={bootstrapSystemSlashCommands} disabled={bootstrapping}>
          <Sparkles  />
          {bootstrapping ? 'Creating...' : 'Bootstrap System Skills'}
        </Button>
      {/if}
    </div>
    {/if}
  </div>

  <Tabs.Root bind:value={activeSkillsPromptsTab} class="w-full">
    <Tabs.List class="flex w-full flex-wrap gap-2">
      <Tabs.Trigger value="skills" class="min-w-[104px] flex-1 gap-2 sm:flex-none">
        <BatshitIcon id="skills" class="h-3.5 w-3.5" />
        <span>Skills</span>
      </Tabs.Trigger>
      <Tabs.Trigger value="skill-sources" class="min-w-[132px] flex-1 gap-2 sm:flex-none">
        <FolderOpen class="h-3.5 w-3.5" />
        <span>Skill Sources</span>
      </Tabs.Trigger>
      <Tabs.Trigger value="prompts" class="min-w-[104px] flex-1 gap-2 sm:flex-none">
        <BatshitIcon id="prompts" class="h-3.5 w-3.5" />
        <span>Prompts</span>
      </Tabs.Trigger>
      <Tabs.Trigger value="portable-skills" class="min-w-[144px] flex-1 gap-2 sm:flex-none">
        <KeyRound class="h-3.5 w-3.5" />
        <span>Portable Skills</span>
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>

  {#if activeSkillsPromptsTab === 'skill-sources'}
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-1.5">
          <h3 class="batshit-settings-section-title">Skill Sources</h3>
          <SettingsInfoMenu ariaLabel="About Skill Sources" contentClass="w-80">
            <p>
              Add folders that contain SKILL.md bundles. Batshit scans those files into normal
              Skills, then agents load them through native_skill.
            </p>
          </SettingsInfoMenu>
        </div>
        {#if !showSkillSourceForm}
          <Button type="button" size="sm" onclick={openSkillSourceForm}>
            <Plus />
            Add Skill Source
          </Button>
        {/if}
      </div>

      {#if showSkillSourceForm}
        <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
          <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_170px_180px]">
            <div class="space-y-2">
              <Label for="skill-source-label">Label</Label>
              <Input
                id="skill-source-label"
                placeholder="Codex skills"
                bind:value={skillSourceLabel}
              />
            </div>

            <div class="space-y-2">
              <Label for="skill-source-path">Folder Path</Label>
              <Input
                id="skill-source-path"
                placeholder="~/path/to/skills"
                bind:value={skillSourcePath}
              />
            </div>

            <div class="space-y-2">
              <Label for="skill-source-trust">Trust</Label>
              <Select.Root
                type="single"
                value={skillSourceTrustLevel}
                onValueChange={(value) => {
                  if (value === 'trusted' || value === 'untrusted') {
                    skillSourceTrustLevel = value
                  }
                }}
              >
                <Select.Trigger id="skill-source-trust">
                  <span data-slot="select-value" class="batshit-settings-form-label">
                    {skillSourceTrustLevel === 'trusted' ? 'Trusted' : 'Untrusted'}
                  </span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="untrusted">Untrusted</Select.Item>
                  <Select.Item value="trusted">Trusted</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>

            <div class="space-y-2">
              <p class="batshit-settings-form-label">Agent Access</p>
              <div class="batshit-settings-action-row">
                <span class="batshit-settings-form-label">
                  {skillSourceEnableForAllAgents ? 'All Agents' : 'Selected Agents'}
                </span>
                <Switch.Root bind:checked={skillSourceEnableForAllAgents} />
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onclick={closeSkillSourceForm}
              disabled={skillSourceSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onclick={() => void addSkillSource()}
              disabled={skillSourceSaving || !skillSourcePath.trim()}
            >
              {#if skillSourceSaving}
                <Loader2 class="h-4 w-4 animate-spin" />
                Scanning...
              {:else}
                <Plus />
                Add Source
              {/if}
            </Button>
          </div>
        </div>
      {/if}

      {#if skillSourceWarnings.length > 0}
        <div class="batshit-settings-inline-alert is-warning">
          <p class="batshit-settings-form-label">Source warnings</p>
          {#each skillSourceWarnings.slice(0, 8) as warning, index (`source-warning-${index}`)}
            <p class="mt-1">- {warning}</p>
          {/each}
          {#if skillSourceWarnings.length > 8}
            <p class="mt-1">- ...and {skillSourceWarnings.length - 8} more</p>
          {/if}
        </div>
      {/if}

      {#if skillSourcesLoading}
        <div class="batshit-settings-inline-alert is-dashed">Loading skill sources...</div>
      {:else if sortedSkillSources.length === 0}
        <Card.Root class="batshit-settings-card batshit-settings-card-default">
          <Card.Content class="batshit-settings-card-empty space-y-4">
            <div class="batshit-settings-inline-strong">No skill sources yet</div>
            <p class="batshit-settings-caption">
              Add a folder source to scan local SKILL.md bundles into your Skills library.
            </p>
            <div class="flex justify-center">
              <Button type="button" onclick={openSkillSourceForm}>
                <Plus />
                Add Your First Skill Source
              </Button>
            </div>
          </Card.Content>
        </Card.Root>
      {:else}
        <div class="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <Card.Root class="batshit-settings-card batshit-settings-card-default">
            <Card.Header class="pb-2">
              <Card.Title>Saved Sources</Card.Title>
            </Card.Header>
            <Card.Content class="batshit-settings-card-content-flush">
              <div class="settings-sidebar-items">
                {#each sortedSkillSources as source (source.id)}
                  <button
                    type="button"
                    class="settings-sidebar-item settings-sidebar-item-with-avatar"
                    data-state={source.id === selectedSkillSourceId ? 'active' : 'inactive'}
                    onclick={() => (selectedSkillSourceId = source.id)}
                  >
                    <div class="settings-sidebar-item-media pt-0.5">
                      <div class="batshit-settings-icon-frame h-9 w-9">
                        <FolderOpen class="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div class="settings-sidebar-item-content">
                      <span class="settings-sidebar-item-title truncate">{source.label}</span>
                      <span class="settings-sidebar-item-subtext truncate">
                        {(source.discovered_command_ids?.length ?? 0)} skill{(source.discovered_command_ids?.length ?? 0) === 1 ? '' : 's'}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </Card.Content>
          </Card.Root>

          <div class="space-y-4">
            {#if selectedSkillSource}
              <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-display-card">
                <Card.Header>
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0 space-y-2">
                      <Card.Title class="flex min-w-0 items-center gap-2">
                        <FolderOpen class="h-4 w-4 shrink-0" />
                        <span class="truncate">{selectedSkillSource.label}</span>
                      </Card.Title>
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="batshit-settings-pill">{selectedSkillSource.scope}</span>
                        <span class="batshit-settings-pill">{formatSkillSourceTrust(selectedSkillSource)}</span>
                        {#if selectedSkillSource.enabled_for_all_agents === true}
                          <span class="batshit-settings-pill is-primary">All Agents</span>
                        {:else}
                          <span class="batshit-settings-pill">{formatSkillSourceAccess(selectedSkillSource)}</span>
                        {/if}
                        {#if selectedSkillSource.last_scan_status === 'error'}
                          <span class="batshit-settings-pill is-warning">Scan Error</span>
                        {/if}
                      </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => void rescanSkillSource(selectedSkillSource)}
                        disabled={skillSourceScanningId === selectedSkillSource.id}
                      >
                        {#if skillSourceScanningId === selectedSkillSource.id}
                          <Loader2 class="h-4 w-4 animate-spin" />
                          Scanning
                        {:else}
                          <RefreshCw />
                          Rescan
                        {/if}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Delete skill source"
                        title="Delete skill source"
                        onclick={() => void removeSkillSource(selectedSkillSource)}
                        disabled={skillSourceDeletingId === selectedSkillSource.id}
                      >
                        {#if skillSourceDeletingId === selectedSkillSource.id}
                          <Loader2 class="h-4 w-4 animate-spin" />
                        {:else}
                          <Trash2 />
                        {/if}
                      </Button>
                    </div>
                  </div>
                </Card.Header>
                <Card.Content class="space-y-4">
                  <div class="batshit-settings-card-subtle-frame is-compact">
                    <div class="grid gap-4 md:grid-cols-2">
                      <div class="min-w-0">
                        <p class="batshit-settings-form-label">Folder Path</p>
                        <p class="batshit-settings-caption mt-1 break-all">{selectedSkillSource.root_path}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Last Scan</p>
                        <p class="batshit-settings-caption mt-1">{formatSkillSourceScan(selectedSkillSource)}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Skills Found</p>
                        <p class="batshit-settings-caption mt-1">
                          {selectedSkillSource.discovered_command_ids?.length ?? 0}
                        </p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Agent Access</p>
                        <p class="batshit-settings-caption mt-1">{formatSkillSourceAccess(selectedSkillSource)}</p>
                      </div>
                    </div>
                  </div>

                  {#if selectedSkillSource.last_scan_status === 'error' && selectedSkillSource.last_scan_error}
                    <div class="batshit-settings-inline-alert is-warning">
                      <p class="batshit-settings-form-label">Last scan error</p>
                      <p class="mt-1">{selectedSkillSource.last_scan_error}</p>
                    </div>
                  {/if}
                </Card.Content>
              </Card.Root>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {:else if activeSkillsPromptsTab === 'portable-skills'}
    <PortableSkillsSettingsPanel embedded />
  {:else}

  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-1.5">
      <h3 class="batshit-settings-section-title">
        {activeSkillsPromptsTab === 'skills' ? 'Skills' : 'Prompts'}
      </h3>
      <SettingsInfoMenu
        ariaLabel={activeSkillsPromptsTab === 'skills' ? 'About Skills' : 'About Prompts'}
        contentClass="w-80"
      >
        {#if activeSkillsPromptsTab === 'skills'}
          <p>
            Skills are reusable SKILL.md-backed workflows. Skill Sources can scan new folders into
            this list, and manual skills can still be created here.
          </p>
        {:else}
          <p>
            Prompts are reusable slash-invoked prompt templates with the same global and per-agent
            access model as Skills.
          </p>
        {/if}
      </SettingsInfoMenu>
    </div>
    {#if activeSkillsPromptsTab === 'skills'}
      <Button size="sm" onclick={openCreateSkillForm}>
        <Plus />
        Create Skill Manually
      </Button>
    {:else}
      <Button size="sm" onclick={openCreatePromptForm}>
        <Plus />
        Create Prompt
      </Button>
    {/if}
  </div>

  {#if loading}
    <div class="rounded-md border border-dashed p-8 text-center text-muted-foreground">
      Loading skills and prompts...
    </div>
  {:else}
    <div class="batshit-settings-surface">
      <div class="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card.Root class="batshit-settings-card batshit-settings-card-default">
          <Card.Header class="pb-2">
            <div class="flex items-center gap-1">
              <Card.Title class="flex items-center gap-2">
                <BatshitIcon
                  id={activeSkillsPromptsTab === 'skills' ? 'skills' : 'prompts'}
                  class="h-4 w-4"
                />
                {activeSkillsPromptsTab === 'skills' ? 'Saved Skills' : 'Saved Prompts'}
              </Card.Title>
              <SettingsInfoMenu
                ariaLabel={activeSkillsPromptsTab === 'skills' ? 'About Saved Skills' : 'About Saved Prompts'}
              >
                {#if activeSkillsPromptsTab === 'skills'}
                  <p>Pick a saved Skill to edit its metadata, trust, and access settings.</p>
                {:else}
                  <p>Pick a saved Prompt to edit its metadata, template, and access settings.</p>
                {/if}
              </SettingsInfoMenu>
            </div>
          </Card.Header>
          <Card.Content class="batshit-settings-card-content-flush">
            {#if activeSkillsPromptsTab === 'skills' && skillCommands.length === 0}
              <div class="batshit-settings-empty-state">
                No Skills yet. Create one manually or add a Skill Source.
              </div>
            {:else if activeSkillsPromptsTab === 'prompts' && promptCommands.length === 0}
              <div class="batshit-settings-empty-state">
                No Prompts yet. Create one to start using reusable prompt templates.
              </div>
            {:else}
              <div class="flex flex-col pb-4">
                {#if activeSkillsPromptsTab === 'skills'}
                  {#if systemSkillCommands.length > 0}
                    <div class="batshit-settings-list-band is-active">
                      <Collapsible.Root bind:open={systemSkillsOpen}>
                        <div class="flex items-center gap-2 pr-2">
                          <Collapsible.Trigger class="batshit-settings-list-band-trigger flex items-center justify-between">
                            <div class="batshit-settings-form-label flex items-center gap-2">
                              Batshit Skills
                              <span class="batshit-settings-pill">
                                {systemSkillCommands.length}
                              </span>
                            </div>
                            <ChevronDown class={`h-4 w-4 transition-transform ${systemSkillsOpen ? 'rotate-180' : ''}`} />
                          </Collapsible.Trigger>
                          <div class="shrink-0">
                            <SettingsInfoMenu ariaLabel="About Batshit Skills">
                              <p>Built-in Batshit skills provided by the app.</p>
                            </SettingsInfoMenu>
                          </div>
                        </div>
                        <Collapsible.Content>
                          <div class="settings-sidebar-items">
                            {#each systemSkillCommands as command (command.id)}
                              <button
                                type="button"
                                class="settings-sidebar-item"
                                data-state={selectedCommandId === command.id ? 'active' : 'inactive'}
                                onclick={() => selectCommand(command)}
                              >
                                <div class="flex items-start justify-between gap-2">
                                  <div class="flex min-w-0 items-center gap-2">
                                    <IconRenderer
                                      ref={getCommandIconRef(command)}
                                      {customIcons}
                                      label={command.displayName || command.name}
                                      iconClass="h-4 w-4"
                                    />
                                    <span class="settings-sidebar-item-title truncate">{command.displayName || command.name}</span>
                                  </div>
                                  <span class="batshit-settings-pill is-primary shrink-0">
                                    Built-in
                                  </span>
                                </div>
                                <div class="mt-1.5 flex items-center gap-2">
                                  <code class="settings-sidebar-item-subtext truncate">{command.invocation_pattern || `/${command.id}`}</code>
                                </div>
                              </button>
                            {/each}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                  {/if}

                  {#if userSkillCommands.length > 0}
                    <div class="batshit-settings-list-band">
                      <Collapsible.Root bind:open={yourSkillsOpen}>
                        <div class="flex items-center gap-2 pr-2">
                          <Collapsible.Trigger class="batshit-settings-list-band-trigger flex items-center justify-between">
                            <div class="batshit-settings-form-label flex items-center gap-2">
                              Your Skills
                              <span class="batshit-settings-pill">
                                {userSkillCommands.length}
                              </span>
                            </div>
                            <ChevronDown class={`h-4 w-4 transition-transform ${yourSkillsOpen ? 'rotate-180' : ''}`} />
                          </Collapsible.Trigger>
                        </div>
                        <Collapsible.Content>
                          <div class="settings-sidebar-items">
                            {#each userSkillCommands as command (command.id)}
                              <button
                                type="button"
                                class="settings-sidebar-item"
                                data-state={selectedCommandId === command.id ? 'active' : 'inactive'}
                                onclick={() => selectCommand(command)}
                              >
                                <div class="flex min-w-0 items-center gap-2">
                                  <IconRenderer
                                    ref={getCommandIconRef(command)}
                                    {customIcons}
                                    label={command.displayName || command.name}
                                    iconClass="h-4 w-4"
                                  />
                                  <span class="settings-sidebar-item-title truncate">{command.displayName || command.name}</span>
                                </div>
                                <div class="mt-1.5 flex items-center gap-2">
                                  <code class="settings-sidebar-item-subtext truncate">{command.invocation_pattern || `/${command.id}`}</code>
                                </div>
                              </button>
                            {/each}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                  {/if}
                {:else}
                  {#if systemPromptCommands.length > 0}
                    <div class="batshit-settings-list-band is-active">
                      <Collapsible.Root bind:open={systemPromptsOpen}>
                        <div class="flex items-center gap-2 pr-2">
                          <Collapsible.Trigger class="batshit-settings-list-band-trigger flex items-center justify-between">
                            <div class="batshit-settings-form-label flex items-center gap-2">
                              Batshit Prompts
                              <span class="batshit-settings-pill">
                                {systemPromptCommands.length}
                              </span>
                            </div>
                            <ChevronDown class={`h-4 w-4 transition-transform ${systemPromptsOpen ? 'rotate-180' : ''}`} />
                          </Collapsible.Trigger>
                          <div class="shrink-0">
                            <SettingsInfoMenu ariaLabel="About Batshit Prompts">
                              <p>Built-in Batshit prompts provided by the app.</p>
                            </SettingsInfoMenu>
                          </div>
                        </div>
                        <Collapsible.Content>
                          <div class="settings-sidebar-items">
                            {#each systemPromptCommands as command (command.id)}
                              <button
                                type="button"
                                class="settings-sidebar-item"
                                data-state={selectedCommandId === command.id ? 'active' : 'inactive'}
                                onclick={() => selectCommand(command)}
                              >
                                <div class="flex items-start justify-between gap-2">
                                  <div class="flex min-w-0 items-center gap-2">
                                    <IconRenderer
                                      ref={getCommandIconRef(command)}
                                      {customIcons}
                                      label={command.displayName || command.name}
                                      iconClass="h-4 w-4"
                                    />
                                    <span class="settings-sidebar-item-title truncate">{command.displayName || command.name}</span>
                                  </div>
                                  <span class="batshit-settings-pill is-primary shrink-0">
                                    Built-in
                                  </span>
                                </div>
                                <div class="mt-1.5 flex items-center gap-2">
                                  <code class="settings-sidebar-item-subtext truncate">{command.invocation_pattern || `/${command.id}`}</code>
                                </div>
                              </button>
                            {/each}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                  {/if}

                  {#if userPromptCommands.length > 0}
                    <div class="batshit-settings-list-band">
                      <Collapsible.Root bind:open={yourPromptsOpen}>
                        <div class="flex items-center gap-2 pr-2">
                          <Collapsible.Trigger class="batshit-settings-list-band-trigger flex items-center justify-between">
                            <div class="batshit-settings-form-label flex items-center gap-2">
                              Your Prompts
                              <span class="batshit-settings-pill">
                                {userPromptCommands.length}
                              </span>
                            </div>
                            <ChevronDown class={`h-4 w-4 transition-transform ${yourPromptsOpen ? 'rotate-180' : ''}`} />
                          </Collapsible.Trigger>
                        </div>
                        <Collapsible.Content>
                          <div class="settings-sidebar-items">
                            {#each userPromptCommands as command (command.id)}
                              <button
                                type="button"
                                class="settings-sidebar-item"
                                data-state={selectedCommandId === command.id ? 'active' : 'inactive'}
                                onclick={() => selectCommand(command)}
                              >
                                <div class="flex min-w-0 items-center gap-2">
                                  <IconRenderer
                                    ref={getCommandIconRef(command)}
                                    {customIcons}
                                    label={command.displayName || command.name}
                                    iconClass="h-4 w-4"
                                  />
                                  <span class="settings-sidebar-item-title truncate">{command.displayName || command.name}</span>
                                </div>
                                <div class="mt-1.5 flex items-center gap-2">
                                  <code class="settings-sidebar-item-subtext truncate">{command.invocation_pattern || `/${command.id}`}</code>
                                </div>
                              </button>
                            {/each}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          </Card.Content>
        </Card.Root>

        <div class="space-y-4">
          {#if !showEditor}
            <Card.Root class="batshit-settings-card batshit-settings-card-default">
              <Card.Header>
                <div class="flex items-center gap-1">
                  <Card.Title class="flex items-center gap-2">
                    <BatshitIcon id="prompts" class="h-4 w-4" />
                    Select a Skill or Prompt
                  </Card.Title>
                  <SettingsInfoMenu ariaLabel="About Skill Or Prompt Editor">
                    <p>
                      Pick a saved Skill or Prompt to edit it, or create a new one when you need a
                      fresh reusable workflow.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </Card.Header>
              <Card.Content class="batshit-settings-card-caption">
                Select a Skill or Prompt to view or edit it, or create a new one.
              </Card.Content>
            </Card.Root>
          {:else}
            <SettingsAccordionCard
              name="skills-prompts-cards"
              title={isEditing
                ? `${getItemLabel(selectedCommand?.type)} Settings`
                : form.type === 'skill'
                  ? 'Create Skill'
                  : 'Create Prompt'}
              batshitIcon={form.type === 'skill' ? 'skills' : 'prompts'}
              contentClass="space-y-4"
              open
            >
              {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Skill Or Prompt Settings">
                    <p>
                      Edit item identity, slash invocation, trust/source metadata, and the global
                      access switch here.
                    </p>
                  </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                {#if isEditing}
                  <SettingsSaveStatus
                    state={commandSaveError ? 'error' : commandSaveState}
                    error={commandSaveError}
                    savedLabel={`${getItemLabel(selectedCommand?.type)} Saved`}
                    sticky={false}
                  />
                {:else}
                  <Button onclick={() => void saveCommand()} disabled={saving}>
                    <Save  />
                    {saving ? 'Creating...' : form.type === 'skill' ? 'Create Skill' : 'Create Prompt'}
                  </Button>
                {/if}
              {/snippet}
          {#if isEditingSystemCommand}
            <div class="batshit-settings-inline-alert is-info">
              Built-in Batshit skills keep their name, slash path, icon, and package content in the repo. You can adjust status, global agent access, and trust here.
            </div>
          {/if}
          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label for="command-id" class="batshit-settings-form-label">Internal ID</Label>
                  <SettingsInfoMenu ariaLabel="About Internal ID">
                    <p>Optional. Leave blank to generate one from the name.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id="command-id"
                  placeholder="auto-generated from name"
                  bind:value={form.id}
                  disabled={isEditing}
                />
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label for="command-name" class="batshit-settings-form-label">
                    {form.type === 'skill' ? 'Skill Name' : 'Prompt Name'}
                  </Label>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input id="command-name" placeholder="artifact-helper" bind:value={form.name} disabled={isEditingSystemCommand} />
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label for="command-display-name" class="batshit-settings-form-label">Display Name</Label>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id="command-display-name"
                  placeholder="Artifact Helper"
                  bind:value={form.displayName}
                  disabled={isEditingSystemCommand}
                />
              </div>
            </div>

            <div class="batshit-settings-form-row is-tall">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label for="command-invocation" class="batshit-settings-form-label">Invocation</Label>
                  <SettingsInfoMenu ariaLabel="About Invocation">
                    <p>This is the slash alias Batshit suggests and expands in chat.</p>
                    <p class="mt-2">Batshit resolves slash-item collisions before CLI-native variants.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id="command-invocation"
                  placeholder="/artifact-helper"
                  bind:value={form.invocation_pattern}
                  disabled={isEditingSystemCommand}
                />
                {#if invocationCliCollisions.length > 0 || invocationBatshitCollisions.length > 0}
                  <div class="batshit-settings-inline-alert is-warning mt-2">
                    <p class="batshit-settings-form-label">Alias collision warning for <code>{normalizedInvocation}</code></p>
                    {#if invocationBatshitCollisions.length > 0}
                      <p class="mt-1">
                        Existing Batshit slash item(s): {invocationBatshitCollisions.map((entry) => entry.displayName || entry.name).join(', ')}
                      </p>
                    {/if}
                    {#if invocationCliCollisions.length > 0}
                      <p class="mt-1">
                        CLI slash item(s): {invocationCliCollisions.map((entry) =>
                          `${formatSourceLabel(entry.source)}:${entry.name}${entry.scope ? ` (${formatScopeLabel(entry.scope)})` : ''}${entry.agentName ? ` @ ${entry.agentName}` : ''}`
                        ).join(', ')}
                      </p>
                    {/if}
                    <p class="mt-1">Typed collisions resolve to Batshit first. CLI variants require explicit dropdown selection.</p>
                  </div>
                {/if}
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <p class="batshit-settings-form-label">Icon</p>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <IconPicker
                  bind:value={form.iconRef}
                  {customIcons}
                  disabled={isEditingSystemCommand}
                  triggerLabel={iconUploading ? 'Uploading...' : 'Choose Icon'}
                  onUploadRequested={requestIconUpload}
                  onCustomIconsChange={(icons) => (customIcons = icons)}
                />
              </div>
            </div>

            <div class="batshit-settings-toggle-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label for="command-active" class="batshit-settings-form-label">Status</Label>
                  <SettingsInfoMenu ariaLabel="About Skill Or Prompt Status">
                    <p>Inactive Skills and Prompts stay saved but do not appear as usable slash items.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span class="batshit-settings-form-label">{form.is_active ? 'Active' : 'Inactive'}</span>
                <Switch.Root bind:checked={form.is_active} name="command-active" />
              </div>
            </div>

            {#if form.type === 'skill'}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label for="skill-trust" class="batshit-settings-form-label">Trust Level</Label>
                    <SettingsInfoMenu ariaLabel="About Skill Trust Level">
                      <p>Use `Untrusted` unless you fully trust the skill source and bundled scripts.</p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control">
                  <Select.Root
                    type="single"
                    value={form.trustLevel}
                    onValueChange={(value) => {
                      if (value === 'trusted' || value === 'untrusted') {
                        form.trustLevel = value
                      }
                    }}
                  >
                    <Select.Trigger id="skill-trust">
                      <span data-slot="select-value" class="batshit-settings-form-label">
                        {form.trustLevel === 'trusted' ? 'Trusted' : 'Untrusted'}
                      </span>
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="untrusted">Untrusted</Select.Item>
                      <Select.Item value="trusted">Trusted</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </div>
              </div>
            {/if}

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label for="command-args" class="batshit-settings-form-label">Arguments</Label>
                  <SettingsInfoMenu ariaLabel="About Skill Or Prompt Arguments">
                    <p>Use commas to separate args.</p>
                    <p class="mt-2">Append <code>*</code> for required args and <code>=value</code> for defaults.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id="command-args"
                  placeholder="topic*, audience, style=formal"
                  bind:value={form.argsCsv}
                  disabled={isEditingSystemCommand}
                />
              </div>
            </div>
          </div>

        <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
          <div class="flex items-center gap-1">
            <p class="batshit-settings-form-label">Global Agent Access</p>
            <SettingsInfoMenu ariaLabel="About Global Agent Access">
              <p>Turn this on to expose the current Skill or Prompt to every agent automatically.</p>
              <p class="mt-2">Leave it off to manage selected-agent assignment in <code>Agent Settings -&gt; Access</code>.</p>
              <p class="mt-2">Existing individual assignments are preserved behind the scenes when this is off.</p>
            </SettingsInfoMenu>
          </div>
          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-toggle-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <p class="batshit-settings-form-label">Enable For All Agents</p>
                </div>
              </div>
              <Switch.Root bind:checked={form.enabledForAllAgents} />
            </div>
          </div>
        </div>

          {#if form.type === 'prompt'}
            <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="flex items-center gap-1">
                  <p class="batshit-settings-form-label">Prompt Template</p>
                  <SettingsInfoMenu ariaLabel="About Prompt Template">
                    <p>
                      Prompt templates are long-form content, so they follow the shared popup editor
                      rule instead of inline autosaving textareas.
                    </p>
                  </SettingsInfoMenu>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onclick={() => (promptTemplateEditorOpen = true)}
                >
                  <FileText  />
                  Edit Prompt Template
                </Button>
              </div>
              {#if form.prompt_template.trim()}
                <div class="batshit-settings-note is-dashed">
                  <pre class="max-h-48 whitespace-pre-wrap break-words overflow-hidden font-sans">{form.prompt_template}</pre>
                </div>
              {:else}
                <div class="batshit-settings-note is-dashed">
                  No prompt template yet. Use the editor to write reusable prompt content with
                  <code>{'{{arg_name}}'}</code> placeholders.
                </div>
              {/if}
            </div>
          {/if}

          {#if form.type === 'skill'}

            {#if isNewSkillForm}
              <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
                <div class="flex items-center gap-1">
                  <p class="batshit-settings-form-label">Import Skill Definition</p>
                  <SettingsInfoMenu ariaLabel="About Import Skill Definition">
                    <p>
                      Batshit accepts allowlisted <code>skills add</code> commands or direct source
                      details for skill import.
                    </p>
                  </SettingsInfoMenu>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center gap-1">
                    <Label for="import-install-command">Paste Install Command</Label>
                    <SettingsInfoMenu ariaLabel="About Install Command Import">
                      <p>Only allowlisted <code>skills add</code> command shapes are accepted.</p>
                      <p class="mt-2">Chained shell text is rejected.</p>
                    </SettingsInfoMenu>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Input
                      id="import-install-command"
                      placeholder="npx skills add owner/repo --skill path/to/skill"
                      bind:value={importInstallCommand}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onclick={() => importSkill('command')}
                      disabled={importingSkill || !importInstallCommand.trim()}
                    >
                      {importingSkill ? 'Importing...' : 'Import Command'}
                    </Button>
                  </div>
                </div>

                <div class="grid gap-2 md:grid-cols-[180px_1fr_auto]">
                  <div class="space-y-2">
                    <Label for="import-source-type">Source Type</Label>
                    <Select.Root
                      type="single"
                      value={importSourceType}
                      onValueChange={(value) => {
                        if (value === 'github' || value === 'url' || value === 'git' || value === 'local') {
                          importSourceType = value
                        }
                      }}
                    >
                      <Select.Trigger id="import-source-type" class="w-full">
                        <span data-slot="select-value" class="batshit-settings-form-label">
                          {importSourceType === 'github'
                            ? 'GitHub'
                            : importSourceType === 'url'
                              ? 'Direct URL'
                              : importSourceType === 'git'
                                ? 'Git URL'
                                : 'Local Path'}
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="github">GitHub</Select.Item>
                        <Select.Item value="url">Direct URL</Select.Item>
                        <Select.Item value="git">Git URL</Select.Item>
                        <Select.Item value="local">Local Path</Select.Item>
                      </Select.Content>
                    </Select.Root>
                  </div>

                  <div class="space-y-2">
                    <Label for="import-source">Source</Label>
                    <Input
                      id="import-source"
                      placeholder="owner/repo or https://... or /local/path"
                      bind:value={importSource}
                    />
                  </div>

                  <div class="space-y-2">
                    <Label for="import-skill-path">Skill Path (optional)</Label>
                    <Input id="import-skill-path" placeholder="skills/foo" bind:value={importSkillPath} />
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  onclick={() => importSkill('source')}
                  disabled={importingSkill || !importSource.trim()}
                >
                  {importingSkill ? 'Importing...' : 'Import From Source'}
                </Button>

                {#if importWarnings.length > 0}
                  <div class="batshit-settings-inline-alert is-warning">
                    <p class="batshit-settings-form-label">Import warnings</p>
                    {#each importWarnings as warning, index (`import-warning-${index}`)}
                      <p class="mt-1">- {warning}</p>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
            </SettingsAccordionCard>

          {#if form.type === 'skill'}
            <SettingsAccordionCard
              name="skills-prompts-cards"
              title="Skill Details and Status"
              batshitIcon="skills"
              contentClass="space-y-4"
            >
              {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Skill Details And Status">
                    <p>Imported skill internals are shown read-only here for inspection.</p>
                    <p class="mt-2">
                      You or your AI Agent can edit those files directly when the underlying skill
                      package needs to change.
                    </p>
                  </SettingsInfoMenu>
              {/snippet}
                <Collapsible.Root bind:open={skillDetailsOpen}>
                  <div>
                    <Collapsible.Trigger class="batshit-settings-disclosure-trigger">
                      <span class="batshit-settings-form-label">Skill Details</span>
                      <ChevronDown
                        class={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${skillDetailsOpen ? 'rotate-180' : ''}`}
                      />
                    </Collapsible.Trigger>
                    <Collapsible.Content class="pt-3">
                      <div class="batshit-settings-subsection is-spacious space-y-3">
                    <div class="grid gap-3 md:grid-cols-2">
                      <div>
                        <p class="batshit-settings-form-label">Skill ID</p>
                        <p class="batshit-settings-caption break-all">{form.skillId || 'Not set yet'}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Skill Name</p>
                        <p class="batshit-settings-caption break-all">{form.skillName || form.displayName || 'Not set yet'}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Source</p>
                        <p class="batshit-settings-caption">{form.skillSource || 'custom'}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Source Reference</p>
                        <p class="batshit-settings-caption break-all">{form.skillSourceRef || 'None'}</p>
                      </div>
                      <div class="md:col-span-2">
                        <p class="batshit-settings-form-label">Skill Summary</p>
                        <p class="batshit-settings-caption whitespace-pre-wrap break-words">{form.skillDescription || 'No summary available.'}</p>
                      </div>
                      <div class="min-w-0">
                        <p class="batshit-settings-form-label">Dependencies</p>
                        <p class="batshit-settings-caption">{form.dependenciesCsv || 'None declared'}</p>
                      </div>
                      <div class="min-w-0">
                        <p class="batshit-settings-form-label">Allowed Tools</p>
                        <p class="batshit-settings-caption whitespace-pre-wrap break-all">{form.skillAllowedToolsCsv || 'None declared'}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">License</p>
                        <p class="batshit-settings-caption">{form.skillLicense || 'Not set'}</p>
                      </div>
                      <div>
                        <p class="batshit-settings-form-label">Compatibility</p>
                        <p class="batshit-settings-caption">{form.skillCompatibility || 'Not set'}</p>
                      </div>
                    </div>

                    {#if form.skillMetadataJson.trim()}
                      <div class="min-w-0">
                        <p class="batshit-settings-form-label">Metadata</p>
                        <pre class="batshit-settings-note mt-1 max-w-full overflow-hidden whitespace-pre-wrap break-all">{form.skillMetadataJson}</pre>
                      </div>
                    {/if}
                  </div>
                    </Collapsible.Content>
                  </div>
                </Collapsible.Root>

            {#if skillBundleSummary}
              <div class="batshit-settings-inline-alert is-info">
                <p class="batshit-settings-form-label">Bundle composition ({skillBundleSummary.sourceLabel})</p>
                <div class="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <p>Scripts: <strong>{skillBundleSummary.scriptCount}</strong></p>
                  <p>References: <strong>{skillBundleSummary.referenceCount}</strong></p>
                  <p>Assets: <strong>{skillBundleSummary.assetCount}</strong></p>
                  <p>Total files: <strong>{skillBundleSummary.totalCount}</strong></p>
                </div>
                {#if skillBundleSummary.hasManifest}
                  <p class="batshit-settings-form-help">
                    Bundle manifest checksum is present, so import/cache integrity checks can verify this skill package.
                  </p>
                {/if}
              </div>
            {/if}

            {#if skillCompatibilityNotice}
              <div
                class={`batshit-settings-inline-alert ${skillCompatibilityNotice.tone === 'success' ? 'is-success' : 'is-warning'}`}
              >
                <p class="batshit-settings-form-label">{skillCompatibilityNotice.title}</p>
                <p class="mt-1">{skillCompatibilityNotice.summary}</p>
                {#if skillCompatibilityNotice.issues.length > 0}
                  {#each skillCompatibilityNotice.issues as issue, index (`compatibility-issue-${index}`)}
                    <p class="mt-1">- {issue}</p>
                  {/each}
                {/if}
              </div>
            {/if}

            {#if skillGuidanceLines.length > 0}
              <div class="batshit-settings-inline-alert is-info">
                <p class="batshit-settings-form-label">Skill safety guidance</p>
                {#each skillGuidanceLines as guidanceLine, index (`skill-guidance-${index}`)}
                  <p class="mt-1">- {guidanceLine}</p>
                {/each}
              </div>
            {/if}

            {#if untrustedSkillWarning}
              <div class="batshit-settings-inline-alert is-warning">
                {untrustedSkillWarning}
              </div>
            {/if}
            </SettingsAccordionCard>
          {/if}

            {#if isEditing && selectedCommand && !selectedCommand.is_system}
              <Collapsible.Root bind:open={deleteDisclosureOpen}>
                <div>
                  <Collapsible.Trigger class="batshit-settings-delete-trigger">
                    <span class="batshit-settings-delete-trigger-label">
                      <Trash2 class="batshit-settings-delete-trigger-icon" />
                      Delete {getItemLabel(selectedCommand.type)}
                    </span>
                    <ChevronDown
                      class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content class="batshit-settings-delete-content">
                    <div class="batshit-settings-delete-content-inner">
                      <div class="batshit-settings-delete-copy">
                        <p>Permanently removes this {getItemLabel(selectedCommand.type).toLowerCase()} and its saved configuration.</p>
                        <p>Use this when the {getItemLabel(selectedCommand.type).toLowerCase()} should be retired or rebuilt cleanly.</p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        class="batshit-settings-delete-action"
                        onclick={() => void deleteCommand(selectedCommand)}
                        disabled={deleting}
                      >
                        {#if deleting}
                          <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
                          Deleting...
                        {:else}
                          <Trash2 class="batshit-settings-delete-action-icon" />
                          Delete {getItemLabel(selectedCommand.type)}
                        {/if}
                      </Button>
                    </div>
                  </Collapsible.Content>
                </div>
              </Collapsible.Root>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  {/if}
  {/if}
</div>

<SettingsTextEditor
  bind:open={promptTemplateEditorOpen}
  title="Prompt Template"
  value={form.prompt_template}
  description={"Write the reusable prompt content for this Prompt. Use {{arg_name}} placeholders when you want slash arguments injected."}
  placeholder={"Write the reusable prompt template. Use {{arg_name}} placeholders."}
  width="large"
  saveLabel={isEditing ? 'Save Prompt Template' : 'Apply Template'}
  onSave={savePromptTemplateFromEditor}
/>
