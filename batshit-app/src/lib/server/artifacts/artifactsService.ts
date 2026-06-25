import { RedisService } from '$lib/server/redis'
import { nanoid } from 'nanoid'
import type { ArtifactBrainType, ArtifactModelConfig, ArtifactModelRole } from '$lib/types/artifacts'
import { isCatalogIconRef } from '$lib/icons/iconCatalog'
import { parseIconRef, type IconRef } from '$lib/icons/iconTypes'
import { normalizeOptionalIconRef } from '$lib/icons/iconLegacy'
import { normalizeArtifactModelConfig } from '$lib/utils/artifactModelConfig'
import {
  applyManagedPatchHunks,
  extractManagedApplyPatchPayload,
  parseManagedApplyPatchDocument,
  type ManagedApplyPatchUpdateOperation
} from '$lib/server/services/managedApplyPatch'
import {
  buildArtifactZonePublishError,
  evaluateArtifactZonePublish,
  normalizeArtifactZone,
  normalizeArtifactZoneCompatibility,
  type ArtifactZone,
  type ArtifactZoneCompatibility
} from '$lib/artifacts/zoneCompatibility'
import {
  applyBatshitArtifactStructureSetting,
  artifactStructureValidationCanBeDeferred,
  buildArtifactStandardControlsAdvisory,
  buildArtifactStructureEnforcementMessage,
  isRunOnlyMetadata,
  validateBatshitArtifactStructure
} from '$lib/artifacts/structureEnforcement'
import {
  resolveArtifactAgentUseEligibility,
  USER_ONLY_EMBED_AGENT_USE_MESSAGE
} from '$lib/artifacts/agentUseEligibility'
import {
  buildArtifactHtmlPreflightMessage,
  validateArtifactHtmlPreflight,
  type ArtifactHtmlPreflightResult
} from '$lib/server/artifacts/artifactHtmlPreflight'
import { deleteArtifactRunLogs } from '$lib/server/artifacts/artifactRunLogs'

export type ArtifactMode = 'edit' | 'published'

const MAX_ARTIFACT_VERSION_HISTORY = 25

const ARTIFACT_LIST_PROJECTION_PATHS = [
  '.id',
  '.user_id',
  '.name',
  '.slug',
  '.type',
  '.mode',
  '.version',
  '.description',
  '.tags',
  '.metadata',
  '.created_in_session',
  '.last_edited_session',
  '.widget_position',
  '.brain_type',
  '.ai_enabled',
  '.webhook_url',
  '.model',
  '.model_config',
  '.system_prompt',
  '.custom_prompt',
  '.created_at',
  '.updated_at',
  '.published_at',
  '.zone',
  '.zone_compatibility',
  '.agent_access_scope',
  '.agent_allowlist',
  '.agent_use_enabled',
  '.artifact_handoff_prompt',
  '.control_manifest',
  '.blueprint',
  '.icon_ref',
  '.icon'
] as const

type ArtifactListOptions = {
  includeContent?: boolean
  includeVersions?: boolean
  includeVersionContents?: boolean
}

function isRedisJsonMissingPathError(error: unknown): boolean {
  return error instanceof Error && /ERR Path ['"].+['"] does not exist/.test(error.message)
}

const ARTIFACT_MODEL_ROLES: ArtifactModelRole[] = ['primary', 'visual', 'audio', 'utility']

function collectArtifactModelPresetIds(modelConfig: ArtifactModelConfig): Array<{ role: ArtifactModelRole; presetId: string }> {
  const presets: Array<{ role: ArtifactModelRole; presetId: string }> = []

  for (const role of ARTIFACT_MODEL_ROLES) {
    const roleConfig = role === 'primary'
      ? modelConfig.primary
      : (modelConfig as Record<string, any>)[role]
    if (!roleConfig || roleConfig.source !== 'preset') continue

    const presetId = typeof roleConfig.presetId === 'string' ? roleConfig.presetId.trim() : ''
    if (!presetId) {
      throw Object.assign(
        new Error(
          `Artifact model role "${role}" uses source "preset" but does not include a presetId. Use source "manual" with modelId for exact model IDs.`
        ),
        { status: 400, code: 'ARTIFACT_MODEL_PRESET_REQUIRED' }
      )
    }
    presets.push({ role, presetId })
  }

  return presets
}

export interface ArtifactVersionEntry {
  id: string
  version: number
  content: string
  description?: string
  created_at: string
  created_by: string
}

function isAllowedArtifactIconRef(ref: IconRef): boolean {
  return ref.kind === 'custom' || isCatalogIconRef(ref)
}

function resolveArtifactIconRef(input: unknown, legacyInput?: unknown): IconRef | null {
  if (input === null) return null
  if (input !== undefined) {
    const parsed = parseIconRef(input)
    if (!parsed || !isAllowedArtifactIconRef(parsed)) {
      throw Object.assign(
        new Error(
          'icon_ref must use an available icon picker entry. Do not invent icon IDs; use a catalog icon such as lucide:image, lucide:search, lucide:palette, lucide:sparkles, brand:huggingface-color, brand:comfyui-color, or brand:n8n-color.'
        ),
        { status: 400 }
      )
    }
    return parsed
  }
  return normalizeOptionalIconRef(legacyInput)
}

export interface ArtifactRecord {
  id: string
  user_id: string
  name: string
  slug: string
  type: string
  content: string
  mode: ArtifactMode
  version: number
  description?: string
  tags: string[]
  metadata: Record<string, any>
  created_in_session?: string
  last_edited_session?: string
  widget_position?: string | null
  // AI brain configuration
  brain_type?: ArtifactBrainType
  ai_enabled?: boolean // legacy flag; derive from brain_type when writing
  webhook_url?: string | null
  model?: string | null // legacy: use model_config
  model_config?: ArtifactModelConfig | null
  system_prompt?: string | null
  custom_prompt?: string | null // legacy alias kept for backward compatibility
  created_at: string
  updated_at: string
  published_at: string | null
  versions: ArtifactVersionEntry[]
  zone?: ArtifactZone | null
  zone_compatibility?: ArtifactZoneCompatibility | null
  agent_access_scope?: 'all' | 'selected'
  agent_allowlist?: string[] | null
  agent_use_enabled?: boolean
  artifact_handoff_prompt?: string | null
  control_manifest?: {
    version: number
    controlIds: string[]
    generated_at: string
  } | null
  // Blueprint: planning/progress doc for multi-session artifact builds
  blueprint?: string | null
  // User-chosen structured icon (displayed in zone headers, rail, panel)
  icon_ref?: IconRef | null
  // Legacy emoji/string icon. Do not write new emoji icons.
  icon?: string | null
}

type CreateInput = {
  name?: string
  type?: string
  content?: string
  mode?: ArtifactMode
  description?: string
  tags?: string[]
  metadata?: Record<string, any>
  sessionId?: string
  slug?: string | null
  brain_type?: ArtifactBrainType
  ai_enabled?: boolean
  webhook_url?: string | null
  model?: string | null
  model_config?: ArtifactModelConfig | null
  system_prompt?: string | null
  custom_prompt?: string | null
  zone?: ArtifactZone | null
  zone_compatibility?: ArtifactZoneCompatibility | null
  agent_access_scope?: 'all' | 'selected'
  agent_allowlist?: string[] | null
  agent_use_enabled?: boolean
  artifact_handoff_prompt?: string | null
  control_manifest?: {
    version: number
    controlIds: string[]
    generated_at: string
  } | null
  blueprint?: string | null
  icon_ref?: IconRef | null
  icon?: string | null
}

type UpdateInput = Partial<Omit<ArtifactRecord, 'id' | 'user_id' | 'created_at' | 'versions' | 'version'>> & {
  content?: string
  versionDescription?: string
  sessionId?: string
  slug?: string | null
}


export class ArtifactsService {
  private redis: RedisService
  // expose the underlying client for bulk ops inside the service
  private async client() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.redis as any)['getClient']()
  }

  constructor() {
    this.redis = new RedisService()
  }

  private normalizeStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    const items = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
    if (!items.length) return []
    return Array.from(new Set(items))
  }

  private resolveAgentAllowlist(
    value: unknown,
    options?: {
      metadata?: Record<string, any> | null
      existing?: unknown
      allowMetadataFallback?: boolean
    }
  ): string[] | null {
    // Explicit null means "clear all assigned agents".
    if (value === null) return []

    const direct = this.normalizeStringArray(value)
    if (direct !== null) return direct

    const existing = this.normalizeStringArray(options?.existing)
    if (existing !== null) return existing

    if (options?.allowMetadataFallback === true) {
      const metadata = options.metadata
      const fromMetadata = this.normalizeStringArray(
        metadata?.agent_allowlist ??
          metadata?.agentAllowlist ??
          metadata?.assigned_agent_ids ??
          metadata?.assignedAgentIds
      )
      if (fromMetadata !== null) return fromMetadata
    }

    return null
  }

  private resolveAgentAccessScope(
    value: unknown,
    options?: {
      existing?: unknown
      agentUseEnabled?: boolean
      allowlist?: string[] | null
    }
  ): 'all' | 'selected' {
    const normalize = (input: unknown): 'all' | 'selected' | null => {
      if (typeof input !== 'string') return null
      const trimmed = input.trim().toLowerCase()
      if (trimmed === 'all') return 'all'
      if (trimmed === 'selected') return 'selected'
      return null
    }

    const direct = normalize(value)
    if (direct) return direct

    const existing = normalize(options?.existing)
    if (existing) return existing

    if (options?.agentUseEnabled === false) {
      return 'selected'
    }

    if (Array.isArray(options?.allowlist) && options.allowlist.length > 0) {
      return 'selected'
    }

    return 'all'
  }

  private resolveZoneCompatibility(
    value: unknown,
    metadata: Record<string, any> | null | undefined,
    fallbackZone: unknown
  ): ArtifactZoneCompatibility {
    const metadataCompatibility =
      metadata?.zone_compatibility ?? metadata?.zoneCompatibility ?? null
    const source = value !== undefined ? value : metadataCompatibility
    return normalizeArtifactZoneCompatibility(source, fallbackZone)
  }

  private isRunOnlyArtifact(metadata: Record<string, any> | null | undefined): boolean {
    if (!metadata || typeof metadata !== 'object') return false
    return metadata.run_only === true || metadata.runOnly === true
  }

  private hasFabricFields(metadata: Record<string, any> | null | undefined): boolean {
    if (!metadata || typeof metadata !== 'object') return false
    const fields = Array.isArray(metadata.fabric_fields) ? metadata.fabric_fields : []
    return fields.some((field) => typeof field?.fabricId === 'string' && field.fabricId.trim().length > 0)
  }

  private normalizeArtifactMetadata(metadata: Record<string, any> | null | undefined) {
    const normalized =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...metadata }
        : {}
    return applyBatshitArtifactStructureSetting(normalized, normalized.enforce_batshit_artifact_structure !== false)
  }

  private enforceBatshitArtifactStructure(options: {
    content: string
    metadata: Record<string, any> | null | undefined
    mode: ArtifactMode
  }) {
    if (artifactStructureValidationCanBeDeferred(options.content, options.mode)) return

    const validation = validateBatshitArtifactStructure(options.content, options.metadata)
    if (validation.ok || !validation.enforced) return

    throw Object.assign(new Error(buildArtifactStructureEnforcementMessage(validation)), {
      status: 400,
      code: 'ARTIFACT_STRUCTURE_ENFORCED',
      details: {
        issues: validation.issues,
        usesBuilderKit: validation.usesBuilderKit,
        usesStandardControls: validation.usesStandardControls,
        hasFabricRuntimeContract: validation.hasFabricRuntimeContract,
        hasFabricBindings: validation.hasFabricBindings,
        runOnly: validation.runOnly,
        fabricFieldIds: validation.fabricFieldIds
      }
    })
  }

  private enforceArtifactHtmlPreflight(content: string) {
    const preflight = validateArtifactHtmlPreflight(content)
    if (preflight.ok) return

    throw Object.assign(new Error(buildArtifactHtmlPreflightMessage(preflight)), {
      status: 400,
      code: 'ARTIFACT_HTML_PREFLIGHT_FAILED',
      details: {
        checkedScripts: preflight.checkedScripts,
        skippedScripts: preflight.skippedScripts,
        issues: preflight.issues,
        advisories: preflight.advisories
      }
    })
  }

  private enforceAgentRuntimeContract(options: {
    mode: ArtifactMode
    agentUseEnabled: boolean
    metadata: Record<string, any> | null | undefined
  }) {
    if (options.mode !== 'published') return
    if (!options.agentUseEnabled) return

    const hasFabricFields = this.hasFabricFields(options.metadata)
    const runOnly = this.isRunOnlyArtifact(options.metadata)
    if (hasFabricFields || runOnly) return

    throw Object.assign(
      new Error(
        'Agent-usable published artifacts must declare at least one metadata.fabric_fields entry, or set metadata.run_only=true for trigger-only runtime.'
      ),
      {
        status: 400,
        code: 'ARTIFACT_RUNTIME_SCHEMA_REQUIRED'
      }
    )
  }

  private enforcePublishGuard(options: {
    mode: ArtifactMode
    zone: ArtifactZone | null
    zoneCompatibility: ArtifactZoneCompatibility
  }) {
    if (options.mode !== 'published') return
    const evaluation = evaluateArtifactZonePublish(options.zoneCompatibility, options.zone)
    if (!evaluation.ok) {
      throw Object.assign(new Error(buildArtifactZonePublishError(evaluation)), {
        status: 400,
        code: 'ZONE_PUBLISH_BLOCKED',
        details: {
          zone: evaluation.zone,
          recommendedZones: evaluation.recommendedZones
        }
      })
    }
  }

  private enforceArtifactAgentUseEligibility(options: {
    artifact: Record<string, any>
    requestedAgentUseEnabled: unknown
  }) {
    const eligibility = resolveArtifactAgentUseEligibility(options.artifact)
    if (eligibility.eligible || options.requestedAgentUseEnabled !== true) return

    throw Object.assign(
      new Error(
        `${eligibility.message ?? USER_ONLY_EMBED_AGENT_USE_MESSAGE} Build a native API or webhook artifact if agents need to use it.`
      ),
      {
        status: 400,
        code: 'ARTIFACT_AGENT_USE_UNSUPPORTED'
      }
    )
  }

  private slugify(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  private projectArtifactRecord(
    projected: Record<string, unknown>,
    options: Required<ArtifactListOptions>
  ): ArtifactRecord | null {
    const read = (path: string) => {
      const value = projected[path] ?? projected[path.slice(1)]
      return Array.isArray(value) && value.length === 1 ? value[0] : value
    }

    const id = read('.id')
    const userId = read('.user_id')
    const name = read('.name')
    if (typeof id !== 'string' || typeof userId !== 'string' || typeof name !== 'string') {
      return null
    }

    const versions = options.includeVersions
      ? this.trimArtifactVersions(Array.isArray(read('.versions')) ? read('.versions') as ArtifactVersionEntry[] : [])
      : []

    const record: Partial<ArtifactRecord> = {}
    for (const path of ARTIFACT_LIST_PROJECTION_PATHS) {
      const key = path.slice(1) as keyof ArtifactRecord
      const value = read(path)
      if (value !== undefined) {
        ;(record as Record<string, unknown>)[key] = value
      }
    }

    if (options.includeContent) {
      const content = read('.content')
      record.content = typeof content === 'string' ? content : ''
    }

    if (options.includeVersions) {
      record.versions = options.includeVersionContents
        ? versions
        : versions.map((version) => {
            const { content: _content, ...summary } = version
            return summary as ArtifactVersionEntry
          })
    }

    return record as ArtifactRecord
  }

  private sanitizeUpdateInput(input: UpdateInput): UpdateInput {
    const allowed: Array<keyof UpdateInput> = [
      'name',
      'type',
      'content',
      'mode',
      'description',
      'tags',
      'metadata',
      'slug',
      'versionDescription',
      'sessionId',
      'brain_type',
      'ai_enabled',
      'webhook_url',
      'model',
      'model_config',
      'system_prompt',
      'custom_prompt',
      'zone',
      'zone_compatibility',
      'agent_access_scope',
      'agent_allowlist',
      'agent_use_enabled',
      'artifact_handoff_prompt',
      'blueprint',
      'icon_ref',
      'icon'
    ]
    const sanitized: Record<string, unknown> = {}
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        sanitized[key] = input[key]
      }
    }
    return sanitized as UpdateInput
  }

  private trimArtifactVersions(versions: ArtifactVersionEntry[] | undefined | null): ArtifactVersionEntry[] {
    if (!Array.isArray(versions)) return []
    if (versions.length <= MAX_ARTIFACT_VERSION_HISTORY) return versions
    return versions.slice(-MAX_ARTIFACT_VERSION_HISTORY)
  }

  private resolveNextSlug(
    existing: ArtifactRecord,
    updates: UpdateInput,
    id: string
  ): Promise<string> {
    const nextName = typeof updates.name === 'string' ? updates.name : existing.name
    const hasProvidedSlug = Object.prototype.hasOwnProperty.call(updates, 'slug')
    const hasNameChange =
      Object.prototype.hasOwnProperty.call(updates, 'name') &&
      typeof updates.name === 'string' &&
      updates.name !== existing.name

    if (!hasProvidedSlug && !hasNameChange && existing.slug?.trim()) {
      return Promise.resolve(existing.slug)
    }

    return this.generateSlug(
      existing.user_id,
      nextName || existing.name || 'artifact',
      hasProvidedSlug ? updates.slug : existing.slug,
      id
    )
  }

  private async getExistingSlugs(userId: string, ignoreId?: string) {
    const client = await this.client()
    const artifactIds = await client.sMembers(`user:${userId}:artifacts`)
    const slugs = new Set<string>()

    for (const id of artifactIds) {
      if (ignoreId && id === ignoreId) continue
      try {
        const existingSlug = await client.json.get(`artifact:${id}`, { path: '.slug' })
        if (typeof existingSlug === 'string' && existingSlug.trim().length > 0) {
          slugs.add(existingSlug.trim())
        }
      } catch (err) {
        console.warn(`[ArtifactsService] Failed to load slug for ${id}`, err)
      }
    }

    return slugs
  }

  private async generateSlug(userId: string, name: string, provided?: string | null, ignoreId?: string) {
    const baseCandidate = this.slugify(provided || name || 'artifact') || 'artifact'
    const existingSlugs = await this.getExistingSlugs(userId, ignoreId)

    // If user explicitly provided a slug, enforce uniqueness (no auto suffix)
    if (provided && provided.trim().length > 0) {
      if (existingSlugs.has(baseCandidate)) {
        throw Object.assign(new Error('Slug already in use'), { status: 409 })
      }
      return baseCandidate
    }

    // Auto-generated slugs may use suffixes to avoid collisions
    let attempt = baseCandidate
    let counter = 1
    while (existingSlugs.has(attempt)) {
      counter += 1
      attempt = `${baseCandidate}_v${counter}`
    }

    return attempt
  }

  private async ensureRecordSlug(record: ArtifactRecord, client: any) {
    if (record.slug && record.slug.trim().length > 0) return record
    const newSlug = await this.generateSlug(record.user_id, record.name, record.slug || record.name, record.id)
    record.slug = newSlug
    await client.json.set(`artifact:${record.id}`, '$.slug', newSlug)
    return record
  }

  async listByUser(userId: string, options: ArtifactListOptions = {}): Promise<ArtifactRecord[]> {
    const listOptions: Required<ArtifactListOptions> = {
      includeContent: options.includeContent === true,
      includeVersions: options.includeVersions === true,
      includeVersionContents: options.includeVersionContents === true
    }
    const client = await this.client()
    const artifactIds = await client.sMembers(`user:${userId}:artifacts`)
    const records: ArtifactRecord[] = []

    for (const id of artifactIds) {
      try {
        const projectionPaths = [
          ...ARTIFACT_LIST_PROJECTION_PATHS,
          ...(listOptions.includeContent ? ['.content'] : []),
          ...(listOptions.includeVersions ? ['.versions'] : [])
        ]
        let artifact: unknown
        try {
          artifact = await client.json.get(`artifact:${id}`, { path: projectionPaths })
        } catch (err) {
          if (!isRedisJsonMissingPathError(err)) throw err
          artifact = await client.json.get(`artifact:${id}`)
        }
        if (artifact) {
          const projected = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
            ? artifact as Record<string, unknown>
            : {}
          const listRecord = this.projectArtifactRecord(projected, listOptions)
          if (!listRecord) continue
          const record = await this.ensureRecordSlug(listRecord, client)
          if ('widget_position' in record && record.widget_position !== null) {
            record.widget_position = null
            await client.json.set(`artifact:${id}`, '$.widget_position', null)
          }
          records.push(record)
        }
      } catch (err) {
        console.warn(`[ArtifactsService] Failed to load artifact ${id}`, err)
      }
    }

    records.sort((a, b) => {
      const aTime = new Date(a.updated_at || a.created_at || 0).getTime()
      const bTime = new Date(b.updated_at || b.created_at || 0).getTime()
      return bTime - aTime
    })

    return records
  }

  async getAccessible(id: string, requesterId: string): Promise<ArtifactRecord | null> {
    const client = await this.client()
    const artifact = await client.json.get(`artifact:${id}`)
    if (!artifact) return null
    const record = await this.ensureRecordSlug(artifact as ArtifactRecord, client)

    if (record.user_id === requesterId || record.mode === 'published') {
      return record
    }
    return null
  }

  /** Build a human-readable artifact ID: artifact_{name-slug}_{6-char-random} */
  private buildArtifactId(name: string): string {
    const nameSlug = (name || 'artifact')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'artifact'
    // Cap the slug portion to 40 chars so IDs stay reasonable
    const capped = nameSlug.slice(0, 40).replace(/-+$/, '')
    return `artifact_${capped}_${nanoid(6)}`
  }

  private async enforceKnownModelPresets(userId: string, modelConfig: ArtifactModelConfig): Promise<void> {
    const presets = collectArtifactModelPresetIds(modelConfig)
    if (presets.length === 0) return

    const client = await this.client()
    const ownedPresetIds = new Set(await client.sMembers(`user:${userId}:models`))

    for (const { role, presetId } of presets) {
      const exists = ownedPresetIds.has(presetId) && (await client.exists(`model:${presetId}`)) === 1
      if (exists) continue

      throw Object.assign(
        new Error(
          `Artifact model role "${role}" references unknown saved preset "${presetId}". Use an existing saved preset ID, or use source "manual" with modelId when you know the exact provider model ID.`
        ),
        { status: 400, code: 'ARTIFACT_MODEL_PRESET_NOT_FOUND' }
      )
    }
  }

  async create(userId: string, input: CreateInput): Promise<ArtifactRecord> {
    const now = new Date().toISOString()
    const artifactId = this.buildArtifactId(input.name || 'artifact')
    const initialContent = input.content || ''
    const brainType: ArtifactRecord['brain_type'] =
      input.brain_type ||
      (input.webhook_url ? 'webhook' : input.ai_enabled === false ? 'none' : 'built_in')
    const usesWebhook =
      brainType === 'webhook' || brainType === 'n8n_workflow' || brainType === 'custom_webhook'
    const modelConfig = normalizeArtifactModelConfig(input.model_config ?? null, input.model ?? null)
    if (input.model_config !== undefined) {
      await this.enforceKnownModelPresets(userId, modelConfig)
    }
    const metadata = this.normalizeArtifactMetadata(input.metadata)
    const zone = normalizeArtifactZone(input.zone)
    const zoneCompatibility = this.resolveZoneCompatibility(
      input.zone_compatibility,
      metadata,
      zone
    )
    const mode = input.mode || 'edit'
    const agentUseEligibilityArtifact = {
      brain_type: brainType,
      ai_enabled: brainType !== 'none',
      metadata,
      icon_ref: input.icon_ref,
      icon: input.icon
    }
    this.enforceArtifactAgentUseEligibility({
      artifact: agentUseEligibilityArtifact,
      requestedAgentUseEnabled: input.agent_use_enabled
    })
    const agentUseEligible = resolveArtifactAgentUseEligibility(agentUseEligibilityArtifact).eligible
    const agentUseEnabled = agentUseEligible ? input.agent_use_enabled !== false : false
    const resolvedAgentAllowlist = this.resolveAgentAllowlist(input.agent_allowlist, {
      metadata,
      allowMetadataFallback: true
    })
    const agentAllowlist = agentUseEnabled ? resolvedAgentAllowlist : []
    const agentAccessScope = this.resolveAgentAccessScope((input as any).agent_access_scope, {
      agentUseEnabled,
      allowlist: agentAllowlist
    })
    this.enforceBatshitArtifactStructure({
      content: initialContent,
      metadata,
      mode
    })
    this.enforceArtifactHtmlPreflight(initialContent)
    this.enforcePublishGuard({
      mode,
      zone,
      zoneCompatibility
    })
    this.enforceAgentRuntimeContract({
      mode,
      agentUseEnabled,
      metadata
    })
    const slug = await this.generateSlug(userId, input.name || 'artifact', input.slug, artifactId)
    const versionEntry: ArtifactVersionEntry = {
      id: `v1_${nanoid()}`,
      version: 1,
      content: initialContent,
      description: 'Initial version',
      created_at: now,
      created_by: userId
    }

    const artifact: ArtifactRecord = {
      id: artifactId,
      user_id: userId,
      name: input.name || 'Untitled Artifact',
      slug,
      type: input.type || 'html',
      content: initialContent,
      mode,
      version: 1,
      description: input.description || '',
      tags: input.tags || [],
      metadata,
      created_in_session: input.sessionId || '',
      last_edited_session: input.sessionId || '',
      brain_type: brainType,
      ai_enabled: brainType !== 'none',
      webhook_url: usesWebhook ? input.webhook_url || null : null,
      model: null,
      model_config: modelConfig,
      system_prompt: input.system_prompt || input.custom_prompt || null,
      custom_prompt: input.custom_prompt || null,
      zone,
      zone_compatibility: zoneCompatibility,
      widget_position: null,
      agent_access_scope: agentAccessScope,
      agent_allowlist: agentAllowlist,
      agent_use_enabled: agentUseEnabled,
      artifact_handoff_prompt:
        typeof input.artifact_handoff_prompt === 'string'
          ? input.artifact_handoff_prompt
          : null,
      control_manifest:
        input.control_manifest && typeof input.control_manifest === 'object'
          ? input.control_manifest
          : null,
      blueprint: input.blueprint || null,
      icon_ref: resolveArtifactIconRef(input.icon_ref, input.icon),
      icon: null,
      created_at: now,
      updated_at: now,
      published_at: mode === 'published' ? now : null,
      versions: [versionEntry]
    }

    const client = await this.client()
    await client.json.set(`artifact:${artifactId}`, '$', artifact)
    await client.sAdd(`user:${userId}:artifacts`, artifactId)

    return artifact
  }

  async update(id: string, userId: string, input: UpdateInput): Promise<ArtifactRecord> {
    const updates = this.sanitizeUpdateInput(input)
    const client = await this.client()
    const existing = await client.json.get(`artifact:${id}`) as ArtifactRecord | null
    if (!existing) {
      throw Object.assign(new Error('Artifact not found'), { status: 404 })
    }
    if (existing.user_id !== userId) {
      throw Object.assign(new Error('Access denied'), { status: 403 })
    }

    const now = new Date().toISOString()
    let versions = existing.versions || []
    let nextVersion = existing.version

    // Normalize brain type for backward compatibility
    const resolvedBrainType: ArtifactRecord['brain_type'] = updates.brain_type
      || existing.brain_type
      || (existing.webhook_url ? 'webhook' : existing.ai_enabled === false ? 'none' : 'built_in')
    const usesWebhook =
      resolvedBrainType === 'webhook' ||
      resolvedBrainType === 'n8n_workflow' ||
      resolvedBrainType === 'custom_webhook'
    const modelConfigInput =
      updates.model_config !== undefined ? updates.model_config : existing.model_config
    const legacyModelInput = updates.model !== undefined ? updates.model : existing.model
    const resolvedModelConfig = normalizeArtifactModelConfig(modelConfigInput ?? null, legacyModelInput ?? null)
    if (updates.model_config !== undefined) {
      await this.enforceKnownModelPresets(userId, resolvedModelConfig)
    }
    const metadata = this.normalizeArtifactMetadata(
      updates.metadata && typeof updates.metadata === 'object' && !Array.isArray(updates.metadata)
        ? { ...(existing.metadata ?? {}), ...updates.metadata }
        : existing.metadata ?? {}
    )
    const zone = 'zone' in updates ? normalizeArtifactZone(updates.zone) : normalizeArtifactZone(existing.zone)
    const zoneCompatibilityInput =
      'zone_compatibility' in updates
        ? updates.zone_compatibility
        : (updates as any).zoneCompatibility
    const zoneCompatibility = this.resolveZoneCompatibility(
      zoneCompatibilityInput,
      metadata,
      zone
    )
    const nextMode = (updates.mode ?? existing.mode ?? 'edit') as ArtifactMode
    const nextContent = updates.content ?? existing.content ?? ''
    const requestedNextAgentUseEnabled =
      typeof (updates as any).agent_use_enabled === 'boolean'
        ? (updates as any).agent_use_enabled
        : existing.agent_use_enabled !== false
    const agentUseEligibilityArtifact = {
      ...existing,
      ...updates,
      brain_type: resolvedBrainType,
      ai_enabled: resolvedBrainType !== 'none',
      metadata,
      icon_ref:
        (updates as any).icon_ref !== undefined || (updates as any).icon !== undefined
          ? ((updates as any).icon_ref ?? existing.icon_ref)
          : existing.icon_ref,
      icon: (updates as any).icon ?? existing.icon
    }
    this.enforceArtifactAgentUseEligibility({
      artifact: agentUseEligibilityArtifact,
      requestedAgentUseEnabled: (updates as any).agent_use_enabled
    })
    const agentUseEligible = resolveArtifactAgentUseEligibility(agentUseEligibilityArtifact).eligible
    const nextAgentUseEnabled = agentUseEligible ? requestedNextAgentUseEnabled : false
    const resolvedNextAgentAllowlist = this.resolveAgentAllowlist(
      (updates as any).agent_allowlist,
      {
        existing: existing.agent_allowlist
      }
    )
    const nextAgentAllowlist = nextAgentUseEnabled ? resolvedNextAgentAllowlist : []
    const nextAgentAccessScope = this.resolveAgentAccessScope((updates as any).agent_access_scope, {
      existing: existing.agent_access_scope,
      agentUseEnabled: nextAgentUseEnabled,
      allowlist: nextAgentAllowlist
    })
    this.enforceBatshitArtifactStructure({
      content: nextContent,
      metadata,
      mode: nextMode
    })
    this.enforceArtifactHtmlPreflight(nextContent)
    this.enforcePublishGuard({
      mode: nextMode,
      zone,
      zoneCompatibility
    })
    const shouldEnforceRuntimeContract =
      nextMode === 'published' &&
      (existing.mode !== 'published' ||
        typeof (updates as any).agent_use_enabled === 'boolean' ||
        (updates.metadata !== undefined && typeof updates.metadata === 'object' && !Array.isArray(updates.metadata)))
    if (shouldEnforceRuntimeContract) {
      this.enforceAgentRuntimeContract({
        mode: nextMode,
        agentUseEnabled: nextAgentUseEnabled,
        metadata
      })
    }

    if (updates.content !== undefined && updates.content !== existing.content) {
      nextVersion = existing.version + 1
      versions = [
        ...versions,
        {
          id: `v${nextVersion}_${nanoid()}`,
          version: nextVersion,
          content: updates.content,
          description: updates.versionDescription || `Updated on ${new Date().toLocaleDateString()}`,
          created_at: now,
          created_by: userId
        }
      ]
    }
    versions = this.trimArtifactVersions(versions)

    const publishedBecameTrue = nextMode === 'published' && existing.mode !== 'published'
    const nextSlug = await this.resolveNextSlug(existing, updates, id)
    const nextAgentUseField = agentUseEligible
      ? (typeof (updates as any).agent_use_enabled === 'boolean'
          ? (updates as any).agent_use_enabled
          : existing.agent_use_enabled ?? undefined)
      : false

    const updated: ArtifactRecord = {
      ...existing,
      name: typeof updates.name === 'string' && updates.name.trim().length > 0
        ? updates.name
        : existing.name,
      type: typeof updates.type === 'string' && updates.type.trim().length > 0
        ? updates.type
        : existing.type,
      content: nextContent,
      mode: nextMode,
      description: typeof updates.description === 'string' ? updates.description : existing.description ?? '',
      tags: Array.isArray(updates.tags) ? updates.tags : existing.tags ?? [],
      slug: nextSlug,
      brain_type: resolvedBrainType,
      ai_enabled: resolvedBrainType !== 'none',
      webhook_url: usesWebhook ? (updates.webhook_url ?? existing.webhook_url ?? null) : null,
      version: nextVersion,
      versions,
      model: null,
      model_config: resolvedModelConfig,
      system_prompt: updates.system_prompt ?? updates.custom_prompt ?? existing.system_prompt ?? existing.custom_prompt ?? null,
      custom_prompt: updates.custom_prompt ?? existing.custom_prompt ?? null,
      metadata,
      zone,
      zone_compatibility: zoneCompatibility,
      agent_access_scope: nextAgentAccessScope,
      agent_allowlist: nextAgentAllowlist,
      agent_use_enabled: nextAgentUseField,
      artifact_handoff_prompt:
        typeof (updates as any).artifact_handoff_prompt === 'string'
          ? (updates as any).artifact_handoff_prompt
          : existing.artifact_handoff_prompt ?? null,
      control_manifest: existing.control_manifest ?? null,
      blueprint: typeof updates.blueprint === 'string'
        ? updates.blueprint
        : updates.blueprint === null
          ? null
          : existing.blueprint ?? null,
      icon_ref:
        (updates as any).icon_ref !== undefined || (updates as any).icon !== undefined
          ? resolveArtifactIconRef((updates as any).icon_ref, (updates as any).icon)
          : (existing.icon_ref ?? normalizeOptionalIconRef(existing.icon)),
      icon: null,
      last_edited_session: updates.sessionId || existing.last_edited_session,
      updated_at: now,
      published_at: publishedBecameTrue ? now : existing.published_at ?? null,
      // Legacy cleanup: drop widget_position in favour of zone
      widget_position: null
    }

    await client.json.set(`artifact:${id}`, '$', updated)
    return updated
  }

  async validateStructure(
    userId: string,
    input: {
      artifactId?: string
      content?: string | null
      metadata?: Record<string, any> | null
      mode?: ArtifactMode
    }
  ): Promise<{
    valid: boolean
    canSave: boolean
    canDefer: boolean
    enforced: boolean
    mode: ArtifactMode
    artifactId: string | null
    usesBuilderKit: boolean
    usesStandardControls: boolean
    hasFabricRuntimeContract: boolean
    hasFabricBindings: boolean
    runOnly: boolean
    fabricFieldIds: string[]
    issues: Array<{ code: string; message: string }>
    advisories: string[]
    htmlPreflight: ArtifactHtmlPreflightResult
    message: string
  }> {
    const artifactId = typeof input.artifactId === 'string' && input.artifactId.trim().length > 0
      ? input.artifactId.trim()
      : null
    const existing = artifactId ? await this.getOwned(artifactId, userId) : null

    const metadata = this.normalizeArtifactMetadata(
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? { ...(existing?.metadata ?? {}), ...input.metadata }
        : existing?.metadata ?? {}
    )
    const mode = (input.mode ?? existing?.mode ?? 'edit') as ArtifactMode
    const content = input.content !== undefined ? (input.content ?? '') : (existing?.content ?? '')
    const validation = validateBatshitArtifactStructure(content, metadata)
    const htmlPreflight = validateArtifactHtmlPreflight(content)
    const canDefer = artifactStructureValidationCanBeDeferred(content, mode)
    const canSave = htmlPreflight.ok && (validation.ok || !validation.enforced || canDefer)
    const advisories: string[] = []

    for (const advisory of htmlPreflight.advisories) {
      const lineSuffix = typeof advisory.line === 'number' ? ` Line ${advisory.line}:` : ''
      advisories.push(`${lineSuffix} ${advisory.message}`.trim())
    }

    if (!validation.usesStandardControls && !isRunOnlyMetadata(metadata)) {
      advisories.push(buildArtifactStandardControlsAdvisory())
    }

    if (validation.enforced && canDefer) {
      advisories.push(
        'This draft is still in scaffold mode, so Batshit will allow it for now. Once real content is saved, Builder Kit + Fabric become mandatory unless the user manually turns enforcement off for this artifact.'
      )
    }

    let message = 'Artifact structure is valid for save.'
    if (!htmlPreflight.ok) {
      message = buildArtifactHtmlPreflightMessage(htmlPreflight)
    } else if (!canSave) {
      message = buildArtifactStructureEnforcementMessage(validation)
    } else if (advisories.length > 0) {
      message = advisories[0]
    }

    return {
      valid: canSave,
      canSave,
      canDefer,
      enforced: validation.enforced,
      mode,
      artifactId: existing?.id ?? artifactId,
      usesBuilderKit: validation.usesBuilderKit,
      usesStandardControls: validation.usesStandardControls,
      hasFabricRuntimeContract: validation.hasFabricRuntimeContract,
      hasFabricBindings: validation.hasFabricBindings,
      runOnly: validation.runOnly,
      fabricFieldIds: validation.fabricFieldIds,
      issues: [
        ...htmlPreflight.issues.map((issue) => ({
          code: issue.code,
          message: issue.message
        })),
        ...validation.issues
      ],
      advisories,
      htmlPreflight,
      message
    }
  }

  async applyPatch(
    id: string,
    userId: string,
    patch: string,
    options?: {
      versionDescription?: string
      sessionId?: string
    }
  ): Promise<ArtifactRecord> {
    const artifact = await this.getOwned(id, userId)
    const patchDocument = extractManagedApplyPatchPayload(patch) ?? patch.trim()
    const parsed = parseManagedApplyPatchDocument(patchDocument)

    if (!parsed.success) {
      throw Object.assign(new Error(parsed.message), {
        status: 400,
        code: 'INVALID_ARTIFACT_PATCH'
      })
    }

    if (parsed.operations.length !== 1) {
      throw Object.assign(
        new Error('Artifact apply_patch only supports a single "*** Update File" operation.'),
        {
          status: 400,
          code: 'INVALID_ARTIFACT_PATCH'
        }
      )
    }

    const [operation] = parsed.operations
    if (operation.type !== 'update' || operation.moveToPath) {
      throw Object.assign(
        new Error(
          'Artifact apply_patch only supports in-place "*** Update File" operations with hunks.'
        ),
        {
          status: 400,
          code: 'INVALID_ARTIFACT_PATCH'
        }
      )
    }

    if (operation.filePath.trim() !== 'artifact.html') {
      throw Object.assign(
        new Error('Artifact apply_patch requires the patch target to be exactly "*** Update File: artifact.html".'),
        {
          status: 400,
          code: 'INVALID_ARTIFACT_PATCH'
        }
      )
    }

    let nextContent: string
    try {
      nextContent = applyManagedPatchHunks({
        content: artifact.content || '',
        hunks: (operation as ManagedApplyPatchUpdateOperation).hunks,
        filePath: 'artifact.html'
      })
    } catch (error) {
      throw Object.assign(
        new Error(
          error instanceof Error ? error.message : 'Artifact apply_patch failed to match the target content.'
        ),
        {
          status: 400,
          code: 'INVALID_ARTIFACT_PATCH'
        }
      )
    }

    return await this.update(id, userId, {
      content: nextContent,
      versionDescription: options?.versionDescription,
      sessionId: options?.sessionId
    })
  }

  async delete(id: string, userId: string): Promise<void> {
    const client = await this.client()
    const artifact = await client.json.get(`artifact:${id}`) as ArtifactRecord | null
    if (!artifact) {
      throw Object.assign(new Error('Artifact not found'), { status: 404 })
    }
    if (artifact.user_id !== userId) {
      throw Object.assign(new Error('Access denied'), { status: 403 })
    }

    await deleteArtifactRunLogs({ userId, artifactId: id })
    await client.del(`artifact_runtime_storage:${userId}:${id}`)
    await client.json.del(`artifact:${id}`, '$')
    await client.sRem(`user:${userId}:artifacts`, id)

  }

  async getOwned(id: string, userId: string): Promise<ArtifactRecord> {
    const client = await this.client()
    const artifact = await client.json.get(`artifact:${id}`) as ArtifactRecord | null
    if (!artifact) {
      throw Object.assign(new Error('Artifact not found'), { status: 404 })
    }
    const ownerId = (artifact as any).userId || artifact.user_id
    if (ownerId !== userId) {
      throw Object.assign(new Error('Access denied'), { status: 403 })
    }
    return await this.ensureRecordSlug(artifact, client)
  }

  async addVersion(id: string, userId: string, content: string, description?: string): Promise<ArtifactRecord> {
    return await this.update(id, userId, {
      content,
      versionDescription: description || `Updated on ${new Date().toLocaleDateString()}`
    })
  }

  async rollbackToVersion(id: string, userId: string, targetVersion: number): Promise<ArtifactRecord> {
    const artifact = await this.getOwned(id, userId)
    const match = (artifact.versions || []).find(v => v.version === targetVersion)
    if (!match) {
      throw Object.assign(new Error('Version not found'), { status: 404 })
    }
    return await this.addVersion(id, userId, match.content, `Restored from version ${targetVersion}`)
  }

  async deleteVersion(id: string, userId: string, versionNumber: number): Promise<ArtifactRecord> {
    const client = await this.client()
    const artifact = await this.getOwned(id, userId)

    if (versionNumber === artifact.version) {
      throw Object.assign(new Error('Cannot delete current version'), { status: 400 })
    }

    const versions = this.trimArtifactVersions((artifact.versions || []).filter(v => v.version !== versionNumber))
    if (versions.length === 0) {
      throw Object.assign(new Error('Cannot delete the only version'), { status: 400 })
    }

    const updated: ArtifactRecord = {
      ...artifact,
      versions,
      updated_at: new Date().toISOString()
    }

    await client.json.set(`artifact:${id}`, '$', updated)
    return updated
  }
}
