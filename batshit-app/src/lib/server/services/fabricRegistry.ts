import { z } from 'zod'
import { redis } from '$lib/server/redis'
import {
  DEFAULT_DYNAMIC_MCP_RESULTS,
  MAX_DYNAMIC_MCP_RESULTS,
  executeDynamicMcpFind as executeSharedDynamicMcpFind,
  executeDynamicMcpUse as executeSharedDynamicMcpUse
} from './dynamicMcpTools'
import { ArtifactsService, type ArtifactRecord } from '$lib/server/artifacts/artifactsService'
import { isArtifactAgentUseEligible } from '$lib/artifacts/agentUseEligibility'
import { importSkillDefinition, toImportErrorResponse, type SkillImportInput } from './skillImport'
import { upsertSkill } from './skillRegistry'
import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  createCliTool,
  deleteCliTool,
  getCliTool,
  listCliTools,
  updateCliTool,
  validateCliTool
} from '$lib/server/services/cliToolRegistry'
import { checkByoSpeechStatus } from '$lib/server/services/voiceService'
import { completeLocalVoiceEngineSetup } from '$lib/server/services/voiceLocalEngineSetup'
import {
  deleteVoiceEngineModel,
  downloadVoiceEngineModel,
  useVoiceEngineModel
} from '$lib/server/services/voiceEngineModels'
import {
  deleteVoiceEngineRecord,
  setVoiceEngineEnabled,
  upsertVoiceEngineRecord,
  voiceEngineModelCatalogSchema,
  voiceEngineSttDefaultsSchema,
  voiceEngineTtsDefaultsSchema
} from '$lib/server/services/voiceEngineRegistry'
import {
  RUNTIME_ADDON_IDS,
  controlRuntimeAddon,
  getRuntimeAddonStatus,
  listRuntimeAddons,
  prepareRuntimeAddon
} from '$lib/server/services/runtimeAddons'
import {
  fetchVercelModelCatalog,
  type VercelCatalogEntry
} from '$lib/server/services/vercelModelCatalog'
import { detectImageModel } from '$lib/server/services/imageModelDetection'
import {
  DEFAULT_SKILL_ICON_REF
} from '$lib/icons/iconCatalog'
import { isIconRef, parseIconRef, type IconRef } from '$lib/icons/iconTypes'
import { normalizeOptionalIconRef } from '$lib/icons/iconLegacy'
import type { CatalogModelIdVariant } from '$lib/types/modelCatalog'
import type {
  CliToolRecord,
  SkillDependencyRequirement,
  SkillStandardsStatus,
  SlashCommandRow
} from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { normalizeArtifactModelConfig } from '$lib/utils/artifactModelConfig'
import { buildCompactEditPreview } from '$lib/utils/editDiff'
import {
  getArtifactRunLog,
  listArtifactRunLogs
} from '$lib/server/artifacts/artifactRunLogs'
import {
  buildArtifactZonePublishError,
  evaluateArtifactZonePublish,
  normalizeArtifactZone,
  normalizeArtifactZoneCompatibility,
  type ArtifactZone,
  type ArtifactZoneCompatibility
} from '$lib/artifacts/zoneCompatibility'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type ControlSourceType = 'core' | 'artifact' | 'workflow' | 'plugin'
export type ControlExecutorType = 'internal_handler' | 'artifact_use' | 'workflow_run' | 'bash_adapter'
export type ControlRiskLevel = 'safe' | 'confirm' | 'restricted'
export type ControlStatus = 'draft' | 'published' | 'deprecated'
export type ControlRuntimeMode = 'mode1' | 'mode2' | 'mode3' | 'mode4'

/**
 * Registry storage contract lock:
 * - Core controls stay code-defined for deterministic runtime handlers.
 * - Extensible controls (artifact/engine/user-added) are stored in Redis JSON.
 */
export const CONTROL_REGISTRY_SCHEMA_VERSION = 1 as const
export function buildControlRegistryKey(userId: string): string {
  return `control_registry:${userId}`
}

const controlRegistryUiOptionSchema = z
  .object({
    label: z.string().trim().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()])
  })
  .strict()

const iconRefInputSchema = z.custom((value) => isIconRef(value), 'Invalid iconRef')

const controlRegistryUiFieldSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    required: z.boolean().optional(),
    defaultValue: z.any().optional(),
    placeholder: z.string().trim().min(1).optional(),
    options: z.array(controlRegistryUiOptionSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    pattern: z.string().trim().min(1).optional()
  })
  .passthrough()

const controlRegistryUiSectionSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    fields: z.array(controlRegistryUiFieldSchema).optional()
  })
  .passthrough()

const controlRegistryUiSchema = z
  .object({
    panelTitle: z.string().trim().min(1).optional(),
    fields: z.array(controlRegistryUiFieldSchema).optional(),
    sections: z.array(controlRegistryUiSectionSchema).optional()
  })
  .passthrough()

const controlRegistryScopeSchema = z
  .object({
    allowedAgentIds: z.array(z.string().trim().min(1)).optional(),
    blockedAgentIds: z.array(z.string().trim().min(1)).optional(),
    modeAllowList: z.array(z.enum(['mode1', 'mode2', 'mode3', 'mode4'])).optional(),
    hiddenFromFind: z.boolean().optional()
  })
  .strict()

const controlRegistryExecutorConfigSchema = z
  .object({
    handlerId: z.string().trim().min(1).optional(),
    toolName: z.string().trim().min(1).optional(),
    workflowId: z.string().trim().min(1).optional(),
    artifactId: z.string().trim().min(1).optional(),
    selectedGateways: z.array(z.string().trim().min(1)).optional(),
    defaultInput: z.record(z.string(), z.any()).optional(),
    target: z.record(z.string(), z.any()).optional()
  })
  .passthrough()

export const controlRegistryRecordSchema = z
  .object({
    controlId: z.string().trim().min(1),
    sourceType: z.enum(['core', 'artifact', 'workflow', 'plugin']),
    executorType: z.enum(['internal_handler', 'artifact_use', 'workflow_run', 'bash_adapter']),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    inputSchema: z.record(z.string(), z.any()),
    outputSchema: z.record(z.string(), z.any()).nullable().optional(),
    schemaHint: z.string().trim().min(1),
    riskLevel: z.enum(['safe', 'confirm', 'restricted']),
    status: z.enum(['draft', 'published', 'deprecated']),
    tags: z.array(z.string().trim().min(1)),
    scope: controlRegistryScopeSchema.optional(),
    executorConfig: controlRegistryExecutorConfigSchema.optional(),
    ui: controlRegistryUiSchema.optional(),
    version: z.number().int().min(1).optional(),
    createdAt: z.string().trim().min(1).optional(),
    updatedAt: z.string().trim().min(1).optional(),
    createdBy: z.string().trim().min(1).optional(),
    updatedBy: z.string().trim().min(1).optional(),
    origin: z.enum(['system', 'user', 'agent']).optional()
  })
  .passthrough()

export const controlRegistryStoreSchema = z
  .object({
    version: z.literal(CONTROL_REGISTRY_SCHEMA_VERSION),
    records: z.array(controlRegistryRecordSchema).default([])
  })
  .strict()

type ControlRegistryRecord = z.infer<typeof controlRegistryRecordSchema>
type ControlRegistryStore = z.infer<typeof controlRegistryStoreSchema>

type ControlExecutionContext = {
  userId: string
  agentId?: string | null
  sessionId?: string | null
  selectedGateways?: string[]
}

type ControlHandler = (
  context: ControlExecutionContext,
  input: Record<string, any>
) => Promise<Record<string, any>>

type ControlDefinition = {
  controlId: string
  sourceType: ControlSourceType
  executorType: ControlExecutorType
  title: string
  description: string
  inputSchema: z.ZodTypeAny
  inputSchemaJson: Record<string, any>
  outputSchema: Record<string, any> | null
  schemaHint: string
  riskLevel: ControlRiskLevel
  status: ControlStatus
  tags: string[]
  scope?: z.infer<typeof controlRegistryScopeSchema>
  executorConfig?: z.infer<typeof controlRegistryExecutorConfigSchema>
  origin?: 'system' | 'user' | 'agent'
  handler?: ControlHandler
}

const MAX_DYNAMIC_RESULTS = MAX_DYNAMIC_MCP_RESULTS
const DEFAULT_DYNAMIC_RESULTS = DEFAULT_DYNAMIC_MCP_RESULTS
const MAX_CONTROL_RESULTS = 50
const DEFAULT_CONTROL_RESULTS = 20
const MAX_ZIP_CHARS = 250_000
const DEFAULT_ZIP_CHARS = 16_000
const DEFAULT_MODEL_CATALOG_RESULTS = 8
const MAX_MODEL_CATALOG_RESULTS = 25
const DYNAMIC_ARTIFACT_CONTROL_PREFIX = 'artifact.'

const zipFetchInputSchema = z.object({
  zipId: z.string().trim().min(1),
  includeContent: z.boolean().optional(),
  maxChars: z.number().int().min(64).max(MAX_ZIP_CHARS).optional()
})

const dynamicFindInputSchema = z.object({
  query: z.string().optional(),
  tool: z.string().optional(),
  group: z.union([z.string(), z.array(z.string())]).optional(),
  exact: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_DYNAMIC_RESULTS).optional(),
  includeSchema: z.boolean().optional(),
  selectedGateways: z.array(z.string()).optional(),
  projectPath: z.string().trim().min(1).optional()
})

const dynamicUseInputSchema = z.object({
  toolName: z.string().trim().min(1),
  params: z.record(z.string(), z.any()).optional(),
  selectedGateways: z.array(z.string()).optional(),
  projectPath: z.string().trim().min(1).optional()
})

const voiceEngineSupportsSchema = z
  .object({
    tts: z.boolean().optional(),
    stt: z.boolean().optional(),
    clone: z.boolean().optional()
  })
  .strict()

const voiceEnginePayloadSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    supports: voiceEngineSupportsSchema.optional(),
    adapterId: z.string().trim().min(1).optional(),
    endpointId: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    ttsPath: z.string().trim().min(1).optional(),
    sttPath: z.string().trim().min(1).optional(),
    healthPath: z.string().trim().min(1).optional(),
    authMode: z.enum(['none', 'bearer', 'header']).optional(),
    authHeader: z.string().trim().min(1).optional(),
    authToken: z.string().trim().min(1).optional(),
    authSavedKeyRef: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    iconRef: iconRefInputSchema.nullable().optional(),
    ttsDefaults: voiceEngineTtsDefaultsSchema.optional(),
    sttDefaults: voiceEngineSttDefaultsSchema.optional(),
    sttModelCatalog: voiceEngineModelCatalogSchema.optional(),
    uiSchema: controlRegistryUiSchema.optional()
  })
  .passthrough()

const voiceEngineMutationSchema = z.object({
  engineId: z.string().trim().min(1),
  payload: voiceEnginePayloadSchema.optional()
})

const voiceEngineHealthCheckInputSchema = z.object({
  engineId: z.string().trim().min(1)
})

const voiceEngineDeleteInputSchema = z.object({
  engineId: z.string().trim().min(1),
  deleteLocalFiles: z.boolean().optional()
})

const voiceEngineEnableInputSchema = z.object({
  engineId: z.string().trim().min(1),
  enabled: z.boolean()
})

const voiceEngineModelActionInputSchema = z.object({
  engineId: z.string().trim().min(1),
  modelId: z.string().trim().min(1)
})

const localVoiceEngineLaunchSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    unsetEnv: z.array(z.string().trim().min(1)).optional(),
    envFromApiKeys: z.record(z.string(), z.string().trim().min(1)).optional(),
    logPath: z.string().trim().min(1).optional()
  })
  .strict()

const localVoiceEngineSmokeSchema = z
  .object({
    mode: z.enum(['tts', 'stt']).optional(),
    text: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    voiceId: z.string().trim().min(1).nullable().optional(),
    profileId: z.string().trim().min(1).nullable().optional(),
    options: voiceEngineTtsDefaultsSchema.optional(),
    audioBase64: z.string().trim().min(1).optional(),
    audioContentType: z.string().trim().min(1).optional(),
    expectedText: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional()
  })
  .strict()

const localVoiceEngineSetupInputSchema = z
  .object({
    engineId: z.string().trim().min(1),
    installRoot: z.string().trim().min(1),
    installOwnership: z.enum(['batshit-managed', 'user-managed']).optional(),
    launch: localVoiceEngineLaunchSchema,
    payload: voiceEnginePayloadSchema,
    smoke: localVoiceEngineSmokeSchema.optional(),
    readinessTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
    pollIntervalMs: z.number().int().min(250).max(30_000).optional()
  })
  .strict()

const skillDependencySchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    required: z.boolean().optional()
  })
  .strict()

const skillSourceSchema = z.enum(['system', 'custom', 'github', 'git', 'local', 'url'])
const skillTrustLevelSchema = z.enum(['trusted', 'untrusted'])

const skillPayloadSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    markdown: z.string().min(1),
    source: skillSourceSchema.optional(),
    sourceRef: z.string().trim().min(1).optional(),
    dependencies: z.array(skillDependencySchema).optional(),
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    standardsStatus: z.enum(['full', 'degraded']).optional(),
    standardsIssues: z.array(z.string().trim().min(1)).optional(),
    trustLevel: skillTrustLevelSchema.optional(),
    hasScripts: z.boolean().optional(),
    hasReferences: z.boolean().optional(),
    hasAssets: z.boolean().optional(),
    bundleManifest: z.record(z.string(), z.any()).optional(),
    bundleFiles: z.array(z.record(z.string(), z.any())).optional(),
    isSystem: z.boolean().optional(),
    isActive: z.boolean().optional()
  })
  .strict()

const skillSaveInputSchema = z
  .object({
    commandId: z.string().trim().min(1).optional(),
    commandName: z.string().trim().min(1),
    commandDisplayName: z.string().trim().min(1).optional(),
    commandDescription: z.string().optional(),
    invocation: z.string().trim().min(1).optional(),
    instructions: z.string().optional(),
    icon_ref: iconRefInputSchema.optional(),
    iconRef: iconRefInputSchema.optional(),
    icon: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    enabledForAllAgents: z.boolean().optional(),
    enabledAgentIds: z.array(z.string().trim().min(1)).optional(),
    isActive: z.boolean().optional(),
    skill: skillPayloadSchema
  })
  .strict()

const skillImportControlInputSchema = z
  .object({
    installCommand: z.string().trim().min(1).optional(),
    sourceType: z.enum(['github', 'url', 'git', 'local']).optional(),
    source: z.string().trim().min(1).optional(),
    skillPath: z.string().trim().min(1).optional(),
    trustLevel: skillTrustLevelSchema.optional(),
    saveAsCommand: z.boolean().optional(),
    commandId: z.string().trim().min(1).optional(),
    commandName: z.string().trim().min(1).optional(),
    commandDisplayName: z.string().trim().min(1).optional(),
    commandDescription: z.string().optional(),
    invocation: z.string().trim().min(1).optional(),
    instructions: z.string().optional(),
    icon_ref: iconRefInputSchema.optional(),
    iconRef: iconRefInputSchema.optional(),
    icon: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    enabledForAllAgents: z.boolean().optional(),
    enabledAgentIds: z.array(z.string().trim().min(1)).optional(),
    isActive: z.boolean().optional()
  })
  .strict()
  .refine((value) => Boolean(value.installCommand || value.source), {
    message: 'installCommand or source is required'
  })

const artifactCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1).optional(),
    content: z.string().optional(),
    mode: z.enum(['edit', 'published']).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    sessionId: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).nullable().optional(),
    brain_type: z.enum(['built_in', 'webhook', 'n8n_workflow', 'custom_webhook', 'none']).optional(),
    ai_enabled: z.boolean().optional(),
    webhook_url: z.string().trim().min(1).nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
    model_config: z.record(z.string(), z.any()).nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    custom_prompt: z.string().nullable().optional(),
    icon_ref: iconRefInputSchema.optional(),
    iconRef: iconRefInputSchema.optional(),
    icon: z.string().trim().min(1).optional(),
    zone: z.string().trim().min(1).nullable().optional(),
    blueprint: z.string().nullable().optional()
  })
  .passthrough()

const artifactByIdInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    includeContent: z.boolean().optional(),
    includeVersions: z.boolean().optional(),
    includeVersionContents: z.boolean().optional()
  })
  .passthrough()

const artifactRunLogsListInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    limit: z.number().int().min(1).max(75).optional()
  })
  .passthrough()

const artifactRunLogsGetInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    runId: z.string().trim().min(1)
  })
  .passthrough()

const artifactUpdateInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    content: z.string().optional(),
    versionDescription: z.string().optional(),
    sessionId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).nullable().optional(),
    type: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    mode: z.enum(['edit', 'published']).optional(),
    brain_type: z.enum(['built_in', 'webhook', 'n8n_workflow', 'custom_webhook', 'none']).optional(),
    ai_enabled: z.boolean().optional(),
    webhook_url: z.string().trim().min(1).nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
    model_config: z.record(z.string(), z.any()).nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    custom_prompt: z.string().nullable().optional(),
    icon_ref: iconRefInputSchema.optional(),
    iconRef: iconRefInputSchema.optional(),
    icon: z.string().trim().min(1).optional(),
    zone: z.string().trim().min(1).nullable().optional(),
    blueprint: z.string().nullable().optional(),
    agent_use_enabled: z.boolean().optional(),
    agent_allowlist: z.array(z.string()).nullable().optional()
  })
  .passthrough()

const artifactValidateStructureInputSchema = z
  .object({
    artifactId: z.string().trim().min(1).optional(),
    content: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    mode: z.enum(['edit', 'published']).optional()
  })
  .passthrough()
  .refine((value) => Boolean(value.artifactId || value.content !== undefined), {
    message: 'artifactId or content is required'
  })

const artifactApplyPatchInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    patch: z.string().trim().min(1),
    versionDescription: z.string().optional(),
    sessionId: z.string().trim().min(1).optional()
  })
  .passthrough()

const artifactPublishInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    publish: z.boolean().optional(),
    zone: z.string().trim().min(1).nullable().optional()
  })
  .passthrough()

const artifactAddVersionInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    content: z.string().min(1),
    description: z.string().optional()
  })
  .passthrough()

const artifactRollbackInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    targetVersion: z.coerce.number().int().min(1)
  })
  .passthrough()

const artifactDeleteVersionInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    version: z.coerce.number().int().min(1)
  })
  .passthrough()

const artifactSetWebhookInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    webhook_url: z.string().trim().min(1).nullable().optional(),
    ai_enabled: z.boolean().optional(),
    brain_type: z.enum(['built_in', 'webhook', 'n8n_workflow', 'custom_webhook', 'none']).optional()
  })
  .passthrough()

const artifactSetZoneInputSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    zone: z.string().trim().min(1).nullable().optional()
  })
  .passthrough()

const artifactAnalyzeUrlInputSchema = z
  .object({
    url: z.string().trim().url(),
    hfToken: z.string().trim().min(1).optional(),
    githubToken: z.string().trim().min(1).optional()
  })
  .passthrough()

const artifactCheckRequirementsInputSchema = z
  .object({
    path: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional()
  })
  .passthrough()
  .refine((value) => Boolean(value.path || value.url), {
    message: 'path or url is required'
  })

const modelCatalogSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    connection: z.string().trim().min(1).optional(),
    developer: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    purpose: z.enum(['chat', 'visual', 'audio', 'utility']).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MODEL_CATALOG_RESULTS).optional(),
    includePricing: z.boolean().optional(),
    forceRefresh: z.boolean().optional()
  })
  .passthrough()

const cliToolListInputSchema = z
  .object({
    status: z.enum(['active', 'disabled', 'archived']).optional(),
    includeArchived: z.boolean().optional()
  })
  .passthrough()

const cliToolByIdInputSchema = z
  .object({
    toolId: z.string().trim().min(1)
  })
  .passthrough()

const cliToolCreateInputSchema = z
  .object({
    toolId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    executable: z.string().trim().min(1).optional(),
    argsTemplate: z.array(z.any()).optional(),
    inputSchema: z.record(z.string(), z.any()).optional(),
    outputMode: z.enum(['text', 'json', 'mixed']).optional(),
    parseMode: z.enum(['text', 'json', 'json_in_text']).optional(),
    cwdPolicy: z.enum(['none', 'project', 'fixed']).optional(),
    cwdValue: z.string().trim().min(1).optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(300000).optional(),
    envRefs: z.array(z.object({ envVar: z.string(), savedKeyRef: z.string() }).passthrough()).optional(),
    riskLevel: z.enum(['safe', 'confirm', 'restricted']).optional(),
    allowNetwork: z.boolean().optional(),
    allowWrite: z.boolean().optional(),
    allowedPaths: z.array(z.string()).optional(),
    helpCommand: z.array(z.string()).optional(),
    validationInput: z.record(z.string(), z.any()).optional(),
    examples: z.array(z.string()).optional(),
    iconRef: iconRefInputSchema.nullable().optional(),
    iconHint: z.string().trim().min(1).optional(),
    tags: z.array(z.string()).optional(),
    origin: z.enum(['manual', 'imported', 'generated']).optional(),
    status: z.enum(['active', 'disabled', 'archived']).optional()
  })
  .passthrough()

const cliToolUpdateInputSchema = cliToolCreateInputSchema
  .extend({
    toolId: z.string().trim().min(1)
  })
  .passthrough()

const cliToolTestInputSchema = z
  .object({
    toolId: z.string().trim().min(1),
    projectPath: z.string().trim().min(1).optional()
  })
  .passthrough()

const cliToolArchiveInputSchema = z
  .object({
    toolId: z.string().trim().min(1),
    status: z.enum(['active', 'disabled', 'archived']).optional()
  })
  .passthrough()

const runtimeAddonListInputSchema = z
  .object({
    includeStatus: z.boolean().optional()
  })
  .passthrough()

const runtimeAddonByIdInputSchema = z
  .object({
    addonId: z.enum(RUNTIME_ADDON_IDS)
  })
  .passthrough()

const goonSceneCreatorInfoInputSchema = z.object({}).passthrough()

const RUNTIME_ADDON_ID_OPTIONS = [...RUNTIME_ADDON_IDS]
const RUNTIME_ADDON_SCHEMA_HINT = `addonId (${RUNTIME_ADDON_ID_OPTIONS.join(', ')})`

type ArtifactControlSeed = {
  controlId: string
  title: string
  description: string
  schemaHint: string
  riskLevel: ControlRiskLevel
  tags: string[]
  inputSchema: z.ZodTypeAny
  inputSchemaJson: Record<string, any>
  handler: ControlHandler
}

const ARTIFACT_ICON_REF_DESCRIPTION =
  'Structured icon picker reference from the Batshit catalog. Do not invent Lucide IDs. Safe examples: { "kind": "lucide", "id": "image" }, { "kind": "lucide", "id": "palette" }, { "kind": "lucide", "id": "sparkles" }, { "kind": "brand", "slug": "huggingface-color" }, { "kind": "brand", "slug": "comfyui-color" }, { "kind": "brand", "slug": "n8n-color" }.'

const ARTIFACT_CONTROL_SEEDS: ArtifactControlSeed[] = [
  {
    controlId: 'sys.artifact.create',
    title: 'Artifact Create',
    description: 'Create a new artifact with content, metadata, zone, and structured icon_ref. For built-in AI artifacts, include model_config only when the artifact purpose clearly identifies the provider/model; prefer source "manual" with an exact modelId unless the user named an existing saved preset. Do not silently choose a fallback model.',
    schemaHint: 'name/content + optional mode/zone/icon_ref/metadata/model_config manual modelId',
    riskLevel: 'safe',
    tags: ['artifact', 'create', 'builder'],
    inputSchema: artifactCreateInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['edit', 'published'] },
        icon_ref: {
          type: 'object',
          description: ARTIFACT_ICON_REF_DESCRIPTION
        },
        model_config: {
          type: 'object',
          description: 'For built-in AI artifacts, use { "mode": "basic", "primary": { "source": "manual", "modelId": "<exact-current-provider-model-id>" } } unless the user explicitly named an existing saved preset.'
        },
        zone: { type: 'string' }
      }
    },
    handler: async (context, input) => await executeArtifactCreate(context, input)
  },
  {
    controlId: 'sys.artifact.list',
    title: 'Artifact List',
    description: 'List artifacts available to the current user.',
    schemaHint: 'optional filters',
    riskLevel: 'safe',
    tags: ['artifact', 'list', 'discovery'],
    inputSchema: z.object({}).passthrough(),
    inputSchemaJson: {
      type: 'object',
      additionalProperties: true
    },
    handler: async (context) => await executeArtifactList(context)
  },
  {
    controlId: 'sys.artifact.get',
    title: 'Artifact Get',
    description: 'Fetch one artifact by ID.',
    schemaHint: 'artifactId (required)',
    riskLevel: 'safe',
    tags: ['artifact', 'read'],
    inputSchema: artifactByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        includeContent: { type: 'boolean' },
        includeVersions: { type: 'boolean' },
        includeVersionContents: { type: 'boolean' }
      },
      required: ['artifactId']
    },
    handler: async (context, input) => await executeArtifactGet(context, input)
  },
  {
    controlId: 'sys.artifact.run_logs.list',
    title: 'Artifact Run Logs List',
    description: 'List recent scrubbed run logs for one artifact, including status, resolved model, transport, output counts, and last error.',
    schemaHint: 'artifactId (required), optional limit',
    riskLevel: 'safe',
    tags: ['artifact', 'logs', 'debug', 'runs'],
    inputSchema: artifactRunLogsListInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 75 }
      },
      required: ['artifactId']
    },
    handler: async (context, input) => await executeArtifactRunLogsList(context, input)
  },
  {
    controlId: 'sys.artifact.run_logs.get',
    title: 'Artifact Run Logs Get',
    description: 'Fetch one scrubbed artifact run log by artifactId and runId. Logs never include API keys or raw base64 image/audio bytes.',
    schemaHint: 'artifactId + runId',
    riskLevel: 'safe',
    tags: ['artifact', 'logs', 'debug', 'runs'],
    inputSchema: artifactRunLogsGetInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        runId: { type: 'string' }
      },
      required: ['artifactId', 'runId']
    },
    handler: async (context, input) => await executeArtifactRunLogsGet(context, input)
  },
  {
    controlId: 'sys.artifact.update',
    title: 'Artifact Update',
    description: 'Update artifact metadata/content, including structured icon_ref when changing the artifact icon. For built-in AI artifacts, set model_config only with an exact manual modelId or a known existing preset; ask before substituting a fallback model.',
    schemaHint: 'artifactId + content/metadata/mode/icon_ref/model_config manual modelId',
    riskLevel: 'safe',
    tags: ['artifact', 'update', 'builder'],
    inputSchema: artifactUpdateInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        content: { type: 'string' },
        versionDescription: { type: 'string' },
        mode: { type: 'string', enum: ['edit', 'published'] },
        icon_ref: {
          type: 'object',
          description: ARTIFACT_ICON_REF_DESCRIPTION
        },
        metadata: { type: 'object', additionalProperties: true },
        model_config: {
          type: 'object',
          description: 'For built-in AI artifacts, use { "mode": "basic", "primary": { "source": "manual", "modelId": "<exact-current-provider-model-id>" } } unless the user explicitly named an existing saved preset.'
        }
      },
      required: ['artifactId']
    },
    handler: async (context, input) => await executeArtifactUpdate(context, input)
  },
  {
    controlId: 'sys.artifact.validate_structure',
    title: 'Artifact Validate Structure',
    description: 'Preflight-check artifact structure before save or publish.',
    schemaHint: 'artifactId/content + optional metadata/mode',
    riskLevel: 'safe',
    tags: ['artifact', 'validation', 'builder', 'fabric'],
    inputSchema: artifactValidateStructureInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        content: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
        mode: { type: 'string', enum: ['edit', 'published'] }
      },
      anyOf: [{ required: ['artifactId'] }, { required: ['content'] }]
    },
    handler: async (context, input) => await executeArtifactValidateStructure(context, input)
  },
  {
    controlId: 'sys.artifact.apply_patch',
    title: 'Artifact Apply Patch',
    description: 'Apply an apply_patch-style diff to existing artifact content.',
    schemaHint: 'artifactId + patch',
    riskLevel: 'safe',
    tags: ['artifact', 'update', 'patch', 'builder'],
    inputSchema: artifactApplyPatchInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        patch: { type: 'string' },
        versionDescription: { type: 'string' }
      },
      required: ['artifactId', 'patch']
    },
    handler: async (context, input) => await executeArtifactApplyPatch(context, input)
  },
  {
    controlId: 'sys.artifact.publish',
    title: 'Artifact Publish',
    description: 'Publish or unpublish an artifact.',
    schemaHint: 'artifactId + publish fields',
    riskLevel: 'safe',
    tags: ['artifact', 'publish', 'zones'],
    inputSchema: artifactPublishInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        publish: { type: 'boolean' },
        zone: { type: 'string' }
      },
      required: ['artifactId']
    },
    handler: async (context, input) => await executeArtifactPublish(context, input)
  },
  {
    controlId: 'sys.artifact.add_version',
    title: 'Artifact Add Version',
    description: 'Create a new saved artifact version.',
    schemaHint: 'artifactId + version payload',
    riskLevel: 'safe',
    tags: ['artifact', 'versioning'],
    inputSchema: artifactAddVersionInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        content: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['artifactId', 'content']
    },
    handler: async (context, input) => await executeArtifactAddVersion(context, input)
  },
  {
    controlId: 'sys.artifact.rollback',
    title: 'Artifact Rollback',
    description: 'Rollback artifact content to a previous version.',
    schemaHint: 'artifactId + version target',
    riskLevel: 'restricted',
    tags: ['artifact', 'versioning', 'rollback'],
    inputSchema: artifactRollbackInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        targetVersion: { type: 'integer', minimum: 1 }
      },
      required: ['artifactId', 'targetVersion']
    },
    handler: async (context, input) => await executeArtifactRollback(context, input)
  },
  {
    controlId: 'sys.artifact.delete_version',
    title: 'Artifact Delete Version',
    description: 'Delete a stored artifact version.',
    schemaHint: 'artifactId + version target',
    riskLevel: 'restricted',
    tags: ['artifact', 'versioning', 'delete'],
    inputSchema: artifactDeleteVersionInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        version: { type: 'integer', minimum: 1 }
      },
      required: ['artifactId', 'version']
    },
    handler: async (context, input) => await executeArtifactDeleteVersion(context, input)
  },
  {
    controlId: 'sys.artifact.set_webhook',
    title: 'Artifact Set Webhook',
    description: 'Set or clear the artifact webhook endpoint.',
    schemaHint: 'artifactId + webhookUrl',
    riskLevel: 'safe',
    tags: ['artifact', 'webhook', 'brain'],
    inputSchema: artifactSetWebhookInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        webhook_url: { type: 'string' },
        ai_enabled: { type: 'boolean' },
        brain_type: { type: 'string', enum: ['built_in', 'webhook', 'n8n_workflow', 'custom_webhook', 'none'] }
      },
      required: ['artifactId']
    },
    handler: async (context, input) => await executeArtifactSetWebhook(context, input)
  },
  {
    controlId: 'sys.artifact.set_zone',
    title: 'Artifact Set Zone',
    description: 'Set artifact workspace zone placement.',
    schemaHint: 'artifactId + zone',
    riskLevel: 'safe',
    tags: ['artifact', 'zones', 'ui'],
    inputSchema: artifactSetZoneInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        zone: { type: 'string' }
      },
      required: ['artifactId']
    },
    handler: async (context, input) => await executeArtifactSetZone(context, input)
  },
  {
    controlId: 'sys.artifact.analyze_url',
    title: 'Artifact Analyze URL',
    description: 'Analyze an external source for artifact integration planning.',
    schemaHint: 'url (+ optional analysis flags)',
    riskLevel: 'safe',
    tags: ['artifact', 'analysis', 'discovery'],
    inputSchema: artifactAnalyzeUrlInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        hfToken: { type: 'string' },
        githubToken: { type: 'string' }
      },
      required: ['url']
    },
    handler: async (context, input) => await executeArtifactAnalyzeUrl(context, input)
  },
  {
    controlId: 'sys.artifact.check_requirements',
    title: 'Artifact Check Requirements',
    description: 'Check local dependency requirements for artifact builds.',
    schemaHint: 'path/projectRoot (+ optional flags)',
    riskLevel: 'safe',
    tags: ['artifact', 'analysis', 'dependencies'],
    inputSchema: artifactCheckRequirementsInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        url: { type: 'string' }
      },
      anyOf: [{ required: ['path'] }, { required: ['url'] }]
    },
    handler: async (context, input) => await executeArtifactCheckRequirements(context, input)
  }
]

const ARTIFACT_CONTROL_DEFINITIONS: ControlDefinition[] = ARTIFACT_CONTROL_SEEDS.map((seed) => ({
  controlId: seed.controlId,
  sourceType: 'core',
  executorType: 'internal_handler',
  title: seed.title,
  description: seed.description,
  inputSchema: seed.inputSchema,
  inputSchemaJson: seed.inputSchemaJson,
  outputSchema: null,
  schemaHint: seed.schemaHint,
  riskLevel: seed.riskLevel,
  status: 'published',
  tags: seed.tags,
  handler: seed.handler
}))

/** Static summary data for artifact core controls — safe to serialize/use in DCM compilation. */
export const ARTIFACT_CORE_CONTROL_SUMMARIES = ARTIFACT_CONTROL_SEEDS.map((seed) => ({
  controlId: seed.controlId,
  description: seed.description,
  inputSchemaJson: seed.inputSchemaJson
}))

async function executeRuntimeAddonList(_context: ControlExecutionContext, input: Record<string, any>) {
  return {
    addons: await listRuntimeAddons({ includeStatus: input.includeStatus === true })
  }
}

async function executeRuntimeAddonStatus(_context: ControlExecutionContext, input: Record<string, any>) {
  const status = await getRuntimeAddonStatus(input.addonId)
  if (!status) {
    throw new Error(`Unknown runtime add-on "${input.addonId}".`)
  }
  return {
    addon: status
  }
}

async function executeRuntimeAddonPrepare(_context: ControlExecutionContext, input: Record<string, any>) {
  const prepared = await prepareRuntimeAddon(input.addonId)
  if (!prepared) {
    throw new Error(`Unknown runtime add-on "${input.addonId}".`)
  }
  return {
    addon: prepared
  }
}

async function executeRuntimeAddonControl(
  _context: ControlExecutionContext,
  input: Record<string, any>,
  operation: 'start' | 'stop'
) {
  const result = await controlRuntimeAddon(input.addonId, operation)
  if (!result) {
    throw new Error(`Unknown runtime add-on "${input.addonId}".`)
  }
  if (!result.success) {
    throw new Error(result.error || `Runtime add-on ${operation} failed for "${input.addonId}".`)
  }
  return {
    addon: result
  }
}

const CONTROL_DEFINITIONS: ControlDefinition[] = [
  {
    controlId: 'sys.model_catalog.search',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Model Catalog Search',
    description:
      'Search Batshit model catalog entries and return exact provider/developer/model ID data plus artifact runtime requirements. Use this before setting artifact model_config: provider means the API key/connection route, developer means the model maker namespace, and modelIdForArtifact is the exact manual model ID to store.',
    inputSchema: modelCatalogSearchInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        provider: {
          type: 'string',
          description: 'API key/connection route, such as google, direct:google, openrouter, or openai.'
        },
        connection: {
          type: 'string',
          description: 'Optional exact connection ID; treated like provider when filtering.'
        },
        developer: {
          type: 'string',
          description: 'Model maker namespace, such as google, openai, anthropic, or black-forest-labs.'
        },
        modelId: { type: 'string' },
        purpose: { type: 'string', enum: ['chat', 'visual', 'audio', 'utility'] },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MODEL_CATALOG_RESULTS },
        includePricing: { type: 'boolean' },
        forceRefresh: { type: 'boolean' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        results: { type: 'array' },
        guidance: { type: 'object' }
      }
    },
    schemaHint: 'query/provider/developer/modelId/purpose + optional limit',
    riskLevel: 'safe',
    status: 'published',
    tags: ['model', 'catalog', 'provider', 'developer', 'artifact', 'discovery'],
    handler: async (_context, input) => executeModelCatalogSearch(input)
  },
  {
    controlId: 'sys.zip.fetch',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Fetch Zip',
    description: 'Fetch an existing Batshit zip by ID without changing unzip state.',
    inputSchema: zipFetchInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        zipId: { type: 'string' },
        includeContent: { type: 'boolean' },
        maxChars: { type: 'integer', minimum: 64, maximum: MAX_ZIP_CHARS }
      },
      required: ['zipId']
    },
    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        zipId: { type: 'string' },
        content: { type: 'string' }
      }
    },
    schemaHint: 'zipId (required), includeContent?, maxChars?',
    riskLevel: 'safe',
    status: 'published',
    tags: ['zip', 'context', 'history'],
    handler: async (context, input) => executeZipFetch(context.userId, input)
  },
  {
    controlId: 'sys.goon_scene.creator_info',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Goon Scene Creator Info',
    description:
      'Return the current Portable Goon Scene Creator capability boundary and scene-placement rules. This is a safe proof control for Goon Scenes Portable Skill Tokens.',
    inputSchema: goonSceneCreatorInfoInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    outputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
        command: { type: 'string' },
        canSaveScenes: { type: 'boolean' },
        placementModes: { type: 'array', items: { type: 'string' } },
        scenePlacementRule: { type: 'string' },
        groundProjectionRule: { type: 'string' }
      }
    },
    schemaHint: 'no input',
    riskLevel: 'safe',
    status: 'published',
    tags: ['goons', 'scene', 'skybox', 'skill', 'portable'],
    handler: async () => executeGoonSceneCreatorInfo()
  },
  {
    controlId: 'sys.mcp.dynamic.find',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Dynamic Tool Search',
    description: 'Search discoverable MCP tools by query, group, or exact tool.',
    inputSchema: dynamicFindInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tool: { type: 'string' },
        group: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
        },
        exact: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_DYNAMIC_RESULTS },
        includeSchema: { type: 'boolean' },
        selectedGateways: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array' },
        totalMatches: { type: 'integer' }
      }
    },
    schemaHint: 'query/tool/group + optional exact/limit/includeSchema',
    riskLevel: 'safe',
    status: 'published',
    tags: ['mcp', 'dynamic', 'discovery'],
    handler: async (context, input) => executeDynamicMcpFind(context, input)
  },
  {
    controlId: 'sys.mcp.dynamic.use',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'MCP Tool',
    description: 'Execute an MCP tool by exact tool name.',
    inputSchema: dynamicUseInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolName: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        selectedGateways: { type: 'array', items: { type: 'string' } },
        projectPath: { type: 'string' }
      },
      required: ['toolName']
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        toolName: { type: 'string' },
        result: {}
      }
    },
    schemaHint: 'toolName (required), params?, selectedGateways?',
    riskLevel: 'safe',
    status: 'published',
    tags: ['mcp', 'dynamic', 'execution'],
    handler: async (context, input) => executeDynamicMcpUse(context, input)
  },
  {
    controlId: 'sys.skill.save',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Skill Save',
    description: 'Create or update a Batshit skill command and persist SKILL.md into the skill registry.',
    inputSchema: skillSaveInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        commandId: { type: 'string' },
        commandName: { type: 'string' },
        invocation: { type: 'string' },
        enabledAgentIds: { type: 'array', items: { type: 'string' } },
        skill: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            markdown: { type: 'string' },
            source: { type: 'string', enum: ['system', 'custom', 'github', 'git', 'local', 'url'] }
          },
          required: ['markdown']
        }
      },
      required: ['commandName', 'skill']
    },
    outputSchema: null,
    schemaHint: 'commandName + skill.markdown (required), optional command metadata + skill metadata',
    riskLevel: 'safe',
    status: 'published',
    tags: ['skill', 'slash', 'registry'],
    handler: async (context, input) => await executeSkillSave(context, input)
  },
  {
    controlId: 'sys.skill.import',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Skill Import',
    description:
      'Import a skill from a GitHub repo, https URL, https git clone, or local folder, optionally saving it as a Batshit skill command. Asks for approval first; remote imports allow only public https sources.',
    inputSchema: skillImportControlInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        installCommand: { type: 'string' },
        sourceType: { type: 'string', enum: ['github', 'url', 'git', 'local'] },
        source: { type: 'string' },
        skillPath: { type: 'string' },
        saveAsCommand: { type: 'boolean' },
        commandName: { type: 'string' }
      },
      anyOf: [{ required: ['installCommand'] }, { required: ['source'] }]
    },
    outputSchema: null,
    schemaHint: 'installCommand OR source/sourceType (+ optional command save fields)',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['skill', 'import', 'slash'],
    handler: async (context, input) => await executeSkillImport(context, input)
  },
  {
    controlId: 'sys.runtime_addon.list',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Runtime Add-on List',
    description:
      'List approved Docker runtime add-ons that Batshit can check or prepare without arbitrary host Docker control.',
    inputSchema: runtimeAddonListInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        includeStatus: { type: 'boolean' }
      },
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: 'optional includeStatus',
    riskLevel: 'safe',
    status: 'published',
    tags: ['runtime', 'addon', 'docker', 'sidecar', 'discovery'],
    handler: async (context, input) => await executeRuntimeAddonList(context, input)
  },
  {
    controlId: 'sys.runtime_addon.status',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Runtime Add-on Status',
    description:
      'Check one approved Docker runtime add-on, including whether it is running and which Compose command starts it.',
    inputSchema: runtimeAddonByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        addonId: { type: 'string', enum: RUNTIME_ADDON_ID_OPTIONS }
      },
      required: ['addonId'],
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: RUNTIME_ADDON_SCHEMA_HINT,
    riskLevel: 'safe',
    status: 'published',
    tags: ['runtime', 'addon', 'docker', 'sidecar', 'status'],
    handler: async (context, input) => await executeRuntimeAddonStatus(context, input)
  },
  {
    controlId: 'sys.runtime_addon.prepare',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Runtime Add-on Prepare',
    description:
      'Prepare an approved Docker add-on install by returning the exact operator command and verification steps. This does not start containers from inside the core app.',
    inputSchema: runtimeAddonByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        addonId: { type: 'string', enum: RUNTIME_ADDON_ID_OPTIONS }
      },
      required: ['addonId'],
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: RUNTIME_ADDON_SCHEMA_HINT,
    riskLevel: 'safe',
    status: 'published',
    tags: ['runtime', 'addon', 'docker', 'sidecar', 'prepare'],
    handler: async (context, input) => await executeRuntimeAddonPrepare(context, input)
  },
  {
    controlId: 'sys.runtime_addon.start',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Runtime Add-on Start',
    description:
      'Start an approved Docker runtime add-on through the configured host/operator controller. This never runs arbitrary Docker commands from inside the core app container.',
    inputSchema: runtimeAddonByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        addonId: { type: 'string', enum: RUNTIME_ADDON_ID_OPTIONS }
      },
      required: ['addonId'],
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: RUNTIME_ADDON_SCHEMA_HINT,
    riskLevel: 'confirm',
    status: 'published',
    tags: ['runtime', 'addon', 'docker', 'sidecar', 'start'],
    handler: async (context, input) => await executeRuntimeAddonControl(context, input, 'start')
  },
  {
    controlId: 'sys.runtime_addon.stop',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Runtime Add-on Stop',
    description:
      'Stop an approved Docker runtime add-on through the configured host/operator controller. This never runs arbitrary Docker commands from inside the core app container.',
    inputSchema: runtimeAddonByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        addonId: { type: 'string', enum: RUNTIME_ADDON_ID_OPTIONS }
      },
      required: ['addonId'],
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: RUNTIME_ADDON_SCHEMA_HINT,
    riskLevel: 'confirm',
    status: 'published',
    tags: ['runtime', 'addon', 'docker', 'sidecar', 'stop'],
    handler: async (context, input) => await executeRuntimeAddonControl(context, input, 'stop')
  },
  {
    controlId: 'sys.cli_tool.list',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool List',
    description: 'List saved Batshit CLI tools with plain-English summaries.',
    inputSchema: cliToolListInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'disabled', 'archived'] },
        includeArchived: { type: 'boolean' }
      },
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: 'optional status/includeArchived filters',
    riskLevel: 'safe',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'discovery'],
    handler: async (context, input) => await executeCliToolList(context, input)
  },
  {
    controlId: 'sys.cli_tool.get',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool Get',
    description: 'Fetch one saved CLI tool plus Basic/Advanced summaries.',
    inputSchema: cliToolByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolId: { type: 'string' }
      },
      required: ['toolId']
    },
    outputSchema: null,
    schemaHint: 'toolId (required)',
    riskLevel: 'safe',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'read'],
    handler: async (context, input) => await executeCliToolGet(context, input)
  },
  {
    controlId: 'sys.cli_tool.create',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool Create',
    description:
      'Create a saved Batshit CLI tool record. Prefer plain-English intent + explicit manifest fields over hidden shell strings. If origin/status are omitted, Fabric defaults to generated + active.',
    inputSchema: cliToolCreateInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        executable: { type: 'string' },
        argsTemplate: { type: 'array' },
        inputSchema: { type: 'object', additionalProperties: true },
        outputMode: { type: 'string', enum: ['text', 'json', 'mixed'] },
        parseMode: { type: 'string', enum: ['text', 'json', 'json_in_text'] }
      },
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint:
      'title/description/executable + manifest fields; toolId may be inferred from title; origin/status default to generated/active',
    riskLevel: 'safe',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'create', 'fabric'],
    handler: async (context, input) => await executeCliToolCreate(context, input)
  },
  {
    controlId: 'sys.cli_tool.update',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool Update',
    description: 'Update an existing Batshit CLI tool record.',
    inputSchema: cliToolUpdateInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        executable: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'archived'] }
      },
      required: ['toolId'],
      additionalProperties: true
    },
    outputSchema: null,
    schemaHint: 'toolId (required) + fields to change',
    riskLevel: 'safe',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'update', 'fabric'],
    handler: async (context, input) => await executeCliToolUpdate(context, input)
  },
  {
    controlId: 'sys.cli_tool.test',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool Test',
    description:
      'Run the saved CLI tool validation/test flow and return a plain-English result. This verifies the saved record; actual chat execution still requires the tool to be selected in the current chat.',
    inputSchema: cliToolTestInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        projectPath: { type: 'string' }
      },
      required: ['toolId']
    },
    outputSchema: null,
    schemaHint: 'toolId (required), optional projectPath',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'test', 'validation'],
    handler: async (context, input) => await executeCliToolTest(context, input)
  },
  {
    controlId: 'sys.cli_tool.archive',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool Archive',
    description: 'Archive, disable, or reactivate a saved CLI tool record without deleting it.',
    inputSchema: cliToolArchiveInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'archived'] }
      },
      required: ['toolId']
    },
    outputSchema: null,
    schemaHint: 'toolId (required), optional status (defaults to archived)',
    riskLevel: 'safe',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'archive'],
    handler: async (context, input) => await executeCliToolArchive(context, input)
  },
  {
    controlId: 'sys.cli_tool.delete',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'CLI Tool Delete',
    description: 'Delete a saved CLI tool record from Batshit.',
    inputSchema: cliToolByIdInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        toolId: { type: 'string' }
      },
      required: ['toolId']
    },
    outputSchema: null,
    schemaHint: 'toolId (required)',
    riskLevel: 'restricted',
    status: 'published',
    tags: ['cli', 'tool', 'registry', 'delete'],
    handler: async (context, input) => await executeCliToolDelete(context, input)
  },
  ...ARTIFACT_CONTROL_DEFINITIONS,
  {
    controlId: 'sys.voice.engine.register',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Register TTS/STT Engine',
    description: 'Create a new TTS/STT speech engine record in the Engine Manager.',
    inputSchema: voiceEngineMutationSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        payload: { type: 'object', additionalProperties: true }
      },
      required: ['engineId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), payload?',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'registry'],
    handler: async (context, input) => await executeVoiceEngineRegister(context, input)
  },
  {
    controlId: 'sys.voice.engine.update',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Update TTS/STT Engine',
    description: 'Update an existing TTS/STT speech engine record in the Engine Manager.',
    inputSchema: voiceEngineMutationSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        payload: { type: 'object', additionalProperties: true }
      },
      required: ['engineId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), payload?',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'registry'],
    handler: async (context, input) => await executeVoiceEngineUpdate(context, input)
  },
  {
    controlId: 'sys.voice.engine.health_check',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'TTS/STT Engine Health Check',
    description: 'Run health verification for a configured TTS/STT speech engine.',
    inputSchema: voiceEngineHealthCheckInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' }
      },
      required: ['engineId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required)',
    riskLevel: 'safe',
    status: 'published',
    tags: ['voice', 'engine', 'health'],
    handler: async (context, input) => await executeVoiceEngineHealthCheck(context, input)
  },
  {
    controlId: 'sys.voice.engine.complete_local_setup',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Complete Local TTS/STT Engine Setup',
    description:
      'Finish a verified local TTS/STT engine install by launching the runtime, polling readiness, running one smoke test, then registering and enabling the engine or returning a blocker report.',
    inputSchema: localVoiceEngineSetupInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        installRoot: { type: 'string' },
        installOwnership: { type: 'string', enum: ['batshit-managed', 'user-managed'] },
        launch: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            envFromApiKeys: { type: 'object', additionalProperties: { type: 'string' } },
            logPath: { type: 'string' }
          },
          required: ['command']
        },
        payload: { type: 'object', additionalProperties: true },
        smoke: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['tts', 'stt'] },
            text: { type: 'string' },
            model: { type: 'string' },
            voiceId: { type: ['string', 'null'] },
            profileId: { type: ['string', 'null'] },
            options: { type: 'object', additionalProperties: true },
            audioBase64: { type: 'string' },
            audioContentType: { type: 'string' },
            expectedText: { type: 'string' },
            language: { type: 'string' }
          }
        },
        readinessTimeoutMs: { type: 'integer' },
        pollIntervalMs: { type: 'integer' }
      },
      required: ['engineId', 'installRoot', 'launch', 'payload']
    },
    outputSchema: {
      type: 'object',
      properties: {
        completed: { type: 'boolean' },
        blocked: { type: 'boolean' },
        stage: { type: 'string' },
        engineId: { type: 'string' },
        providerId: { type: 'string' },
        installRoot: { type: 'string' },
        launchCwd: { type: 'string' },
        logPath: { type: 'string' },
        statePath: { type: 'string' },
        launched: { type: 'boolean' },
        alreadyRunning: { type: 'boolean' },
        pid: { type: ['integer', 'null'] },
        registered: { type: 'boolean' },
        enabled: { type: 'boolean' },
        blocker: { type: 'string' }
      }
    },
    schemaHint: 'engineId, installRoot, launch, payload (+ optional TTS/STT smoke/poll settings)',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'local', 'setup'],
    handler: async (context, input) => await executeVoiceEngineCompleteLocalSetup(context, input)
  },
  {
    controlId: 'sys.voice.engine.model.download',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Download STT Engine Model',
    description:
      'Download one published STT model for a local speech engine without switching away from the current active model.',
    inputSchema: voiceEngineModelActionInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        modelId: { type: 'string' }
      },
      required: ['engineId', 'modelId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), modelId (required)',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'stt', 'model', 'download'],
    handler: async (context, input) => await executeVoiceEngineModelDownload(context, input)
  },
  {
    controlId: 'sys.voice.engine.model.use',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Use STT Engine Model',
    description:
      'Select an already downloaded STT model for a local speech engine and update launch defaults.',
    inputSchema: voiceEngineModelActionInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        modelId: { type: 'string' }
      },
      required: ['engineId', 'modelId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), modelId (required)',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'stt', 'model', 'select'],
    handler: async (context, input) => await executeVoiceEngineModelUse(context, input)
  },
  {
    controlId: 'sys.voice.engine.model.delete',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Delete STT Engine Model',
    description: 'Delete a downloaded inactive STT model file for a local speech engine.',
    inputSchema: voiceEngineModelActionInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        modelId: { type: 'string' }
      },
      required: ['engineId', 'modelId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), modelId (required)',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'stt', 'model', 'delete'],
    handler: async (context, input) => await executeVoiceEngineModelDelete(context, input)
  },
  {
    controlId: 'sys.voice.engine.enable',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Enable TTS/STT Engine',
    description: 'Enable or disable a configured TTS/STT speech engine.',
    inputSchema: voiceEngineEnableInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        enabled: { type: 'boolean' }
      },
      required: ['engineId', 'enabled']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), enabled (required)',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'toggle'],
    handler: async (context, input) => await executeVoiceEngineEnable(context, input)
  },
  {
    controlId: 'sys.voice.engine.delete',
    sourceType: 'core',
    executorType: 'internal_handler',
    title: 'Delete TTS/STT Engine',
    description:
      'Delete a configured TTS/STT speech engine from the Engine Manager. Set deleteLocalFiles true only for Batshit-managed local installs the user explicitly wants removed from disk.',
    inputSchema: voiceEngineDeleteInputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        engineId: { type: 'string' },
        deleteLocalFiles: { type: 'boolean' }
      },
      required: ['engineId']
    },
    outputSchema: null,
    schemaHint: 'engineId (required), deleteLocalFiles?',
    riskLevel: 'confirm',
    status: 'published',
    tags: ['voice', 'engine', 'delete'],
    handler: async (context, input) => await executeVoiceEngineDelete(context, input)
  }
]

const STATIC_CONTROL_MAP = new Map(CONTROL_DEFINITIONS.map((definition) => [definition.controlId, definition]))

export interface ControlFindOptions {
  userId?: string
  agentId?: string
  query?: string
  tags?: string[]
  sourceType?: ControlSourceType | ControlSourceType[]
  riskLevel?: ControlRiskLevel | ControlRiskLevel[]
  runtimeMode?: ControlRuntimeMode
  includeSchema?: boolean
  includeDraft?: boolean
  limit?: number
  allowedControlIds?: string[]
}

export interface ControlFindResultItem {
  controlId: string
  sourceType: ControlSourceType
  executorType: ControlExecutorType
  title: string
  description: string
  riskLevel: ControlRiskLevel
  status: ControlStatus
  tags: string[]
  schemaHint: string
  inputSchema?: Record<string, any>
}

export interface ControlFindResult {
  results: ControlFindResultItem[]
  totalMatches: number
  query: string
  limit: number
}

export interface ControlUseOptions {
  userId: string
  controlId: string
  agentId?: string
  sessionId?: string
  input?: Record<string, any>
  dryRun?: boolean
  allowRisky?: boolean
  runtimeMode?: ControlRuntimeMode
  actorType?: ControlActorType
  selectedGateways?: string[]
  allowedControlIds?: string[]
}

type ControlActorType = 'service' | 'session' | 'internal' | 'n8n-callback' | 'portable-skill' | 'unknown'

export type ControlUseErrorCode =
  | 'CONTROL_NOT_FOUND'
  | 'CONTROL_NOT_ALLOWED'
  | 'CONTROL_INPUT_INVALID'
  | 'CONTROL_RISK_REQUIRES_APPROVAL'
  | 'CONTROL_NOT_EXECUTABLE'
  | 'CONTROL_EXECUTION_FAILED'

export type ControlUseResult =
  | {
      success: true
      controlId: string
      dryRun: boolean
      riskLevel: ControlRiskLevel
      status: ControlStatus
      result: Record<string, any>
    }
  | {
      success: false
      controlId: string
      error: {
        code: ControlUseErrorCode
        message: string
        details?: Record<string, any>
      }
    }

type ControlAuditEntry = {
  id: string
  timestamp: string
  userId: string
  actorType: ControlActorType
  controlId: string
  controlStatus: ControlStatus | null
  riskLevel: ControlRiskLevel | null
  dryRun: boolean
  allowRisky: boolean
  durationMs: number
  success: boolean
  errorCode: ControlUseErrorCode | null
  errorMessage: string | null
  inputKeys: string[]
  selectedGateways: string[]
}

const CONTROL_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 14
const CONTROL_AUDIT_RECENT_LIMIT = 200
const CONTROL_RISK_APPROVAL_TTL_SECONDS = 60 * 5
const CONTROL_RISK_APPROVAL_RECENT_USER_MESSAGE_LIMIT = 6
const DYNAMIC_ARTIFACT_ZONE_INPUT_KEYS = [
  'zone',
  'target_zone',
  'targetZone',
  'zone_name',
  'zoneName',
  'placement',
  'location'
] as const
const LOCAL_SETUP_INSTALL_TOPIC_PATTERN =
  /\b(install|set up|setup|configure|connect)\b/
const LOCAL_SETUP_EXPLICIT_APPROVAL_PATTERNS = [
  /\blet'?s install\b/,
  /\bcan you install\b/,
  /\bcan we install\b/,
  /\bplease install\b/,
  /\binstall\b[\s\S]{0,40}\bfor me\b/,
  /\bset\s+it\s+up\b[\s\S]{0,20}\bfor me\b/,
  /\byou can install\b/,
  /\byou can set it up\b/,
  /\bgo ahead\b/,
  /\blet'?s do (?:that|it|this)\b/,
  /\bdo it\b/,
  /\bbatshit-managed\b/
] as const
const LOCAL_SETUP_ACKNOWLEDGEMENT_PATTERN =
  /\b(yes|yeah|yep|sure|okay|ok|sounds good|that works|works for me)\b/
const LOCAL_SETUP_DENIAL_PATTERNS = [
  /\bdon'?t\b[\s\S]{0,20}\b(install|set up|setup|configure)\b/,
  /\bdo not\b[\s\S]{0,20}\b(install|set up|setup|configure)\b/,
  /\bwalk me through\b/,
  /\bguide me\b/,
  /\buser-managed\b/,
  /\bi(?:'|’)ll install\b/,
  /\bi will install\b/
] as const

function buildControlAuditKey(userId: string, auditId: string): string {
  return `control_audit:${userId}:${auditId}`
}

function buildControlRiskApprovalKey(options: {
  userId: string
  controlId: string
  agentId?: string | null
  scopeKey?: string | null
}): string {
  const agentScope = toTrimmedString(options.agentId) || 'no-agent'
  const scopeKey = toTrimmedString(options.scopeKey)
  if (!scopeKey) {
    return `control_risk_approval:${options.userId}:${agentScope}:${options.controlId}`
  }
  return `control_risk_approval:${options.userId}:${agentScope}:${options.controlId}:${encodeURIComponent(scopeKey)}`
}

async function hasRecentControlRiskApproval(options: {
  userId: string
  controlId: string
  agentId?: string | null
  scopeKey?: string | null
}): Promise<boolean> {
  try {
    return await redis.execute(async (client) => {
      const key = buildControlRiskApprovalKey(options)
      const marker = await client.get(key)
      return typeof marker === 'string' && marker.trim().length > 0
    })
  } catch (error) {
    console.warn('[ControlRegistry] Failed to read risk approval cache:', error)
    return false
  }
}

async function recordControlRiskApproval(options: {
  userId: string
  controlId: string
  agentId?: string | null
  scopeKey?: string | null
}): Promise<void> {
  try {
    await redis.execute(async (client) => {
      const key = buildControlRiskApprovalKey(options)
      await client.set(key, new Date().toISOString(), { EX: CONTROL_RISK_APPROVAL_TTL_SECONDS })
    })
  } catch (error) {
    console.warn('[ControlRegistry] Failed to record risk approval cache:', error)
  }
}

function normalizeRiskApprovalMessageContent(value: unknown): string {
  if (typeof value !== 'string') return ''
  const withoutDynamicInfo = value.split('==== DYNAMIC INFO')[0] ?? value
  return withoutDynamicInfo.toLowerCase().replace(/\s+/g, ' ').trim()
}

function resolveControlRiskScopeKey(controlId: string, inputPayload: Record<string, any>): string | undefined {
  if (controlId !== 'sys.voice.engine.complete_local_setup') return undefined
  try {
    const engineId = normalizeVoiceEngineId(inputPayload.engineId)
    return `engine:${engineId}`
  } catch {
    return undefined
  }
}

async function hasContextualControlRiskApproval(options: {
  userId: string
  controlId: string
  sessionId?: string
  inputPayload: Record<string, any>
}): Promise<boolean> {
  if (options.controlId !== 'sys.voice.engine.complete_local_setup') return false
  if (typeof options.sessionId !== 'string' || options.sessionId.trim().length === 0) return false

  const installOwnership =
    typeof options.inputPayload.installOwnership === 'string'
      ? options.inputPayload.installOwnership.trim().toLowerCase()
      : 'batshit-managed'
  if (installOwnership !== 'batshit-managed') return false

  try {
    const session = await redis.getSession(options.sessionId)
    if (!session || session.user_id !== options.userId) return false

    const messages = await redis.getSessionMessages(options.sessionId)
    const recentUserMessages = messages
      .filter((message) => message.role === 'user')
      .slice(-CONTROL_RISK_APPROVAL_RECENT_USER_MESSAGE_LIMIT)
      .reverse()

    const normalizedMessages = recentUserMessages
      .map((message) => normalizeRiskApprovalMessageContent(message.content))
      .filter((message) => message.length > 0)

    const hasInstallTopicInRecentContext = normalizedMessages.some((message) =>
      LOCAL_SETUP_INSTALL_TOPIC_PATTERN.test(message)
    )

    for (const message of normalizedMessages) {
      if (LOCAL_SETUP_DENIAL_PATTERNS.some((pattern) => pattern.test(message))) {
        return false
      }

      if (LOCAL_SETUP_EXPLICIT_APPROVAL_PATTERNS.some((pattern) => pattern.test(message))) {
        return true
      }

      if (
        hasInstallTopicInRecentContext &&
        LOCAL_SETUP_ACKNOWLEDGEMENT_PATTERN.test(message)
      ) {
        return true
      }
    }
  } catch (error) {
    console.warn('[ControlRegistry] Failed to inspect contextual risk approval:', error)
  }

  return false
}

async function recordControlAudit(entry: ControlAuditEntry): Promise<void> {
  try {
    await redis.execute(async (client) => {
      const auditKey = buildControlAuditKey(entry.userId, entry.id)
      const recentKey = `recent_control_executions:${entry.userId}`

      await client.json.set(auditKey, '$', entry as any)
      await client.expire(auditKey, CONTROL_AUDIT_TTL_SECONDS)

      await client.lPush(recentKey, auditKey)
      await client.lTrim(recentKey, 0, CONTROL_AUDIT_RECENT_LIMIT - 1)
      await client.expire(recentKey, CONTROL_AUDIT_TTL_SECONDS)
    })
  } catch (error) {
    console.warn('[ControlRegistry] Failed to record control audit entry:', error)
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function normalizeInvocation(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function isValidInvocationPattern(value: string): boolean {
  return /^\/[\w:-]+$/.test(value)
}

function buildSlashCommandKey(userId: string, commandId: string): string {
  return `slash_command:${userId}:${commandId}`
}

function resolveFabricIconRef(
  input: unknown,
  legacyInput: unknown,
  existing: IconRef | null | undefined,
  fallback: IconRef
): IconRef {
  if (input !== undefined) {
    const parsed = parseIconRef(input)
    if (!parsed) {
      throw new Error('icon_ref must be a valid icon picker reference.')
    }
    return parsed
  }

  return normalizeOptionalIconRef(legacyInput) ?? existing ?? fallback
}

function normalizeEnabledAgentIdsForCommand(
  value: unknown,
  fallbackAgentId?: string | null
): string[] {
  const fromInput = normalizeStringArray(value) ?? []
  const sanitized = fromInput
    .map((entry) => sanitizeId(entry))
    .filter((entry) => entry.length > 0)

  if (sanitized.length > 0) {
    return Array.from(new Set(sanitized))
  }

  const fallback = typeof fallbackAgentId === 'string' ? sanitizeId(fallbackAgentId) : ''
  return fallback ? [fallback] : []
}

async function executeZipFetch(userId: string, input: Record<string, any>) {
  const zipId = typeof input.zipId === 'string' ? input.zipId.trim() : ''
  if (!zipId) {
    return {
      found: false,
      zipId: ''
    }
  }

  const zipData = await redis.getZip(zipId)
  if (!zipData || typeof zipData !== 'object') {
    return {
      found: false,
      zipId
    }
  }

  const sessionId = (zipData as any)?.metadata?.sessionId || (zipData as any)?.metadata?.session_id || null
  if (sessionId) {
    const session = await redis.getSession(sessionId)
    const owner = (session as any)?.user_id || (session as any)?.userId || null
    if (owner && owner !== userId) {
      return {
        found: false,
        zipId,
        reason: 'Zip belongs to a different user.'
      }
    }
  }

  const fullContent = typeof (zipData as any).content === 'string' ? (zipData as any).content : ''
  const includeContent = input.includeContent !== false
  const maxChars = clampNumber(
    typeof input.maxChars === 'number' ? input.maxChars : DEFAULT_ZIP_CHARS,
    64,
    MAX_ZIP_CHARS
  )
  const content = includeContent ? fullContent.slice(0, maxChars) : undefined

  return {
    found: true,
    zipId: (zipData as any).id ?? zipId,
    type: (zipData as any).type ?? 'unknown',
    tokens: (zipData as any).tokens ?? null,
    description: (zipData as any).description ?? null,
    createdAt: (zipData as any).created_at ?? (zipData as any).createdAt ?? null,
    metadata: (zipData as any).metadata ?? {},
    ...(includeContent
      ? {
          content,
          contentLength: fullContent.length,
          contentTruncated: fullContent.length > maxChars
        }
      : {})
  }
}

async function executeDynamicMcpFind(context: ControlExecutionContext, input: Record<string, any>) {
  return executeSharedDynamicMcpFind({
    userId: context.userId,
    agentId: context.agentId ?? null,
    query: typeof input.query === 'string' ? input.query : undefined,
    tool: typeof input.tool === 'string' ? input.tool : undefined,
    group: input.group,
    exact: input.exact === true,
    limit: typeof input.limit === 'number' ? input.limit : DEFAULT_DYNAMIC_RESULTS,
    selectedGateways: normalizeStringArray(input.selectedGateways) ?? context.selectedGateways,
    includeSchema: input.includeSchema === true,
    projectPath: typeof input.projectPath === 'string' ? input.projectPath : null
  })
}

async function executeDynamicMcpUse(context: ControlExecutionContext, input: Record<string, any>) {
  const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : ''
  return executeSharedDynamicMcpUse({
    userId: context.userId,
    agentId: context.agentId ?? null,
    toolName,
    params: input.params && typeof input.params === 'object' ? input.params : {},
    selectedGateways: normalizeStringArray(input.selectedGateways) ?? context.selectedGateways,
    projectPath: typeof input.projectPath === 'string' ? input.projectPath : null,
    internalToolError: `Tool "${toolName}" is internal-only and not callable via sys.mcp.dynamic.use.`
  })
}

async function executeSkillSave(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = skillSaveInputSchema.parse(input)

  const commandName = parsed.commandName.trim()
  const commandId = sanitizeId((parsed.commandId ?? commandName).trim())
  if (!commandId) {
    throw new Error('commandId/commandName must resolve to a valid slash command id.')
  }

  const commandKey = buildSlashCommandKey(context.userId, commandId)
  const existing = (await redis.json.get(commandKey)) as SlashCommandRow | null
  const nowIso = new Date().toISOString()

  const invocation = normalizeInvocation(parsed.invocation ?? existing?.invocation_pattern ?? `/${commandId}`)
  if (!isValidInvocationPattern(invocation)) {
    throw new Error('Invocation must start with "/" and use only letters, numbers, :, -, or _.')
  }

  const existingEnabledAgentIds = Array.isArray(existing?.enabled_agent_ids)
    ? existing?.enabled_agent_ids
    : []
  const enabledForAllAgents =
    parsed.enabledForAllAgents ?? (existing?.enabled_for_all_agents === true)
  const enabledAgentIds = normalizeEnabledAgentIdsForCommand(
    parsed.enabledAgentIds ?? existingEnabledAgentIds,
    context.agentId
  )

  if (existing?.is_system === true || parsed.skill.isSystem === true || parsed.skill.source === 'system') {
    throw new Error(
      'System skills are repo-backed and cannot be saved from live Batshit. Update files under batshit-app/src/lib/server/system-skills/ from the external coding workspace instead.'
    )
  }

  const upsertedSkill = await upsertSkill({
    userId: context.userId,
    commandId,
    nowIso,
    skill: {
      id: parsed.skill.id,
      name: parsed.skill.name ?? commandName,
      displayName: parsed.skill.displayName,
      description: parsed.skill.description,
      markdown: parsed.skill.markdown,
      source: parsed.skill.source,
      sourceRef: parsed.skill.sourceRef,
      dependencies: (parsed.skill.dependencies ?? []) as SkillDependencyRequirement[],
      license: parsed.skill.license,
      compatibility: parsed.skill.compatibility,
      metadata: parsed.skill.metadata as Record<string, string> | undefined,
      allowedTools: parsed.skill.allowedTools,
      standardsStatus: parsed.skill.standardsStatus as SkillStandardsStatus | undefined,
      standardsIssues: parsed.skill.standardsIssues,
      trustLevel: parsed.skill.trustLevel,
      hasScripts: parsed.skill.hasScripts,
      hasReferences: parsed.skill.hasReferences,
      hasAssets: parsed.skill.hasAssets,
      bundleManifest: parsed.skill.bundleManifest as any,
      bundleFiles: parsed.skill.bundleFiles as any,
      isSystem: parsed.skill.isSystem,
      isActive: parsed.skill.isActive
    }
  })

  const slashCommand: SlashCommandRow = {
    id: commandId,
    user_id: context.userId,
    name: commandName,
    displayName: parsed.commandDisplayName?.trim() || commandName,
    description:
      parsed.commandDescription?.trim() ||
      upsertedSkill.description ||
      existing?.description ||
      '',
    type: 'skill',
    prompt_template: undefined,
    instructions: parsed.instructions ?? existing?.instructions ?? '',
    parameters: [],
    skill_id: upsertedSkill.id,
    skill_source: upsertedSkill.source,
    skill_source_ref: upsertedSkill.source_ref,
    skill_summary: upsertedSkill.description,
    skill_dependencies: upsertedSkill.dependencies ?? [],
    skill_license: upsertedSkill.license,
    skill_compatibility: upsertedSkill.compatibility,
    skill_metadata: upsertedSkill.metadata ?? {},
    skill_allowed_tools: upsertedSkill.allowed_tools ?? [],
    skill_standards_status: upsertedSkill.standards_status,
    skill_standards_issues: upsertedSkill.standards_issues ?? [],
    skill_bundle_manifest: upsertedSkill.bundle_manifest,
    skill_bundle_files: undefined,
    trust_level: upsertedSkill.trust_level,
    has_scripts: upsertedSkill.has_scripts === true,
    has_references: upsertedSkill.has_references === true,
    has_assets: upsertedSkill.has_assets === true,
    invocation_pattern: invocation,
    can_be_attached_to_agents: enabledForAllAgents || enabledAgentIds.length > 0,
    can_be_invoked_in_chat: existing?.can_be_invoked_in_chat ?? true,
    enabled_for_all_agents: enabledForAllAgents,
    enabled_agent_ids: enabledAgentIds,
    category: parsed.category?.trim() || existing?.category || 'skills',
    tags: existing?.tags ?? [],
    icon_ref: resolveFabricIconRef(
      parsed.icon_ref ?? parsed.iconRef,
      parsed.icon,
      existing?.icon_ref ?? normalizeOptionalIconRef(existing?.icon),
      DEFAULT_SKILL_ICON_REF
    ),
    icon: undefined,
    usage_count: existing?.usage_count ?? 0,
    last_used_at: existing?.last_used_at,
    is_active: parsed.isActive ?? existing?.is_active ?? true,
    is_system: false,
    created_at: existing?.created_at || nowIso,
    updated_at: nowIso
  }

  await redis.json.set(commandKey, '$', slashCommand)

  return {
    saved: true,
    command: {
      id: slashCommand.id,
      name: slashCommand.name,
      displayName: slashCommand.displayName,
      invocation: slashCommand.invocation_pattern,
      icon_ref: slashCommand.icon_ref ?? null,
      enabledForAllAgents: slashCommand.enabled_for_all_agents === true,
      enabledAgentIds: slashCommand.enabled_agent_ids ?? [],
      updatedAt: slashCommand.updated_at
    },
    skill: {
      id: upsertedSkill.id,
      name: upsertedSkill.name,
      displayName: upsertedSkill.displayName,
      standardsStatus: upsertedSkill.standards_status ?? 'degraded',
      trustLevel: upsertedSkill.trust_level ?? 'untrusted'
    }
  }
}

async function executeSkillImport(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = skillImportControlInputSchema.parse(input)

  const importInput: SkillImportInput = {
    installCommand: parsed.installCommand,
    sourceType: parsed.sourceType,
    source: parsed.source,
    skillPath: parsed.skillPath,
    trustLevel: parsed.trustLevel
  }

  const imported = await importSkillDefinition(importInput).catch((error) => {
    const failure = toImportErrorResponse(error)
    throw new Error(failure.message)
  })

  const saveAsCommand = parsed.saveAsCommand !== false
  if (!saveAsCommand) {
    const nowIso = new Date().toISOString()
    const savedSkill = await upsertSkill({
      userId: context.userId,
      commandId: sanitizeId(parsed.commandId ?? imported.skill.id ?? imported.skill.name) || 'imported_skill',
      nowIso,
      skill: {
        id: imported.skill.id,
        name: imported.skill.name,
        displayName: imported.skill.displayName,
        description: imported.skill.description,
        markdown: imported.skill.markdown,
        source: imported.skill.source,
        sourceRef: imported.skill.sourceRef,
        dependencies: imported.skill.dependencies,
        license: imported.skill.license,
        compatibility: imported.skill.compatibility,
        metadata: imported.skill.metadata,
        allowedTools: imported.skill.allowedTools,
        standardsStatus: imported.skill.standardsStatus,
        standardsIssues: imported.skill.standardsIssues,
        trustLevel: imported.skill.trustLevel,
        hasScripts: imported.skill.hasScripts,
        hasReferences: imported.skill.hasReferences,
        hasAssets: imported.skill.hasAssets,
        bundleManifest: imported.skill.bundleManifest,
        bundleFiles: imported.skill.bundleFiles
      }
    })

    return {
      imported: true,
      savedAsCommand: false,
      skill: {
        id: savedSkill.id,
        name: savedSkill.name,
        displayName: savedSkill.displayName,
        standardsStatus: savedSkill.standards_status ?? 'degraded',
        trustLevel: savedSkill.trust_level ?? 'untrusted'
      },
      warnings: imported.warnings,
      parsedInstallCommand: imported.parsedInstallCommand ?? null
    }
  }

  const saveResult = await executeSkillSave(context, {
    commandId: parsed.commandId,
    commandName: parsed.commandName ?? imported.skill.name ?? imported.skill.displayName,
    commandDisplayName: parsed.commandDisplayName ?? imported.skill.displayName,
    commandDescription: parsed.commandDescription ?? imported.skill.description,
    invocation: parsed.invocation,
    instructions: parsed.instructions,
    icon_ref: parsed.icon_ref ?? parsed.iconRef,
    icon: parsed.icon,
    category: parsed.category,
    enabledForAllAgents: parsed.enabledForAllAgents,
    enabledAgentIds: parsed.enabledAgentIds,
    isActive: parsed.isActive,
    skill: {
      id: imported.skill.id,
      name: imported.skill.name,
      displayName: imported.skill.displayName,
      description: imported.skill.description,
      markdown: imported.skill.markdown,
      source: imported.skill.source,
      sourceRef: imported.skill.sourceRef,
      dependencies: imported.skill.dependencies,
      license: imported.skill.license,
      compatibility: imported.skill.compatibility,
      metadata: imported.skill.metadata,
      allowedTools: imported.skill.allowedTools,
      standardsStatus: imported.skill.standardsStatus,
      standardsIssues: imported.skill.standardsIssues,
      trustLevel: imported.skill.trustLevel,
      hasScripts: imported.skill.hasScripts,
      hasReferences: imported.skill.hasReferences,
      hasAssets: imported.skill.hasAssets,
      bundleManifest: imported.skill.bundleManifest,
      bundleFiles: imported.skill.bundleFiles
    }
  })

  return {
    imported: true,
    savedAsCommand: true,
    ...saveResult,
    warnings: imported.warnings,
    parsedInstallCommand: imported.parsedInstallCommand ?? null
  }
}

function normalizeVoiceEngineId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('engineId must be a string.')
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throw new Error('engineId is required.')
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error('engineId must use lowercase letters, numbers, dots, underscores, or dashes.')
  }
  return normalized
}

async function executeVoiceEngineRegister(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineMutationSchema.parse(input)
  const engineId = normalizeVoiceEngineId(parsed.engineId)
  const result = await upsertVoiceEngineRecord(context.userId, engineId, parsed.payload)

  return {
    engineId,
    providerId: `byo:${engineId}`,
    created: result.created,
    engine: result.summary
  }
}

async function executeVoiceEngineUpdate(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineMutationSchema.parse(input)
  const engineId = normalizeVoiceEngineId(parsed.engineId)
  const result = await upsertVoiceEngineRecord(context.userId, engineId, parsed.payload)

  return {
    engineId,
    providerId: `byo:${engineId}`,
    updated: true,
    engine: result.summary
  }
}

async function executeVoiceEngineHealthCheck(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineHealthCheckInputSchema.parse(input)
  const engineId = normalizeVoiceEngineId(parsed.engineId)
  const providerId = `byo:${engineId}` as const
  const status = await checkByoSpeechStatus(context.userId, providerId)

  return {
    engineId,
    providerId,
    ready: status.ready,
    statusHint: status.statusHint
  }
}

async function executeVoiceEngineCompleteLocalSetup(
  context: ControlExecutionContext,
  input: Record<string, any>
) {
  const parsed = localVoiceEngineSetupInputSchema.parse(input)

  return await completeLocalVoiceEngineSetup(context.userId, parsed)
}

async function executeVoiceEngineModelDownload(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineModelActionInputSchema.parse(input)
  return await downloadVoiceEngineModel(context.userId, parsed.engineId, parsed.modelId)
}

async function executeVoiceEngineModelUse(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineModelActionInputSchema.parse(input)
  return await useVoiceEngineModel(context.userId, parsed.engineId, parsed.modelId)
}

async function executeVoiceEngineModelDelete(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineModelActionInputSchema.parse(input)
  return await deleteVoiceEngineModel(context.userId, parsed.engineId, parsed.modelId)
}

async function executeVoiceEngineEnable(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineEnableInputSchema.parse(input)
  const engineId = normalizeVoiceEngineId(parsed.engineId)
  const engine = await setVoiceEngineEnabled(context.userId, engineId, parsed.enabled)

  return {
    engineId,
    providerId: `byo:${engineId}`,
    enabled: parsed.enabled,
    engine
  }
}

async function executeVoiceEngineDelete(context: ControlExecutionContext, input: Record<string, any>) {
  const parsed = voiceEngineDeleteInputSchema.parse(input)
  const engineId = normalizeVoiceEngineId(parsed.engineId)
  const result = await deleteVoiceEngineRecord(context.userId, engineId, {
    deleteLocalFiles: parsed.deleteLocalFiles === true
  })

  return {
    engineId,
    providerId: `byo:${engineId}`,
    deleted: true,
    clearedUserDefaults: result.clearedUserDefaults,
    clearedAgentIds: result.clearedAgentIds,
    deletedVoiceProfileIds: result.deletedVoiceProfileIds,
    localFiles: result.localFiles
  }
}

function normalizeArtifactId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('artifactId is required')
  }
  return value.trim()
}

function toNullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, any>
}

function resolveDynamicArtifactZoneInput(input: Record<string, any>): string | null {
  const resolveZoneFromRecord = (record: Record<string, any> | null): string | null => {
    if (!record) return null
    for (const key of DYNAMIC_ARTIFACT_ZONE_INPUT_KEYS) {
      const candidate = toNullableString(record[key])
      if (candidate) return candidate
    }
    return null
  }

  const directZone = resolveZoneFromRecord(input)
  if (directZone) return directZone

  const valueZone = toNullableString(input.value)
  if (valueZone) return valueZone

  const nestedValueZone = resolveZoneFromRecord(toRecord(input.value))
  if (nestedValueZone) return nestedValueZone

  const nestedPayloadZone = resolveZoneFromRecord(toRecord(input.payload))
  if (nestedPayloadZone) return nestedPayloadZone

  const nestedArgsZone = resolveZoneFromRecord(toRecord(input.args))
  if (nestedArgsZone) return nestedArgsZone

  const nestedParamsZone = resolveZoneFromRecord(toRecord(input.params))
  if (nestedParamsZone) return nestedParamsZone

  const nestedParametersZone = resolveZoneFromRecord(toRecord(input.parameters))
  if (nestedParametersZone) return nestedParametersZone

  const nestedInputZone = resolveZoneFromRecord(toRecord(input.input))
  if (nestedInputZone) return nestedInputZone

  return null
}

function serializeControlError(error: unknown): { message: string; status: number | null } {
  if (error && typeof error === 'object') {
    const anyError = error as { message?: unknown; status?: unknown; body?: unknown }
    const bodyMessage =
      anyError.body && typeof anyError.body === 'object'
        ? (anyError.body as Record<string, unknown>).message
        : null
    const message =
      typeof anyError.message === 'string'
        ? anyError.message
        : typeof bodyMessage === 'string'
          ? bodyMessage
          : 'Control execution failed.'
    const status = typeof anyError.status === 'number' ? anyError.status : null
    return { message, status }
  }
  return { message: 'Control execution failed.', status: null }
}

function toArtifactExecutionError(error: unknown) {
  const normalized = serializeControlError(error)
  return {
    success: false,
    error: normalized.message,
    status: normalized.status
  }
}

function toCliToolExecutionError(error: unknown) {
  const normalized = serializeControlError(error)
  return {
    success: false,
    error: normalized.message,
    status: normalized.status
  }
}

function resolveBatshitFrontendBaseUrl(): string {
  const configured = (env.BATSHIT_FRONTEND_URL || '').trim()
  const fallback = 'http://localhost:5620'
  return rewriteContainerLoopbackAppUrl(configured || fallback).replace(/\/+$/, '')
}

function resolveArtifactCompleteUrl(): string {
  const configured = (env.BATSHIT_ARTIFACT_COMPLETE_URL || '').trim()
  if (configured.length > 0) return rewriteContainerLoopbackAppUrl(configured)
  return `${resolveBatshitFrontendBaseUrl()}/api/artifacts/complete`
}

function rewriteContainerLoopbackAppUrl(rawUrl: string): string {
  if (env.BATSHIT_CONTAINERIZED !== '1') return rawUrl

  try {
    const url = new URL(rawUrl)
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return rawUrl
    url.hostname = '127.0.0.1'
    url.port = (env.PORT || '3000').trim() || '3000'
    return url.toString()
  } catch {
    return rawUrl
  }
}

function resolveProjectRoot(): string {
  const configured = (env.BATSHIT_PROJECT_ROOT || '').trim()
  if (configured.length > 0) return configured
  return process.cwd()
}

async function resolveInternalBatshitToken(_userId: string): Promise<string> {
  const envToken = (env.BATSHIT_TOKEN || '').trim()
  return envToken
}

type ParsedArtifactFileEvent = {
  base64: string
  mediaType: string
  index: number
}

type ParsedNdjsonArtifactResponse = {
  text: string
  usage: Record<string, any> | null
  files: ParsedArtifactFileEvent[]
  transport: string | null
}

type ArtifactGeneratedFileSummary = {
  index: number
  mediaType: string
}

type ArtifactAutoShareResult = {
  success: boolean
  clipId?: string
  messageId?: string
  error?: string
}

async function parseNdjsonTextResponse(response: Response): Promise<ParsedNdjsonArtifactResponse> {
  if (!response.body) {
    return { text: '', usage: null as Record<string, any> | null, files: [], transport: null }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let aggregated = ''
  let usage: Record<string, any> | null = null
  let transport: string | null = null
  const files: ParsedArtifactFileEvent[] = []

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      let event: Record<string, any> | null = null
      try {
        event = JSON.parse(line)
      } catch {
        event = null
      }
      if (!event) continue
      if (!transport && typeof event?.metadata?.transport === 'string') {
        transport = event.metadata.transport
      }

      const type =
        typeof event.type === 'string'
          ? event.type
          : typeof event.event === 'string'
            ? event.event
            : typeof event.kind === 'string'
              ? event.kind
              : ''
      if (type === 'chunk') {
        aggregated += event.content || ''
      } else if (type === 'file') {
        if (typeof event.base64 === 'string' && typeof event.mediaType === 'string') {
          files.push({
            base64: event.base64,
            mediaType: event.mediaType,
            index: typeof event.index === 'number' ? event.index : files.length
          })
        }
      } else if (type === 'finish') {
        if (event.content) aggregated += event.content
        usage = (event.usage as Record<string, any>) || (event.metadata?.usage as Record<string, any>) || usage
      } else if (type === 'end' && event.metadata?.usage) {
        usage = event.metadata.usage as Record<string, any>
        if (typeof event.content === 'string' && event.content.trim().length > 0) {
          aggregated = event.content
        }
      } else if (type === 'error') {
        throw new Error(typeof event.error === 'string' ? event.error : 'Artifact completion failed')
      }
    }
  }

  return {
    text: aggregated.trim(),
    usage,
    files,
    transport
  }
}

function summarizeArtifactGeneratedFiles(files: ParsedArtifactFileEvent[]): ArtifactGeneratedFileSummary[] {
  return files.map((entry) => ({
    index: entry.index,
    mediaType: entry.mediaType
  }))
}

function resolveContextSessionId(context: ControlExecutionContext): string | null {
  return typeof context.sessionId === 'string' && context.sessionId.trim().length > 0
    ? context.sessionId.trim()
    : null
}

function resolveRequestedSessionId(input: Record<string, any>): string | null {
  return typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
    ? input.sessionId.trim()
    : null
}

async function maybeAutoShareArtifactFilesToChat(options: {
  context: ControlExecutionContext
  input: Record<string, any>
  token: string
  artifactId: string
  artifactName?: string | null
  files: ParsedArtifactFileEvent[]
  generatedFiles: ArtifactGeneratedFileSummary[]
}): Promise<ArtifactAutoShareResult | undefined> {
  const contextSessionId = resolveContextSessionId(options.context)
  const shareToChatRequested = options.input.shareToChat === true || options.input.share_to_chat === true
  const shareExplicitlyDisabled = options.input.shareToChat === false || options.input.share_to_chat === false
  const shouldAutoShareToChat =
    options.generatedFiles.length > 0 &&
    Boolean(contextSessionId) &&
    !shareExplicitlyDisabled &&
    (shareToChatRequested || Boolean(options.context.agentId))

  if (shouldAutoShareToChat && contextSessionId && options.files[0]?.base64) {
    try {
      const artifactName =
        (typeof options.input.artifactName === 'string' && options.input.artifactName.trim().length > 0
          ? options.input.artifactName.trim()
          : typeof options.input.artifact_name === 'string' && options.input.artifact_name.trim().length > 0
            ? options.input.artifact_name.trim()
            : typeof options.artifactName === 'string' && options.artifactName.trim().length > 0
              ? options.artifactName.trim()
              : options.artifactId)

      const shareResponse = await fetch(`${resolveBatshitFrontendBaseUrl()}/api/artifacts/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-batshit-token': options.token,
          'x-batshit-user-id': options.context.userId
        },
        body: JSON.stringify({
          userId: options.context.userId,
          artifactId: options.artifactId,
          artifactName,
          type: 'data',
          format: 'image',
          content: options.files[0].base64,
          sessionId: contextSessionId,
          includeInChat: true,
          initiator: options.context.agentId ? 'agent' : 'user'
        }),
        signal: AbortSignal.timeout(60_000)
      })

      const sharePayload = await shareResponse.json().catch(() => null)
      if (!shareResponse.ok || !sharePayload || sharePayload.success !== true) {
        return {
          success: false,
          error:
            typeof sharePayload?.error === 'string'
              ? sharePayload.error
              : `artifact share failed (${shareResponse.status})`
        }
      }

      return {
        success: true,
        clipId: typeof sharePayload.clipId === 'string' ? sharePayload.clipId : undefined,
        messageId: typeof sharePayload.messageId === 'string' ? sharePayload.messageId : undefined
      }
    } catch (shareError) {
      return {
        success: false,
        error: shareError instanceof Error ? shareError.message : 'Artifact share failed.'
      }
    }
  }

  if (shareToChatRequested && !contextSessionId) {
    return {
      success: false,
      error: 'shareToChat requested but no active chat session is available.'
    }
  }

  return undefined
}

type ArtifactReadPayloadOptions = {
  includeContent: boolean
  includeVersions: boolean
  includeVersionContents: boolean
}

function buildArtifactLifecycleSummary(artifact: ArtifactRecord): Record<string, any> {
  return {
    id: artifact.id,
    name: artifact.name,
    slug: artifact.slug,
    type: artifact.type,
    mode: artifact.mode,
    zone: artifact.zone ?? null,
    version: artifact.version,
    versionCount: Array.isArray(artifact.versions) ? artifact.versions.length : 0,
    contentChars: typeof artifact.content === 'string' ? artifact.content.length : 0,
    brain_type: artifact.brain_type ?? null,
    webhookConfigured: typeof artifact.webhook_url === 'string' && artifact.webhook_url.trim().length > 0,
    agentUseEnabled: artifact.agent_use_enabled !== false,
    hasBlueprint: typeof artifact.blueprint === 'string' && artifact.blueprint.trim().length > 0,
    icon_ref: artifact.icon_ref ?? normalizeOptionalIconRef(artifact.icon),
    updated_at: artifact.updated_at,
    published_at: artifact.published_at ?? null
  }
}

function buildArtifactVersionPayload(
  version: NonNullable<ArtifactRecord['versions']>[number],
  includeContent: boolean
): Record<string, any> {
  const payload: Record<string, any> = {
    id: version.id,
    version: version.version,
    description: version.description ?? null,
    created_at: version.created_at,
    created_by: version.created_by,
    contentChars: typeof version.content === 'string' ? version.content.length : 0
  }

  if (includeContent) {
    payload.content = version.content
  }

  return payload
}

function buildArtifactReadPayload(
  artifact: ArtifactRecord,
  options: ArtifactReadPayloadOptions
): Record<string, any> {
  const payload: Record<string, any> = {
    ...artifact,
    contentChars: typeof artifact.content === 'string' ? artifact.content.length : 0,
    versionCount: Array.isArray(artifact.versions) ? artifact.versions.length : 0
  }

  if (!options.includeContent) {
    delete payload.content
  }

  if (options.includeVersions) {
    payload.versions = Array.isArray(artifact.versions)
      ? artifact.versions.map((version) =>
          buildArtifactVersionPayload(version, options.includeVersionContents)
        )
      : []
  } else {
    delete payload.versions
  }

  return payload
}

function buildCliToolSafetySummary(tool: CliToolRecord): string {
  const parts: string[] = []
  if (tool.allowWrite) {
    const pathCount = Array.isArray(tool.allowedPaths) ? tool.allowedPaths.length : 0
    parts.push(
      pathCount > 0
        ? `Can write inside ${pathCount} allowed path${pathCount === 1 ? '' : 's'}`
        : 'Can write files'
    )
  } else {
    parts.push('Read-only')
  }

  parts.push(tool.allowNetwork ? 'Network access declared' : 'No network access declared')

  if (tool.riskLevel === 'confirm') {
    parts.push('Requires approval before execution')
  } else if (tool.riskLevel === 'restricted') {
    parts.push('Execution blocked by policy')
  } else {
    parts.push('Safe execution policy')
  }

  return parts.join(' • ')
}

function buildCliToolCapabilitySummary(tool: CliToolRecord): string {
  const outputLabel =
    tool.outputMode === 'mixed'
      ? 'mixed output'
      : tool.outputMode === 'json'
        ? 'structured JSON output'
        : 'text output'
  const cwdLabel =
    tool.cwdPolicy === 'project'
      ? 'runs in the active project'
      : tool.cwdPolicy === 'fixed' && tool.cwdValue
        ? `runs in ${tool.cwdValue}`
        : 'runs without a fixed working directory'

  return `Connected to ${tool.executable}; returns ${outputLabel}; ${cwdLabel}.`
}

function buildCliToolSummary(tool: CliToolRecord): Record<string, any> {
  return {
    toolId: tool.toolId,
    title: tool.title,
    description: tool.description,
    status: tool.status,
    origin: tool.origin,
    iconRef: tool.iconRef ?? normalizeOptionalIconRef(tool.iconHint),
    executable: tool.executable,
    riskLevel: tool.riskLevel,
    outputMode: tool.outputMode,
    parseMode: tool.parseMode,
    validationStatus: tool.lastValidationStatus ?? 'never',
    validationSummary: tool.lastValidationSummary ?? null,
    executionHint:
      'Use sys.cli_tool.test for authoring verification. To run the saved tool in chat, it must be selected in the current chat Tools panel.',
    capabilitySummary: buildCliToolCapabilitySummary(tool),
    safetySummary: buildCliToolSafetySummary(tool)
  }
}

function buildCliToolDetailPayload(tool: CliToolRecord): Record<string, any> {
  return {
    ...buildCliToolSummary(tool),
    tool,
    basic: {
      title: tool.title,
      description: tool.description,
      status: tool.status,
      iconRef: tool.iconRef ?? normalizeOptionalIconRef(tool.iconHint),
      connectedTo: tool.executable,
      capabilitySummary: buildCliToolCapabilitySummary(tool),
      safetySummary: buildCliToolSafetySummary(tool),
      executionHint:
        'Use sys.cli_tool.test for authoring verification. To run the saved tool in chat, it must be selected in the current chat Tools panel.',
      validationStatus: tool.lastValidationStatus ?? 'never',
      validationSummary: tool.lastValidationSummary ?? null
    },
    advanced: {
      toolId: tool.toolId,
      tags: tool.tags,
      origin: tool.origin,
      executable: tool.executable,
      argsTemplate: tool.argsTemplate,
      inputSchema: tool.inputSchema,
      outputMode: tool.outputMode,
      parseMode: tool.parseMode,
      cwdPolicy: tool.cwdPolicy,
      cwdValue: tool.cwdValue ?? null,
      timeoutMs: tool.timeoutMs,
      envRefs: tool.envRefs ?? [],
      riskLevel: tool.riskLevel,
      allowNetwork: tool.allowNetwork,
      allowWrite: tool.allowWrite,
      allowedPaths: tool.allowedPaths ?? [],
      helpCommand: tool.helpCommand ?? [],
      validationInput: tool.validationInput ?? null,
      examples: tool.examples ?? []
    }
  }
}

async function executeCliToolList(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const tools = await listCliTools(context.userId)
    const filtered = tools.filter((tool) => {
      if (input.includeArchived !== true && tool.status === 'archived') return false
      if (typeof input.status === 'string' && input.status.trim().length > 0) {
        return tool.status === input.status.trim()
      }
      return true
    })

    return {
      success: true,
      toolView: 'summary',
      tools: filtered.map((tool) => buildCliToolSummary(tool)),
      total: filtered.length,
      recommendedFlow:
        'For authoring, prefer the /cli-tool-creator system skill or Batshit agent guidance instead of manual manifest editing.'
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

async function executeCliToolGet(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const toolId = typeof input.toolId === 'string' ? input.toolId.trim() : ''
    const tool = await getCliTool(context.userId, toolId)
    if (!tool) {
      return {
        success: false,
        error: `CLI tool "${toolId}" was not found.`,
        status: 404,
        toolId
      }
    }

    return {
      success: true,
      toolView: 'detail',
      cliTool: buildCliToolDetailPayload(tool)
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

async function executeCliToolCreate(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const tool = await createCliTool(context.userId, {
      origin: 'generated',
      status: 'active',
      ...input
    })
    return {
      success: true,
      toolView: 'detail',
      cliTool: buildCliToolDetailPayload(tool),
      executionHint:
        'Use sys.cli_tool.test to validate the saved record. Actual chat execution only works after this tool is selected in the current chat Tools panel.',
      message: `CLI tool "${tool.title}" was created and is now ${tool.status}.`
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

async function executeCliToolUpdate(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const toolId = typeof input.toolId === 'string' ? input.toolId.trim() : ''
    const { toolId: _ignoredToolId, ...updates } = input
    const tool = await updateCliTool(context.userId, toolId, updates)
    return {
      success: true,
      toolView: 'detail',
      cliTool: buildCliToolDetailPayload(tool),
      message: `CLI tool "${tool.title}" was updated.`
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

async function executeCliToolTest(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const toolId = typeof input.toolId === 'string' ? input.toolId.trim() : ''
    const tool = await getCliTool(context.userId, toolId)
    if (!tool) {
      return {
        success: false,
        error: `CLI tool "${toolId}" was not found.`,
        status: 404
      }
    }

    const validation = await validateCliTool(context.userId, tool.toolId, {
      projectPath: typeof input.projectPath === 'string' ? input.projectPath : null
    })

    return {
      success: validation.success,
      toolView: 'validation',
      cliTool: buildCliToolSummary(tool),
      validation,
      verificationMode: 'registry_validation',
      executionHint:
        'This validates the saved record. To actually run the tool in chat, select it in the current chat Tools panel instead of looking for it through Dynamic MCP.',
      message: `${validation.summary} To run the tool in chat, select it in the current chat Tools panel.`
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

async function executeCliToolArchive(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const toolId = typeof input.toolId === 'string' ? input.toolId.trim() : ''
    const status =
      input.status === 'active' || input.status === 'disabled' || input.status === 'archived'
        ? input.status
        : 'archived'
    const tool = await updateCliTool(context.userId, toolId, { status })
    return {
      success: true,
      toolView: 'summary',
      cliTool: buildCliToolSummary(tool),
      message: `CLI tool "${tool.title}" is now ${tool.status}.`
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

async function executeCliToolDelete(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const toolId = typeof input.toolId === 'string' ? input.toolId.trim() : ''
    const existing = await getCliTool(context.userId, toolId)
    if (!existing) {
      return {
        success: false,
        error: `CLI tool "${toolId}" was not found.`,
        status: 404
      }
    }
    await deleteCliTool(context.userId, toolId)
    return {
      success: true,
      deleted: true,
      toolId,
      title: existing.title,
      message: `CLI tool "${existing.title}" was deleted.`
    }
  } catch (error) {
    return toCliToolExecutionError(error)
  }
}

function normalizeCatalogSearchTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function catalogTermVariants(value: unknown): string[] {
  const normalized = normalizeCatalogSearchTerm(value)
  if (!normalized) return []
  const withoutDirect = normalized.startsWith('direct:') ? normalized.slice('direct:'.length) : ''
  const withDirect = normalized.includes(':') ? '' : `direct:${normalized}`
  return Array.from(new Set([normalized, withoutDirect, withDirect].filter(Boolean)))
}

function catalogTokens(value: unknown): string[] {
  const normalized = normalizeCatalogSearchTerm(value)
  if (!normalized) return []
  return normalized.split(/[^a-z0-9._:-]+/).filter((entry) => entry.length > 0)
}

function catalogConnectionTermMatches(candidate: string, requested: string): boolean {
  if (!candidate || !requested) return false
  if (candidate === requested) return true
  if (candidate.includes(':') && candidate.endsWith(`:${requested}`)) return true
  if (!candidate.includes(':') && !requested.includes(':') && candidate.includes(requested)) return true
  return false
}

function catalogVariantEntries(
  entry: VercelCatalogEntry
): Array<{ connectionId: string; variant: CatalogModelIdVariant }> {
  return Object.entries(entry.idVariants ?? {}).map(([connectionId, variant]) => ({
    connectionId,
    variant
  }))
}

function catalogEntryText(entry: VercelCatalogEntry): string {
  const variantText = catalogVariantEntries(entry)
    .flatMap(({ connectionId, variant }) => [
      connectionId,
      variant.developerId,
      variant.modelId,
      variant.effectiveId,
      variant.source
    ])
    .join(' ')
  return [
    entry.id,
    entry.canonicalId,
    entry.provider,
    entry.upstreamProvider,
    entry.name,
    entry.displayName,
    entry.description,
    entry.purpose,
    entry.source,
    entry.transport,
    entry.connectionId,
    ...(entry.availableConnections ?? []),
    ...(entry.tags ?? []),
    variantText
  ]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .toLowerCase()
}

function catalogEntryMatchesProvider(entry: VercelCatalogEntry, provider: string): boolean {
  if (!provider) return true
  const variants = catalogTermVariants(provider)
  const candidates = [
    entry.source,
    entry.transport,
    entry.connectionId,
    ...(entry.availableConnections ?? []),
    ...catalogVariantEntries(entry).flatMap(({ connectionId, variant }) => [
      connectionId,
      variant.source
    ])
  ]
  const normalizedCandidates = candidates.flatMap((candidate) => catalogTermVariants(candidate))
  return variants.some((variant) =>
    normalizedCandidates.some((candidate) => catalogConnectionTermMatches(candidate, variant))
  )
}

function catalogEntryMatchesDeveloper(entry: VercelCatalogEntry, developer: string): boolean {
  if (!developer) return true
  const variants = catalogTermVariants(developer)
  const candidates = [
    entry.provider,
    entry.upstreamProvider,
    ...catalogVariantEntries(entry).map(({ variant }) => variant.developerId)
  ]
  const normalizedCandidates = candidates.flatMap((candidate) => catalogTermVariants(candidate))
  return variants.some((variant) =>
    normalizedCandidates.some(
      (candidate) => candidate === variant || candidate.includes(variant) || variant.includes(candidate)
    )
  )
}

function catalogEntryMatchesModelId(entry: VercelCatalogEntry, modelId: string): boolean {
  if (!modelId) return true
  const query = normalizeCatalogSearchTerm(modelId)
  return [
    entry.id,
    entry.canonicalId,
    entry.name,
    entry.displayName,
    ...catalogVariantEntries(entry).flatMap(({ variant }) => [
      variant.modelId,
      variant.effectiveId
    ])
  ]
    .map((candidate) => normalizeCatalogSearchTerm(candidate))
    .some((candidate) => candidate === query || candidate.includes(query) || query.includes(candidate))
}

function scoreCatalogEntry(entry: VercelCatalogEntry, input: Record<string, any>): number {
  const text = catalogEntryText(entry)
  const queryTokens = catalogTokens(input.query)
  const modelId = normalizeCatalogSearchTerm(input.modelId)
  const provider = normalizeCatalogSearchTerm(input.provider ?? input.connection)
  const developer = normalizeCatalogSearchTerm(input.developer)
  let score = 1

  if (queryTokens.length > 0) {
    score += queryTokens.reduce((total, token) => total + (text.includes(token) ? 8 : 0), 0)
  }

  if (modelId) {
    const exactModelCandidates = [
      entry.id,
      entry.canonicalId,
      entry.name,
      ...catalogVariantEntries(entry).flatMap(({ variant }) => [
        variant.modelId,
        variant.effectiveId
      ])
    ].map((candidate) => normalizeCatalogSearchTerm(candidate))
    if (exactModelCandidates.some((candidate) => candidate === modelId)) score += 100
  }

  const displayName = normalizeCatalogSearchTerm(entry.displayName)
  if (displayName && queryTokens.some((token) => displayName.includes(token))) score += 12
  if (entry.purpose === input.purpose) score += 10
  if (provider && catalogEntryMatchesProvider(entry, provider)) score += 6
  if (developer && catalogEntryMatchesDeveloper(entry, developer)) score += 6

  return score
}

function selectCatalogVariant(
  entry: VercelCatalogEntry,
  requestedConnection: string
): { connectionId: string | null; variant: CatalogModelIdVariant | null } {
  const entries = catalogVariantEntries(entry)
  if (entries.length === 0) {
    return { connectionId: entry.connectionId ?? null, variant: null }
  }

  const requestedVariants = catalogTermVariants(requestedConnection)
  if (requestedVariants.length > 0) {
    const connectionMatch = entries.find(({ connectionId }) => {
      const candidates = catalogTermVariants(connectionId)
      return requestedVariants.some((requested) =>
        candidates.some((candidate) => catalogConnectionTermMatches(candidate, requested))
      )
    })
    if (connectionMatch) return connectionMatch

    const match = entries.find(({ connectionId, variant }) => {
      const candidates = catalogTermVariants(connectionId)
      candidates.push(...catalogTermVariants(variant.source))
      return requestedVariants.some((requested) =>
        candidates.some((candidate) => catalogConnectionTermMatches(candidate, requested))
      )
    })
    if (match) return match
  }

  const connectionId = normalizeCatalogSearchTerm(entry.connectionId)
  if (connectionId) {
    const match = entries.find(({ connectionId: candidate }) => normalizeCatalogSearchTerm(candidate) === connectionId)
    if (match) return match
  }

  const direct = entries.find(({ variant }) => variant.source === 'direct')
  return direct ?? entries[0]
}

function catalogConnectionInfo(
  entry: VercelCatalogEntry,
  selected: { connectionId: string | null; variant: CatalogModelIdVariant | null }
): Record<string, any> {
  const connectionId = selected.connectionId ?? entry.connectionId ?? null
  const source = normalizeCatalogSearchTerm(selected.variant?.source)
  const transport = normalizeCatalogSearchTerm(entry.transport)

  if (connectionId?.startsWith('direct:') || source === 'direct') {
    const service =
      connectionId?.startsWith('direct:')
        ? connectionId.slice('direct:'.length)
        : entry.upstreamProvider ?? entry.provider
    return {
      id: connectionId ?? (service ? `direct:${service}` : null),
      type: 'direct',
      service: service || null
    }
  }

  if (connectionId === 'vercel-gateway' || source === 'vercel' || (!connectionId && transport === 'vercel-gateway')) {
    return { id: connectionId ?? 'vercel-gateway', type: 'vercel-gateway', service: null }
  }

  if (connectionId?.startsWith('openrouter') || source === 'openrouter' || transport === 'openrouter') {
    return { id: connectionId ?? 'openrouter', type: 'openrouter', service: 'openrouter' }
  }

  return { id: connectionId, type: entry.transport ?? null, service: null }
}

function catalogArtifactOutputKind(entry: VercelCatalogEntry, modelIdForArtifact: string): string {
  if (entry.purpose === 'audio') return 'audio'
  if (entry.purpose === 'utility') return 'utility'
  if (entry.purpose !== 'visual') return 'text'

  if (detectImageModel(modelIdForArtifact).type !== 'text-only') return 'image'

  const features = entry.features ?? {}
  if ((features as any).videoGeneration === true || (features as any).video === true) return 'video'
  if ((features as any).threeD === true || (features as any)['3d'] === true || (features as any).mesh === true) {
    return '3d'
  }
  if (
    (features as any).imageGeneration === true ||
    (features as any).image === true ||
    (features as any).images === true ||
    (features as any).textToImage === true ||
    (features as any).image_generation === true
  ) {
    return 'image'
  }

  const searchable = [
    entry.id,
    entry.canonicalId,
    entry.name,
    entry.displayName,
    ...(entry.tags ?? [])
  ].join(' ').toLowerCase()

  if (['video', 'sora', 'veo', 'runway', 'kling', 'pika', 'ray-', 'ray ', 'wan-'].some((term) => searchable.includes(term))) {
    return 'video'
  }
  if (['3d', 'mesh', 'meshy', 'tripo', 'rodin'].some((term) => searchable.includes(term))) {
    return '3d'
  }
  if (
    [
      'image',
      'gpt-image',
      'dall-e',
      'dalle',
      'imagen',
      'flux',
      'photon',
      'stable-diffusion',
      'sdxl',
      'firefly',
      'ideogram',
      'recraft',
      'seedream',
      'nano-banana'
    ].some((term) => searchable.includes(term))
  ) {
    return 'image'
  }

  return 'visual'
}

function toModelCatalogResult(
  entry: VercelCatalogEntry,
  requestedConnection: string,
  includePricing: boolean
): Record<string, any> {
  const selected = selectCatalogVariant(entry, requestedConnection)
  const modelIdForArtifact =
    selected.variant?.effectiveId ||
    selected.variant?.modelId ||
    entry.name ||
    entry.id
  const artifactConnection = catalogConnectionInfo(entry, selected)
  const outputKind = catalogArtifactOutputKind(entry, modelIdForArtifact)
  const keyService =
    artifactConnection.type === 'direct' && typeof artifactConnection.service === 'string'
      ? artifactConnection.service
      : null
  const artifactModelConfig = {
    mode: 'basic',
    primary: {
      source: 'manual',
      modelId: modelIdForArtifact
    }
  }

  return {
    id: entry.id,
    canonicalId: entry.canonicalId ?? null,
    displayName: entry.displayName,
    purpose: entry.purpose ?? null,
    provider: {
      connectionId: selected.connectionId ?? entry.connectionId ?? null,
      catalogProvider: entry.provider,
      upstreamProvider: entry.upstreamProvider ?? null,
      source: entry.source,
      transport: entry.transport ?? null,
      availableConnections: entry.availableConnections ?? []
    },
    developer: selected.variant?.developerId ?? entry.upstreamProvider ?? entry.provider,
    catalogModelId: selected.variant?.modelId ?? entry.name,
    modelIdForArtifact,
    artifact: {
      modelConfig: artifactModelConfig,
      runtime: {
        model: modelIdForArtifact,
        purpose: entry.purpose ?? null,
        outputKind,
        connection: artifactConnection,
        savedApiKeyService: keyService,
        savedApiKeyRequired:
          artifactConnection.type === 'direct' && keyService
            ? `A saved ${keyService} API key is required. Agents can check user_api_keys_configured, but cannot read the secret value.`
            : null
      },
      mustInclude: [
        'Store artifact.model_config exactly from artifact.modelConfig, or pass modelIdForArtifact exactly in each runtime AI call.',
        'Do not leave model_config unset for a finished built-in AI artifact unless the artifact deliberately exposes a runtime model picker.',
        'After publishing/testing, inspect artifact run logs. For image artifacts, run-log fileCount or runtime generatedFileCount must be greater than 0.'
      ]
    },
    tags: (entry.tags ?? []).slice(0, 12),
    features: entry.features ?? {},
    contextWindow: entry.contextWindow ?? null,
    maxOutputTokens: entry.maxOutputTokens ?? null,
    variants: catalogVariantEntries(entry).map(({ connectionId, variant }) => ({
      connectionId,
      developer: variant.developerId,
      modelId: variant.modelId,
      effectiveId: variant.effectiveId,
      source: variant.source
    })),
    ...(includePricing ? { pricing: entry.pricing ?? null } : {})
  }
}

async function executeModelCatalogSearch(input: Record<string, any>): Promise<Record<string, any>> {
  try {
    const provider = normalizeCatalogSearchTerm(input.provider ?? input.connection)
    const developer = normalizeCatalogSearchTerm(input.developer)
    const modelId = normalizeCatalogSearchTerm(input.modelId)
    const purpose = typeof input.purpose === 'string' ? input.purpose : ''
    const limit = clampNumber(
      typeof input.limit === 'number' ? input.limit : DEFAULT_MODEL_CATALOG_RESULTS,
      1,
      MAX_MODEL_CATALOG_RESULTS
    )
    const catalog = await fetchVercelModelCatalog(input.forceRefresh === true)
    const scored = catalog.models
      .filter((entry) => {
        if (purpose && entry.purpose !== purpose) return false
        if (!catalogEntryMatchesProvider(entry, provider)) return false
        if (!catalogEntryMatchesDeveloper(entry, developer)) return false
        if (!catalogEntryMatchesModelId(entry, modelId)) return false
        return true
      })
      .map((entry) => ({
        entry,
        score: scoreCatalogEntry(entry, input)
      }))
      .sort((left, right) => right.score - left.score || left.entry.displayName.localeCompare(right.entry.displayName))

    const results = scored
      .slice(0, limit)
      .map(({ entry }) => toModelCatalogResult(entry, provider, input.includePricing === true))
    const firstModelId = results[0]?.modelIdForArtifact
    const firstArtifact = results[0]?.artifact ?? null

    return {
      success: true,
      catalogFetchedAt: catalog.fetchedAt,
      totalMatches: scored.length,
      returned: results.length,
      query: input.query ?? null,
      provider: provider || null,
      developer: developer || null,
      modelId: modelId || null,
      purpose: purpose || null,
      results,
      guidance: {
        terminology: {
          provider:
            'Provider is the API key or connection route Batshit will call, such as direct Google, OpenAI direct, or OpenRouter.',
          developer:
            'Developer is the model maker namespace, such as Google, OpenAI, Anthropic, or Black Forest Labs.',
          modelId:
            'Model ID is the exact provider/developer model string. For artifact manual model_config, use modelIdForArtifact from the chosen result.'
        },
        artifactModelConfig: firstModelId
          ? firstArtifact?.modelConfig ?? {
              mode: 'basic',
              primary: {
                source: 'manual',
                modelId: firstModelId
              }
            }
          : null,
        artifactRuntimeRequirements: firstArtifact?.runtime ?? null,
        noSilentFallback:
          'If the intended model is missing or ambiguous, ask the user before choosing a different provider/model. Do not silently fall back.',
        verification:
          'For generated media artifacts, run the artifact once before handoff and inspect run logs. Success with run-log fileCount: 0 or runtime generatedFileCount: 0 is not acceptable for image generation.'
      }
    }
  } catch (error) {
    const normalized = serializeControlError(error)
    return {
      success: false,
      error: normalized.message,
      status: normalized.status
    }
  }
}

async function executeGoonSceneCreatorInfo(): Promise<Record<string, any>> {
  return {
    skillId: 'goon-scene-creator',
    command: '/goon-scene-creator',
    portableBundle: 'goon-scene-creator',
    tokenFamily: 'goon-scenes',
    canSaveScenes: false,
    placementModes: ['Ground Level', 'Elevated / Overlook'],
    scenePlacementRule:
      'Choose one scene-wide placement. Do not create mixed half-ground / half-overlook panoramas until Batshit has real transition geometry or masks.',
    groundProjectionRule:
      'Ground Level targets the exact 50% equirectangular equator and reserves the lower region for continuous projectable ground/floor only. Ground Projection Line can correct a global horizon offset but cannot repair upright content in the ground band.',
    currentCapabilities: [
      'Plan Batshit-ready Goon scenes with skyboxes, Room Builder surfaces, props, and sit/lay markers.',
      'Create copy-ready skybox prompts, negative prompts, texture notes, and Scene Editor import steps.',
      'Plan saved Ground Projection Line plus Uploaded GLB Room Shell scale, offset, Y rotation, and Align Floor/manual-Y confirmation.',
      'Plan one saved built-in Scene Atmosphere layer with a supported preset and placement.',
      'Use the bundled Qwen 360 ComfyUI workflow references and assets when ComfyUI is available.'
    ],
    limitations: [
      'Portable agents cannot directly create, update, or save Goon scene records yet.',
      'Animated props, custom ambience sprites, and multiple ambience layers are not current saved-scene behavior.',
      'Scene import still happens through the Scene Editor unless future Goons/Scenes Fabric controls are added.'
    ],
    references: [
      'references/batshit-scene-spec.md',
      'references/skybox-generation.md',
      'references/qwen360-skybox-workflow.md',
      'references/lofi-showcase-aesthetics.md'
    ],
    assets: [
      'assets/comfyui/qwen360-skybox-api-workflow.json',
      'assets/comfyui/qwen360-skybox-ui-workflow.json',
      'assets/comfyui/qwen360-skybox-metadata.json'
    ]
  }
}

async function executeArtifactCreate(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactsService = new ArtifactsService()
    const { userId: _ignoredUserId, ...payload } = input
    const artifact = await artifactsService.create(context.userId, payload)
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact)
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactList(context: ControlExecutionContext): Promise<Record<string, any>> {
  try {
    const artifactsService = new ArtifactsService()
    const artifacts = await artifactsService.listByUser(context.userId)
    return {
      success: true,
      artifactView: 'summary',
      artifacts: artifacts.map((artifact) => buildArtifactLifecycleSummary(artifact)),
      total: artifacts.length
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactGet(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.getAccessible(artifactId, context.userId)
    if (!artifact) {
      return {
        success: false,
        error: 'Artifact not found or access denied.',
        status: 404,
        artifactId
      }
    }
    return {
      success: true,
      artifactView: 'detail',
      artifact: buildArtifactReadPayload(artifact, {
        includeContent: input.includeContent !== false,
        includeVersions: input.includeVersions !== false,
        includeVersionContents: input.includeVersionContents === true
      })
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactRunLogsList(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.getAccessible(artifactId, context.userId)
    if (!artifact) {
      return {
        success: false,
        error: 'Artifact not found or access denied.',
        status: 404,
        artifactId
      }
    }

    const limit = typeof input.limit === 'number' ? input.limit : 20
    const runs = await listArtifactRunLogs({
      userId: context.userId,
      artifactId,
      limit
    })

    return {
      success: true,
      artifactId,
      artifactName: artifact.name,
      runs,
      totalReturned: runs.length,
      retention: 'Recent scrubbed logs are kept for about 14 days. Raw base64, API keys, and auth tokens are never stored.'
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactRunLogsGet(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const runId = toTrimmedString(input.runId)
    if (!runId) {
      return {
        success: false,
        error: 'runId is required.',
        status: 400
      }
    }

    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.getAccessible(artifactId, context.userId)
    if (!artifact) {
      return {
        success: false,
        error: 'Artifact not found or access denied.',
        status: 404,
        artifactId
      }
    }

    const run = await getArtifactRunLog({
      userId: context.userId,
      artifactId,
      runId
    })

    if (!run) {
      return {
        success: false,
        error: 'Artifact run log not found.',
        status: 404,
        artifactId,
        runId
      }
    }

    return {
      success: true,
      artifactId,
      artifactName: artifact.name,
      run,
      retention: 'This log is scrubbed: no API keys, auth tokens, or raw base64 image/audio payloads are stored.'
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactUpdate(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const artifactsService = new ArtifactsService()
    const { artifactId: _artifactId, userId: _ignoredUserId, ...updates } = input
    const previousArtifact =
      typeof updates.content === 'string'
        ? await artifactsService.getOwned(artifactId, context.userId)
        : null
    const updatedFields = Object.entries(updates)
      .filter(([key, value]) => key !== 'sessionId' && key !== 'versionDescription' && value !== undefined)
      .map(([key]) => key)
    const artifact = await artifactsService.update(artifactId, context.userId, updates)
    const diff =
      previousArtifact && previousArtifact.content !== artifact.content
        ? buildCompactEditPreview({
            filePath: 'artifact.html',
            before: previousArtifact.content || '',
            after: artifact.content || ''
          })
        : undefined
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact),
      artifactUpdate: {
        kind: diff
          ? 'content'
          : updatedFields.includes('model_config') || updatedFields.includes('model')
            ? 'model_config'
            : 'settings',
        contentChanged: Boolean(diff),
        updatedFields,
        message: diff
          ? 'Artifact HTML content changed.'
          : `Artifact ${updatedFields.length ? updatedFields.join(', ') : 'settings'} updated.`
      },
      contentChanged: Boolean(diff),
      ...(diff ? { diff } : {})
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactValidateStructure(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactsService = new ArtifactsService()
    const result = await artifactsService.validateStructure(context.userId, {
      artifactId: typeof input.artifactId === 'string' ? input.artifactId : undefined,
      content: typeof input.content === 'string' ? input.content : undefined,
      metadata:
        input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
          ? input.metadata
          : undefined,
      mode: input.mode === 'published' ? 'published' : input.mode === 'edit' ? 'edit' : undefined
    })

    return {
      success: true,
      valid: result.valid,
      canSave: result.canSave,
      canDefer: result.canDefer,
      enforced: result.enforced,
      message: result.message,
      validation: result
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactApplyPatch(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const patch = typeof input.patch === 'string' ? input.patch : ''
    if (patch.length === 0) {
      return {
        success: false,
        error: 'patch is required',
        status: 400
      }
    }

    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.applyPatch(artifactId, context.userId, patch, {
      versionDescription:
        typeof input.versionDescription === 'string' ? input.versionDescription : undefined,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined
    })

    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact)
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactPublish(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const publish = input.publish !== false
    const artifactsService = new ArtifactsService()
    const updates: Record<string, any> = {
      mode: publish ? 'published' : 'edit'
    }
    if ('zone' in input) {
      updates.zone = normalizeArtifactZone(input.zone)
    }
    const artifact = await artifactsService.update(artifactId, context.userId, {
      ...updates
    })
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact),
      published: publish
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactAddVersion(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const content = typeof input.content === 'string' ? input.content : ''
    if (content.length === 0) {
      return {
        success: false,
        error: 'content is required',
        status: 400
      }
    }

    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.addVersion(
      artifactId,
      context.userId,
      content,
      typeof input.description === 'string' ? input.description : undefined
    )
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact)
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactRollback(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const targetVersion = Number(input.targetVersion)
    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
      return {
        success: false,
        error: 'targetVersion must be a positive integer',
        status: 400
      }
    }

    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.rollbackToVersion(artifactId, context.userId, targetVersion)
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact),
      targetVersion
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactDeleteVersion(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const version = Number(input.version)
    if (!Number.isInteger(version) || version < 1) {
      return {
        success: false,
        error: 'version must be a positive integer',
        status: 400
      }
    }

    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.deleteVersion(artifactId, context.userId, version)
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact),
      deletedVersion: version
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactSetWebhook(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const updates: Record<string, any> = {}
    if ('webhook_url' in input) updates.webhook_url = toNullableString(input.webhook_url)
    if ('ai_enabled' in input) updates.ai_enabled = Boolean(input.ai_enabled)
    if ('brain_type' in input) updates.brain_type = input.brain_type
    if (!('webhook_url' in input) && !('ai_enabled' in input) && !('brain_type' in input)) {
      updates.webhook_url = null
    }

    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.update(artifactId, context.userId, updates)
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact)
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactSetZone(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const rawZone = toNullableString(input.zone)
    const normalizedZone = normalizeArtifactZone(rawZone)
    if (rawZone && !normalizedZone) {
      return {
        success: false,
        error: `Invalid zone "${rawZone}".`,
        status: 400
      }
    }
    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.update(artifactId, context.userId, {
      zone: normalizedZone
    })
    return {
      success: true,
      artifactView: 'summary',
      artifact: buildArtifactLifecycleSummary(artifact)
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactUse(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactId = normalizeArtifactId(input.artifactId)
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) {
      return {
        success: false,
        error: 'prompt is required',
        status: 400
      }
    }

    const contextSessionId = resolveContextSessionId(context)
    const requestedSessionId = resolveRequestedSessionId(input)
    const resolvedSessionId = requestedSessionId ?? contextSessionId ?? `artifact:${artifactId}:${context.userId}`
    const completeUrl = resolveArtifactCompleteUrl()
    const token = await resolveInternalBatshitToken(context.userId)
    if (!token) {
      return {
        success: false,
        error: 'BATSHIT_TOKEN is not configured for artifact completion.',
        status: 500
      }
    }

    const response = await fetch(completeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-batshit-token': token
      },
      body: JSON.stringify({
        artifactId,
        prompt,
        context: input.context ?? null,
        mode: typeof input.mode === 'string' && input.mode.trim().length > 0 ? input.mode : 'complete',
        sessionId: resolvedSessionId,
        model: typeof input.model === 'string' ? input.model : null,
        webhookUrl: toNullableString(input.webhook_url),
        userId: context.userId
      }),
      signal: AbortSignal.timeout(120_000)
    })

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return {
        success: false,
        error: `artifact completion failed (${response.status}): ${bodyText || 'no body'}`,
        status: response.status
      }
    }

    const parsed = await parseNdjsonTextResponse(response)
    const generatedFiles = summarizeArtifactGeneratedFiles(parsed.files)
    const autoShare = await maybeAutoShareArtifactFilesToChat({
      context,
      input,
      token,
      artifactId,
      artifactName: null,
      files: parsed.files,
      generatedFiles
    })

    return {
      success: true,
      artifactId,
      transport: parsed.transport,
      text: parsed.text,
      usage: parsed.usage,
      generatedFileCount: generatedFiles.length,
      generatedFiles,
      ...(autoShare ? { autoShare } : {})
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactAnalyzeUrl(
  context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const token = await resolveInternalBatshitToken(context.userId)
    if (!token) {
      return {
        success: false,
        error: 'BATSHIT_TOKEN is not configured for artifact URL analysis.',
        status: 500
      }
    }

    const normalizedHfToken =
      typeof input.hfToken === 'string' && input.hfToken.trim().length > 0
        ? input.hfToken.trim()
        : null
    const normalizedGithubToken =
      typeof input.githubToken === 'string' && input.githubToken.trim().length > 0
        ? input.githubToken.trim()
        : null

    const resolvedHfToken =
      normalizedHfToken ??
      (await apiKeyService
        .retrieve('huggingface', context.userId)
        .then((value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null))
        .catch(() => null))
    const resolvedGithubToken =
      normalizedGithubToken ??
      (await apiKeyService
        .retrieve('github', context.userId)
        .then((value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null))
        .catch(() => null))

    const analyzeUrl = `${resolveBatshitFrontendBaseUrl()}/api/artifacts/analyze`
    const response = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-batshit-service-token': token,
        'x-batshit-user-id': context.userId
      },
      body: JSON.stringify({
        userId: context.userId,
        url: input.url,
        hfToken: resolvedHfToken ?? undefined,
        githubToken: resolvedGithubToken ?? undefined
      }),
      signal: AbortSignal.timeout(30_000)
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      return {
        success: false,
        error:
          payload && typeof payload.error === 'string'
            ? payload.error
            : `artifact analysis failed (${response.status})`,
        status: response.status
      }
    }

    return {
      success: true,
      analysis: payload
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeArtifactCheckRequirements(
  _context: ControlExecutionContext,
  input: Record<string, any>
): Promise<Record<string, any>> {
  const result: Record<string, any> = {
    success: true,
    hasPythonDeps: false,
    hasNodeDeps: false,
    hasDockerfile: false,
    pythonDeps: [],
    nodeDeps: [],
    dockerInfo: null,
    estimatedDependencies: []
  }

  const targetPath = typeof input.path === 'string' ? input.path.trim() : ''
  if (!targetPath) {
    return {
      ...result,
      warning: 'Only local path checks are supported. Provide `path` to inspect dependencies.'
    }
  }

  try {
    const projectRoot = resolveProjectRoot()
    const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(projectRoot, targetPath)

    const requirementsPath = path.join(fullPath, 'requirements.txt')
    if (fs.existsSync(requirementsPath)) {
      result.hasPythonDeps = true
      const content = await fsp.readFile(requirementsPath, 'utf8')
      result.pythonDeps = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => line.split('==')[0].split('>=')[0].split('<=')[0].trim())
      result.estimatedDependencies = [...new Set([...(result.estimatedDependencies as string[]), 'python', 'pip'])]
    }

    const packageJsonPath = path.join(fullPath, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      result.hasNodeDeps = true
      const content = await fsp.readFile(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(content) as {
        dependencies?: Record<string, string>
      }
      result.nodeDeps = Object.keys(packageJson.dependencies ?? {})
      result.estimatedDependencies = [...new Set([...(result.estimatedDependencies as string[]), 'node', 'npm'])]
    }

    const dockerfilePath = path.join(fullPath, 'Dockerfile')
    if (fs.existsSync(dockerfilePath)) {
      result.hasDockerfile = true
      const content = await fsp.readFile(dockerfilePath, 'utf8')
      const fromMatch = content.match(/^FROM\s+([^\s]+)/im)
      result.dockerInfo = {
        baseImage: fromMatch ? fromMatch[1] : null,
        contentPreview: content.slice(0, 500)
      }
      result.estimatedDependencies = [...new Set([...(result.estimatedDependencies as string[]), 'docker'])]
    }

    return result
  } catch (error) {
    const normalized = serializeControlError(error)
    return {
      success: false,
      error: normalized.message,
      status: normalized.status
    }
  }
}

function parseDynamicArtifactId(controlId: string): string | null {
  const match = controlId.match(/^artifact\.([^.]+)\./)
  if (!match) return null
  const artifactId = match[1]?.trim()
  return artifactId ? artifactId : null
}

function normalizeDynamicArtifactAllowlist(artifact: ArtifactRecord): string[] | undefined {
  const direct = Array.isArray(artifact.agent_allowlist) ? artifact.agent_allowlist : null
  const metadata = artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {}
  const fallback =
    (metadata as Record<string, any>).agent_allowlist ??
    (metadata as Record<string, any>).agentAllowlist ??
    (metadata as Record<string, any>).assigned_agent_ids ??
    (metadata as Record<string, any>).assignedAgentIds

  const source = Array.isArray(direct) ? direct : Array.isArray(fallback) ? fallback : []
  const normalized = source
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)

  if (normalized.length === 0) return undefined
  return Array.from(new Set(normalized))
}

function resolveDynamicArtifactAccessScope(artifact: ArtifactRecord): 'all' | 'selected' {
  const direct =
    typeof (artifact as any).agent_access_scope === 'string'
      ? String((artifact as any).agent_access_scope).trim().toLowerCase()
      : ''
  if (direct === 'all' || direct === 'selected') {
    return direct
  }

  const allowlist = normalizeDynamicArtifactAllowlist(artifact)
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    return 'selected'
  }

  if (artifact.agent_use_enabled === true) {
    return 'selected'
  }

  return 'all'
}

function resolveArtifactMetadata(artifact: ArtifactRecord): Record<string, any> {
  return artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {}
}

function resolveArtifactFabricFields(artifact: ArtifactRecord): any[] {
  const metadata = resolveArtifactMetadata(artifact)
  return Array.isArray(metadata.fabric_fields) ? metadata.fabric_fields : []
}

function artifactHasTypedFabricFields(artifact: ArtifactRecord): boolean {
  return resolveArtifactFabricFields(artifact).some(
    (field) => typeof field?.fabricId === 'string' && field.fabricId.trim().length > 0
  )
}

function artifactIsRunOnly(artifact: ArtifactRecord): boolean {
  const metadata = resolveArtifactMetadata(artifact)
  return metadata.run_only === true || metadata.runOnly === true
}

function resolveRunOnlyPrompt(artifact: ArtifactRecord): string {
  const metadata = resolveArtifactMetadata(artifact)
  const candidate =
    (typeof metadata.run_prompt === 'string' && metadata.run_prompt.trim()) ||
    (typeof metadata.runPrompt === 'string' && metadata.runPrompt.trim()) ||
    ''
  return candidate || 'Run this artifact now.'
}

type ArtifactCompletionImageReference = {
  url?: string
  data?: string
  mediaType?: string
  weight?: number
}

type ArtifactTypedCompletionPayload = {
  fieldsForPrompt: Record<string, any>
  images?: ArtifactCompletionImageReference[]
  n?: number
  size?: string
  aspectRatio?: string
  providerOptions?: Record<string, Record<string, any>>
  fieldsApplied: Record<string, any>
  error?: string
}

const IMAGE_COUNT_FIELD_IDS = new Set([
  'n',
  'count',
  'image-count',
  'image-counts',
  'image-number',
  'num-images',
  'number-of-images',
  'output-count',
  'outputs'
])
const ASPECT_RATIO_FIELD_IDS = new Set(['aspect-ratio', 'image-aspect-ratio', 'ratio'])
const IMAGE_SIZE_FIELD_IDS = new Set(['size', 'image-size', 'dimensions'])
const IMAGE_RESOLUTION_FIELD_IDS = new Set(['resolution', 'image-resolution'])

function normalizeFabricSemanticId(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function coerceNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveArtifactConfiguredImageModel(artifact: ArtifactRecord): {
  modelId: string | null
  provider: ReturnType<typeof detectImageModel>['provider']
  isImageModel: boolean
} {
  const normalized = normalizeArtifactModelConfig(
    (artifact as Record<string, any>).model_config ?? null,
    typeof (artifact as Record<string, any>).model === 'string'
      ? String((artifact as Record<string, any>).model)
      : null
  )
  const candidates = [
    normalized.primary?.modelId,
    normalized.mode === 'advanced' ? normalized.visual?.modelId : null,
    typeof (artifact as Record<string, any>).model === 'string'
      ? String((artifact as Record<string, any>).model)
      : null
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)

  const modelId =
    candidates.find((candidate) => detectImageModel(candidate).type !== 'text-only') ??
    candidates[0] ??
    null
  if (!modelId) {
    return { modelId: null, provider: null, isImageModel: false }
  }

  const info = detectImageModel(modelId)
  return {
    modelId,
    provider: info.provider,
    isImageModel: info.type !== 'text-only'
  }
}

function isImageCountField(fieldId: string): boolean {
  return IMAGE_COUNT_FIELD_IDS.has(fieldId)
}

function isAspectRatioField(fieldId: string): boolean {
  return ASPECT_RATIO_FIELD_IDS.has(fieldId)
}

function isImageSizeField(fieldId: string): boolean {
  return IMAGE_SIZE_FIELD_IDS.has(fieldId)
}

function isImageResolutionField(fieldId: string): boolean {
  return IMAGE_RESOLUTION_FIELD_IDS.has(fieldId)
}

function isImageReferenceField(field: Record<string, any> | undefined, fieldId: string): boolean {
  if (
    isImageCountField(fieldId) ||
    isAspectRatioField(fieldId) ||
    isImageSizeField(fieldId) ||
    isImageResolutionField(fieldId)
  ) {
    return false
  }

  const fieldType = normalizeFabricSemanticId(field?.type)
  if (fieldType === 'image' || fieldType === 'image-url' || fieldType === 'image-reference') {
    return true
  }

  if (
    fieldId === 'image' ||
    fieldId === 'image-url' ||
    fieldId === 'source-image' ||
    fieldId === 'source-image-url' ||
    fieldId === 'reference-image' ||
    fieldId === 'reference-image-url' ||
    fieldId === 'input-image' ||
    fieldId === 'input-image-url'
  ) {
    return true
  }

  return (
    /^(source|reference|input)-image-\d+(-url|-data)?$/.test(fieldId) ||
    /^image-\d+(-url|-data)?$/.test(fieldId)
  )
}

function normalizeImageReferenceValue(value: unknown): ArtifactCompletionImageReference | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
      const mediaType = trimmed.slice(5, trimmed.indexOf(';'))
      return { data: trimmed, mediaType }
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return { url: trimmed }
    }
    return null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, any>
  const url = coerceNonEmptyString(record.url ?? record.imageUrl ?? record.image_url)
  if (url && /^https?:\/\//i.test(url)) {
    return {
      url,
      ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
      ...(typeof record.weight === 'number' ? { weight: record.weight } : {})
    }
  }

  const data = coerceNonEmptyString(record.data ?? record.dataUrl ?? record.data_url)
  if (data && /^data:image\/[a-z0-9.+-]+;base64,/i.test(data)) {
    const mediaType = data.slice(5, data.indexOf(';'))
    return {
      data,
      mediaType,
      ...(typeof record.weight === 'number' ? { weight: record.weight } : {})
    }
  }

  const base64 = coerceNonEmptyString(record.base64 ?? record.b64_json)
  const mediaType = coerceNonEmptyString(record.mediaType ?? record.media_type)
  if (base64 && mediaType && /^image\//i.test(mediaType)) {
    return {
      data: base64.startsWith('data:') ? base64 : `data:${mediaType};base64,${base64}`,
      mediaType,
      ...(typeof record.weight === 'number' ? { weight: record.weight } : {})
    }
  }

  return null
}

function summarizeAppliedFieldValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim())) {
      return `[image data URI ${value.length} chars]`
    }
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => summarizeAppliedFieldValue(entry))
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === 'string' &&
      (key === 'data' || key === 'dataUrl' || key === 'data_url' || key === 'base64' || key === 'b64_json') &&
      (/^data:image\/[a-z0-9.+-]+;base64,/i.test(entry.trim()) || entry.length > 512)
    ) {
      result[key] = `[image data ${entry.length} chars]`
      continue
    }
    result[key] = summarizeAppliedFieldValue(entry)
  }
  return result
}

function buildTypedImageCompletionPayload(
  artifact: ArtifactRecord,
  fabricFields: any[],
  fields: Record<string, any>
): ArtifactTypedCompletionPayload {
  const configuredModel = resolveArtifactConfiguredImageModel(artifact)
  const fieldsApplied = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, summarizeAppliedFieldValue(value)])
  )
  if (!configuredModel.isImageModel) {
    return { fieldsForPrompt: fields, fieldsApplied }
  }

  const fieldById = new Map<string, Record<string, any>>()
  for (const field of fabricFields) {
    const id = typeof field?.fabricId === 'string' ? field.fabricId.trim() : ''
    if (id) fieldById.set(id, field)
  }

  const fieldsForPrompt: Record<string, any> = {}
  const images: ArtifactCompletionImageReference[] = []
  const providerOptions: Record<string, Record<string, any>> = {}
  let n: number | undefined
  let size: string | undefined
  let aspectRatio: string | undefined

  for (const [key, value] of Object.entries(fields)) {
    const semanticId = normalizeFabricSemanticId(key)
    const field = fieldById.get(key)

    if (isImageCountField(semanticId)) {
      const parsed = coerceFiniteNumber(value)
      if (parsed === null && coerceNonEmptyString(value) !== null) {
        return {
          fieldsForPrompt,
          fieldsApplied,
          error: `Invalid image count field "${key}". Provide a number.`
        }
      }
      if (parsed !== null) n = parsed
      continue
    }

    if (isAspectRatioField(semanticId)) {
      const parsed = coerceNonEmptyString(value)
      if (parsed && parsed !== 'auto') aspectRatio = parsed
      continue
    }

    if (isImageSizeField(semanticId)) {
      const parsed = coerceNonEmptyString(value)
      if (parsed && parsed !== 'auto') size = parsed
      continue
    }

    if (isImageResolutionField(semanticId)) {
      const parsed = coerceNonEmptyString(value)
      if (parsed && parsed !== 'auto' && configuredModel.provider === 'xai') {
        providerOptions.xai = { ...(providerOptions.xai ?? {}), resolution: parsed }
      }
      continue
    }

    if (isImageReferenceField(field, semanticId)) {
      if (value == null || value === '') continue
      const image = normalizeImageReferenceValue(value)
      if (!image) {
        return {
          fieldsForPrompt,
          fieldsApplied,
          error: `Invalid image reference field "${key}". Provide an http(s) image URL or a data:image/... URI.`
        }
      }
      images.push(image)
      continue
    }

    fieldsForPrompt[key] = value
  }

  return {
    fieldsForPrompt,
    fieldsApplied,
    ...(images.length > 0 ? { images } : {}),
    ...(n !== undefined ? { n } : {}),
    ...(size ? { size } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {})
  }
}

function buildArtifactDynamicScope(artifact: ArtifactRecord): z.infer<typeof controlRegistryScopeSchema> | undefined {
  if (resolveDynamicArtifactAccessScope(artifact) === 'all') return undefined
  const allowlist = normalizeDynamicArtifactAllowlist(artifact)
  if (!allowlist || allowlist.length === 0) return undefined
  return {
    allowedAgentIds: allowlist
  }
}

function buildArtifactDynamicRecords(artifact: ArtifactRecord): ControlRegistryRecord[] {
  const nowIso = new Date().toISOString()
  const artifactId = artifact.id
  const scope = buildArtifactDynamicScope(artifact)
  const zoneCompatibility = normalizeArtifactZoneCompatibility(
    artifact.zone_compatibility ?? null,
    artifact.zone
  )
  const tags = ['artifact', 'dynamic', artifact.slug || artifactId]
  const fabricFields = resolveArtifactFabricFields(artifact)
  const hasTypedFields = artifactHasTypedFabricFields(artifact)
  const runOnly = artifactIsRunOnly(artifact)

  // Agent Use gating — controls whether this artifact appears in the DCM at all.
  // - false → invisible to all agents (no records created)
  // - true + empty allowlist → invisible to all agents (enabled but no agents selected)
  // - true + allowlist → visible only to allowed agents (all records scoped)
  // - undefined (legacy) → visible to all agents (no scope)
  // User-only panel runtimes (Gradio/HuggingFace embeds and ComfyUI panel
  // artifacts with no Batshit completion runtime) never become agent tools,
  // even if stale settings say yes.
  if (!isArtifactAgentUseEligible(artifact)) {
    return []
  }
  if (artifact.agent_use_enabled === false) {
    return []
  }
  if (resolveDynamicArtifactAccessScope(artifact) === 'selected') {
    const allowlist = normalizeDynamicArtifactAllowlist(artifact)
    if (!allowlist || allowlist.length === 0) return []
  }
  // Runtime contract for published artifacts:
  // if Agent Use is on, runtime execution must be schema-driven (fabric_fields)
  // or explicitly run-only (metadata.run_only=true).
  if (artifact.mode === 'published' && !hasTypedFields && !runOnly) {
    return []
  }

  const createRecord = (options: {
    suffix: string
    title: string
    description: string
    schemaHint: string
    riskLevel: ControlRiskLevel
    inputSchema: Record<string, any>
    handlerId: string
  }): ControlRegistryRecord => ({
    controlId: `artifact.${artifactId}.${options.suffix}`,
    sourceType: 'artifact',
    executorType: 'internal_handler',
    title: options.title,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: null,
    schemaHint: options.schemaHint,
    riskLevel: options.riskLevel,
    status: 'published',
    tags,
    ...(scope ? { scope } : {}),
    executorConfig: {
      handlerId: options.handlerId,
      artifactId
    },
    version: 1,
    createdAt: artifact.created_at || nowIso,
    updatedAt: artifact.updated_at || nowIso,
    createdBy: artifact.user_id,
    updatedBy: artifact.user_id,
    origin: 'system'
  })

  const records: ControlRegistryRecord[] = [
    createRecord({
      suffix: 'field.model.set',
      title: `${artifact.name}: set model`,
      description: 'Set or clear the AI model selected for this artifact. Prefer sys.model_catalog.search first, then pass the chosen result modelIdForArtifact. This stores a manual artifact model, not a saved preset. Pass null or omit to clear the selection; built-in AI calls then fail with a model-required error until a model is selected.',
      schemaHint: 'model: exact current model ID string, or null to clear the artifact model selection',
      riskLevel: 'safe',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'The exact current model ID to use.' },
          value: { type: 'string', description: 'Alternative field name for the model ID' }
        },
        additionalProperties: true
      },
      handlerId: 'artifact.field.model.set'
    }),
    createRecord({
      suffix: 'field.system_prompt.set',
      title: `${artifact.name}: set system prompt`,
      description: 'Set or clear this artifact system prompt.',
      schemaHint: 'system_prompt (string|null)',
      riskLevel: 'confirm',
      inputSchema: {
        type: 'object',
        properties: {
          system_prompt: { type: 'string' },
          value: { type: 'string' }
        },
        additionalProperties: true
      },
      handlerId: 'artifact.field.system_prompt.set'
    }),
    createRecord({
      suffix: 'field.zone.set',
      title: `${artifact.name}: set zone`,
      description: 'Set this artifact zone while honoring compatibility rules.',
      schemaHint: 'zone required (header/panel/trigger)',
      riskLevel: 'confirm',
      inputSchema: {
        type: 'object',
        properties: {
          zone: { type: 'string', enum: ['header', 'panel', 'trigger'] }
        },
        additionalProperties: true
      },
      handlerId: 'artifact.field.zone.set'
    }),
    createRecord({
      suffix: 'field.details.get',
      title: `${artifact.name}: get details`,
      description: 'Fetch artifact details and publish readiness.',
      schemaHint: 'no input',
      riskLevel: 'safe',
      inputSchema: {
        type: 'object',
        additionalProperties: true
      },
      handlerId: 'artifact.field.details.get'
    }),
    createRecord({
      suffix: 'action.publish.run',
      title: `${artifact.name}: publish`,
      description: 'Publish artifact (zone required and validated).',
      schemaHint: 'zone optional (uses current zone by default)',
      riskLevel: 'confirm',
      inputSchema: {
        type: 'object',
        properties: {
          zone: { type: 'string', enum: ['header', 'panel', 'trigger'] }
        },
        additionalProperties: true
      },
      handlerId: 'artifact.action.publish.run'
    }),
    createRecord({
      suffix: 'action.unpublish.run',
      title: `${artifact.name}: unpublish`,
      description: 'Move artifact back to draft mode.',
      schemaHint: 'no input',
      riskLevel: 'confirm',
      inputSchema: {
        type: 'object',
        additionalProperties: true
      },
      handlerId: 'artifact.action.unpublish.run'
    }),
    createRecord({
      suffix: 'action.run.run',
      title: `${artifact.name}: run`,
      description: 'Execute this artifact with a prompt.',
      schemaHint: 'prompt required',
      riskLevel: 'safe',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          mode: { type: 'string' }
        },
        required: ['prompt'],
        additionalProperties: true
      },
      handlerId: 'artifact.action.run.run'
    }),
    createRecord({
      suffix: 'action.publish_status.get',
      title: `${artifact.name}: publish status`,
      description: 'Get zone compatibility and publish readiness.',
      schemaHint: 'no input',
      riskLevel: 'safe',
      inputSchema: {
        type: 'object',
        additionalProperties: true
      },
      handlerId: 'artifact.action.publish_status.get'
    })
  ]

  // Per-artifact runtime capability:
  // - typed invoke when fabric_fields exist
  // - run-only invoke when metadata.run_only=true
  if (artifact.mode === 'published' && artifact.slug && (hasTypedFields || runOnly)) {
    // Build input schema from fabric_fields
    const fieldProperties: Record<string, any> = {}
    for (const field of fabricFields) {
      if (!field.fabricId || typeof field.fabricId !== 'string') continue
      const prop: Record<string, any> = {}
      switch (field.type) {
        case 'number':
        case 'slider':
          prop.type = 'number'
          if (field.min != null) prop.minimum = field.min
          if (field.max != null) prop.maximum = field.max
          break
        case 'checkbox':
        case 'toggle':
          prop.type = 'boolean'
          break
        case 'select':
        case 'radio':
          prop.type = 'string'
          if (Array.isArray(field.options) && field.options.length > 0) {
            prop.enum = field.options
          }
          break
        case 'multiselect':
          prop.type = 'array'
          prop.items = { type: 'string' }
          if (Array.isArray(field.options) && field.options.length > 0) {
            prop.items.enum = field.options
          }
          break
        case 'promptPair':
          prop.type = 'object'
          prop.properties = {
            prompt: { type: 'string' },
            negativePrompt: { type: 'string' }
          }
          break
        default:
          prop.type = 'string'
          break
      }
      if (field.label) prop.description = field.label
      fieldProperties[field.fabricId] = prop
    }
    // Always allow an optional prompt override unless the artifact already exposes
    // `prompt` as a real Fabric field.
    if (!Object.prototype.hasOwnProperty.call(fieldProperties, 'prompt')) {
      fieldProperties.prompt = { type: 'string', description: 'Optional AI prompt override for this run.' }
    }
    if (runOnly) {
      fieldProperties.mode = { type: 'string' }
    }

    const typedRecord = createRecord({
      suffix: 'typed.invoke',
      title: artifact.name,
      description: runOnly
        ? `${artifact.description || artifact.name} — invoke run-only artifact trigger.`
        : `${artifact.description || artifact.name} — invoke with typed field parameters.`,
      schemaHint: hasTypedFields
        ? fabricFields
            .filter((field: any) => typeof field?.fabricId === 'string' && field.fabricId.trim().length > 0)
            .map((f: any) => `${f.fabricId} (${f.type})`)
            .join(', ')
        : 'run-only trigger (no input fields)',
      riskLevel: 'safe',
      inputSchema: {
        type: 'object',
        properties: fieldProperties,
        additionalProperties: false,
        ...(runOnly ? {} : { minProperties: 1 })
      },
      handlerId: 'artifact.typed.invoke'
    })
    records.push(typedRecord)

    // Add an alias control with use.artifact.{slug} as the controlId
    records.push({
      ...typedRecord,
      controlId: `use.artifact.${artifact.slug}`,
      tags: runOnly ? [...tags, 'run-only', 'typed-invoke'] : [...tags, 'fabric-fields', 'typed-invoke']
    })
  }

  return records.map((record) => ({
    ...record,
    executorConfig: {
      ...(record.executorConfig || {}),
      zoneCompatibility
    }
  }))
}

async function readControlRegistryStore(userId: string): Promise<ControlRegistryStore> {
  const key = buildControlRegistryKey(userId)
  try {
    const raw = await redis.execute(async (client) => {
      return (await client.json.get(key)) as ControlRegistryStore | null
    })
    if (!raw) {
      return {
        version: CONTROL_REGISTRY_SCHEMA_VERSION,
        records: []
      }
    }
    const parsed = controlRegistryStoreSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn('[ControlRegistry] Invalid dynamic registry payload. Resetting store.', parsed.error.flatten())
      return {
        version: CONTROL_REGISTRY_SCHEMA_VERSION,
        records: []
      }
    }
    return parsed.data
  } catch (error) {
    console.warn('[ControlRegistry] Failed to read dynamic registry store:', error)
    return {
      version: CONTROL_REGISTRY_SCHEMA_VERSION,
      records: []
    }
  }
}

async function writeControlRegistryStore(userId: string, store: ControlRegistryStore): Promise<void> {
  const key = buildControlRegistryKey(userId)
  await redis.execute(async (client) => {
    await client.json.set(key, '$', store as any)
  })
}

function stableRecordSignature(records: ControlRegistryRecord[]): string {
  const sorted = [...records].sort((left, right) => left.controlId.localeCompare(right.controlId))
  return JSON.stringify(sorted)
}

function buildArtifactControlManifest(records: ControlRegistryRecord[], generatedAt: string) {
  const controlIds = records.map((record) => record.controlId).sort((left, right) => left.localeCompare(right))
  return {
    version: 1,
    controlIds,
    generated_at: generatedAt
  }
}

function normalizeControlManifestForCompare(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const controlIds = Array.isArray(source.controlIds)
    ? source.controlIds
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
    : []
  const version = typeof source.version === 'number' ? source.version : 1
  return {
    version,
    controlIds
  }
}

async function syncArtifactControlManifests(options: {
  artifacts: ArtifactRecord[]
  generatedByArtifactId: Map<string, ControlRegistryRecord[]>
}): Promise<void> {
  const generatedAt = new Date().toISOString()
  const writes: Array<{ artifactId: string; manifest: ReturnType<typeof buildArtifactControlManifest> }> = []

  for (const artifact of options.artifacts) {
    const records = options.generatedByArtifactId.get(artifact.id) ?? []
    const nextManifest = buildArtifactControlManifest(records, generatedAt)
    const currentManifest = normalizeControlManifestForCompare(artifact.control_manifest)
    const nextComparable = normalizeControlManifestForCompare(nextManifest)

    if (
      currentManifest &&
      nextComparable &&
      currentManifest.version === nextComparable.version &&
      JSON.stringify(currentManifest.controlIds) === JSON.stringify(nextComparable.controlIds)
    ) {
      continue
    }

    writes.push({
      artifactId: artifact.id,
      manifest: nextManifest
    })
  }

  if (writes.length === 0) return

  await redis.execute(async (client) => {
    for (const entry of writes) {
      try {
        await client.json.set(`artifact:${entry.artifactId}`, '$.control_manifest', entry.manifest as any)
      } catch (error) {
        console.warn(
          `[ControlRegistry] Failed to sync control manifest for artifact ${entry.artifactId}:`,
          error
        )
      }
    }
  })
}

async function syncDynamicRegistryRecords(userId: string): Promise<ControlRegistryRecord[]> {
  const store = await readControlRegistryStore(userId)
  const artifactsService = new ArtifactsService()
  const artifacts = await artifactsService.listByUser(userId)
  const generatedByArtifactId = new Map<string, ControlRegistryRecord[]>()
  const generated = artifacts.flatMap((artifact) => {
    const records = buildArtifactDynamicRecords(artifact)
    generatedByArtifactId.set(artifact.id, records)
    return records
  })

  await syncArtifactControlManifests({
    artifacts,
    generatedByArtifactId
  })

  const preserved = store.records.filter((record) => {
    if (record.sourceType !== 'artifact') return true
    if (record.controlId.startsWith(DYNAMIC_ARTIFACT_CONTROL_PREFIX)) return false
    if (record.controlId.startsWith('sys.artifact.') || record.controlId.startsWith('use.artifact.')) return false
    return true
  })
  const merged = [...preserved, ...generated]
  const nextStore: ControlRegistryStore = {
    version: CONTROL_REGISTRY_SCHEMA_VERSION,
    records: merged
  }

  if (stableRecordSignature(store.records) !== stableRecordSignature(nextStore.records)) {
    await writeControlRegistryStore(userId, nextStore)
  }

  return nextStore.records
}

async function executeDynamicArtifactModelSelection(
  context: ControlExecutionContext,
  artifactId: string,
  input: Record<string, any>
): Promise<Record<string, any>> {
  const selectedModel = toNullableString(input.model ?? input.value)
  const artifactsService = new ArtifactsService()
  const artifact = await artifactsService.update(artifactId, context.userId, {
    model: null,
    model_config: normalizeArtifactModelConfig(null, selectedModel)
  })
  return {
    success: true,
    artifact,
    model: selectedModel
  }
}

async function executeDynamicArtifactSystemPrompt(
  context: ControlExecutionContext,
  artifactId: string,
  input: Record<string, any>
): Promise<Record<string, any>> {
  const nextPrompt = toNullableString(input.system_prompt ?? input.prompt ?? input.value)
  const artifactsService = new ArtifactsService()
  const artifact = await artifactsService.update(artifactId, context.userId, {
    system_prompt: nextPrompt,
    custom_prompt: nextPrompt
  })
  return {
    success: true,
    artifact
  }
}

async function executeDynamicArtifactZoneSet(
  context: ControlExecutionContext,
  artifactId: string,
  input: Record<string, any>
): Promise<Record<string, any>> {
  const rawZone = resolveDynamicArtifactZoneInput(input)
  if (!rawZone) {
    return {
      success: false,
      error: 'Zone is required. Provide one of: header, panel, trigger.',
      status: 400,
      accepted_input: {
        keys: DYNAMIC_ARTIFACT_ZONE_INPUT_KEYS,
        example: { zone: 'panel' }
      }
    }
  }

  const zone = normalizeArtifactZone(rawZone)
  if (!zone) {
    return {
      success: false,
      error: `Invalid zone "${rawZone}".`,
      status: 400
    }
  }

  const artifactsService = new ArtifactsService()
  const artifact = await artifactsService.update(artifactId, context.userId, {
    zone
  })

  const persistedZone = normalizeArtifactZone((artifact as Record<string, any>).zone)
  if (persistedZone !== zone) {
    return {
      success: false,
      error: `Zone update did not persist (requested "${zone}", found "${String((artifact as Record<string, any>).zone ?? 'null')}").`,
      status: 500,
      artifact
    }
  }

  const zoneCompatibility = normalizeArtifactZoneCompatibility(
    (artifact as Record<string, any>).zone_compatibility ?? null,
    persistedZone
  )
  const publishEvaluation = evaluateArtifactZonePublish(zoneCompatibility, persistedZone)

  return {
    success: true,
    artifact: {
      ...artifact,
      zone: persistedZone,
      zone_compatibility: zoneCompatibility
    },
    publish_ready: publishEvaluation.ok,
    publish_reason: publishEvaluation.reason,
    publish_recommendations: publishEvaluation.recommendedZones
  }
}

async function executeDynamicArtifactDetails(
  context: ControlExecutionContext,
  artifactId: string
): Promise<Record<string, any>> {
  const artifactsService = new ArtifactsService()
  const artifact = await artifactsService.getAccessible(artifactId, context.userId)
  if (!artifact) {
    return {
      success: false,
      error: 'Artifact not found or access denied.',
      status: 404
    }
  }

  const zoneCompatibility = normalizeArtifactZoneCompatibility(
    artifact.zone_compatibility ?? null,
    artifact.zone
  )
  const publishEvaluation = evaluateArtifactZonePublish(zoneCompatibility, artifact.zone)

  return {
    success: true,
    artifact: {
      id: artifact.id,
      name: artifact.name,
      slug: artifact.slug,
      mode: artifact.mode,
      zone: artifact.zone,
      brain_type: artifact.brain_type,
      model_config: artifact.model_config,
      system_prompt: artifact.system_prompt ?? artifact.custom_prompt ?? null,
      zone_compatibility: zoneCompatibility,
      agent_use_enabled: artifact.agent_use_enabled !== false,
      agent_access_scope: resolveDynamicArtifactAccessScope(artifact),
      agent_allowlist: normalizeDynamicArtifactAllowlist(artifact) ?? []
    },
    publish_ready: publishEvaluation.ok,
    publish_reason: publishEvaluation.reason,
    publish_recommendations: publishEvaluation.recommendedZones
  }
}

async function executeDynamicArtifactPublishAction(
  context: ControlExecutionContext,
  artifactId: string,
  input: Record<string, any>,
  publish: boolean
): Promise<Record<string, any>> {
  const rawZone = resolveDynamicArtifactZoneInput(input)
  const zone = normalizeArtifactZone(rawZone)
  if (rawZone && !zone) {
    return {
      success: false,
      error: `Invalid zone "${rawZone}".`,
      status: 400
    }
  }
  const artifactsService = new ArtifactsService()
  const current = await artifactsService.getAccessible(artifactId, context.userId)
  if (!current) {
    return {
      success: false,
      error: 'Artifact not found or access denied.',
      status: 404
    }
  }

  const currentZone = normalizeArtifactZone((current as Record<string, any>).zone)
  const effectiveZone = zone ?? currentZone
  if (publish && !effectiveZone) {
    return {
      success: false,
      error: 'Publish requires a zone selection. Provide one of: header, panel, trigger.',
      status: 400,
      accepted_input: {
        keys: DYNAMIC_ARTIFACT_ZONE_INPUT_KEYS,
        example: { zone: 'panel' }
      }
    }
  }

  if (publish && effectiveZone) {
    const compatibility = normalizeArtifactZoneCompatibility(
      (current as Record<string, any>).zone_compatibility ?? null,
      effectiveZone
    )
    const evaluation = evaluateArtifactZonePublish(compatibility, effectiveZone)
    if (!evaluation.ok) {
      return {
        success: false,
        error: evaluation.reason ?? 'Artifact is not ready to publish.',
        status: 400,
        publish_ready: false,
        publish_reason: evaluation.reason,
        publish_recommendations: evaluation.recommendedZones,
        publish_error: buildArtifactZonePublishError(evaluation),
        zone: effectiveZone,
        zone_compatibility: compatibility
      }
    }
  }

  const artifact = await artifactsService.update(artifactId, context.userId, {
    mode: publish ? 'published' : 'edit',
    ...(effectiveZone ? { zone: effectiveZone } : {})
  })
  const persistedZone = normalizeArtifactZone((artifact as Record<string, any>).zone)
  if (publish && persistedZone !== effectiveZone) {
    return {
      success: false,
      error: `Publish zone did not persist (requested "${String(effectiveZone)}", found "${String((artifact as Record<string, any>).zone ?? 'null')}").`,
      status: 500,
      artifact
    }
  }
  return {
    success: true,
    artifact,
    published: publish,
    zone: persistedZone
  }
}

async function executeDynamicArtifactRunAction(
  context: ControlExecutionContext,
  artifactId: string,
  input: Record<string, any>
): Promise<Record<string, any>> {
  return await executeArtifactUse(context, {
    artifactId,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    context: input.context,
    mode: input.mode,
    sessionId: input.sessionId,
    model: input.model,
    webhook_url: input.webhook_url
  })
}

// SA-042: Typed invoke handler — accepts typed field parameters and passes them to the completion endpoint
async function executeDynamicArtifactTypedInvoke(
  context: ControlExecutionContext,
  artifactId: string,
  input: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.getAccessible(artifactId, context.userId)
    if (!artifact) {
      return {
        success: false,
        error: 'Artifact not found or access denied.',
        status: 404
      }
    }

    const fabricFields = resolveArtifactFabricFields(artifact)
    const hasTypedFields = artifactHasTypedFabricFields(artifact)
    const runOnly = artifactIsRunOnly(artifact)
    if (!hasTypedFields && !runOnly) {
      return {
        success: false,
        error: 'Artifact runtime contract is missing. Add metadata.fabric_fields or set metadata.run_only=true.',
        status: 400
      }
    }

    // Extract fields from input (everything except reserved control keys)
    const reservedKeys = new Set([
      'prompt',
      'mode',
      'context',
      'sessionId',
      'model',
      'webhook_url',
      'artifactId',
      'shareToChat',
      'share_to_chat',
      'artifactName',
      'artifact_name'
    ])
    const fieldIds = new Set(
      fabricFields
        .map((f: any) => (typeof f?.fabricId === 'string' ? f.fabricId.trim() : ''))
        .filter(Boolean)
    )
    const fields: Record<string, any> = {}
    for (const key of Object.keys(input)) {
      if (fieldIds.has(key) && (!reservedKeys.has(key) || key === 'prompt')) {
        fields[key] = input[key]
      }
    }
    const typedPayload = buildTypedImageCompletionPayload(artifact, fabricFields, fields)
    if (typedPayload.error) {
      return {
        success: false,
        error: typedPayload.error,
        status: 400
      }
    }

    // Build the completion payload
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const resolvedPrompt =
      prompt ||
      (runOnly ? resolveRunOnlyPrompt(artifact) : `Execute with fields: ${JSON.stringify(fields)}`)
    const contextSessionId = resolveContextSessionId(context)
    const requestedSessionId = resolveRequestedSessionId(input)
    const resolvedSessionId = requestedSessionId ?? contextSessionId ?? `artifact:${artifactId}:${context.userId}`

    const completeUrl = resolveArtifactCompleteUrl()
    const token = await resolveInternalBatshitToken(context.userId)
    if (!token) {
      return {
        success: false,
        error: 'BATSHIT_TOKEN is not configured for artifact completion.',
        status: 500
      }
    }

    const response = await fetch(completeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-batshit-token': token
      },
      body: JSON.stringify({
        artifactId,
        prompt: resolvedPrompt,
        context: input.context ?? null,
        mode: typeof input.mode === 'string' && input.mode.trim().length > 0 ? input.mode : 'complete',
        sessionId: resolvedSessionId,
        model: typeof input.model === 'string' ? input.model : null,
        webhookUrl: toNullableString(input.webhook_url),
        userId: context.userId,
        fields: typedPayload.fieldsForPrompt,
        ...(typedPayload.images ? { images: typedPayload.images } : {}),
        ...(typedPayload.n !== undefined ? { n: typedPayload.n } : {}),
        ...(typedPayload.size ? { size: typedPayload.size } : {}),
        ...(typedPayload.aspectRatio ? { aspectRatio: typedPayload.aspectRatio } : {}),
        ...(typedPayload.providerOptions ? { providerOptions: typedPayload.providerOptions } : {})
      }),
      signal: AbortSignal.timeout(120_000)
    })

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return {
        success: false,
        error: `artifact completion failed (${response.status}): ${bodyText || 'no body'}`,
        status: response.status
      }
    }

    const parsed = await parseNdjsonTextResponse(response)
    const generatedFiles = summarizeArtifactGeneratedFiles(parsed.files)
    const autoShare = await maybeAutoShareArtifactFilesToChat({
      context,
      input,
      token,
      artifactId,
      artifactName: artifact.name,
      files: parsed.files,
      generatedFiles
    })

    return {
      success: true,
      artifactId,
      slug: artifact.slug,
      transport: parsed.transport,
      text: parsed.text,
      usage: parsed.usage,
      generatedFileCount: generatedFiles.length,
      generatedFiles,
      ...(autoShare ? { autoShare } : {}),
      ...(runOnly ? { runOnly: true } : {}),
      fieldsApplied: typedPayload.fieldsApplied
    }
  } catch (error) {
    return toArtifactExecutionError(error)
  }
}

async function executeDynamicArtifactPublishStatus(
  context: ControlExecutionContext,
  artifactId: string
): Promise<Record<string, any>> {
  const artifactsService = new ArtifactsService()
  const artifact = await artifactsService.getAccessible(artifactId, context.userId)
  if (!artifact) {
    return {
      success: false,
      error: 'Artifact not found or access denied.',
      status: 404
    }
  }

  const zoneCompatibility = normalizeArtifactZoneCompatibility(
    artifact.zone_compatibility ?? null,
    artifact.zone
  )
  const evaluation = evaluateArtifactZonePublish(zoneCompatibility, artifact.zone)

  return {
    success: true,
    mode: artifact.mode,
    zone: artifact.zone,
    zone_compatibility: zoneCompatibility,
    publish_ready: evaluation.ok,
    publish_reason: evaluation.reason,
    publish_recommendations: evaluation.recommendedZones,
    ...(evaluation.ok ? {} : { publish_error: buildArtifactZonePublishError(evaluation) })
  }
}

async function executeDynamicArtifactHandler(
  context: ControlExecutionContext,
  record: ControlRegistryRecord,
  input: Record<string, any>
): Promise<Record<string, any>> {
  const artifactId =
    toTrimmedString(record.executorConfig?.artifactId) || parseDynamicArtifactId(record.controlId)
  if (!artifactId) {
    return {
      success: false,
      error: 'Dynamic artifact control is missing artifactId mapping.',
      status: 500
    }
  }

  const handlerId = toTrimmedString(record.executorConfig?.handlerId)
  switch (handlerId) {
    case 'artifact.field.model.set':
      return await executeDynamicArtifactModelSelection(context, artifactId, input)
    case 'artifact.field.system_prompt.set':
      return await executeDynamicArtifactSystemPrompt(context, artifactId, input)
    case 'artifact.field.zone.set':
      return await executeDynamicArtifactZoneSet(context, artifactId, input)
    case 'artifact.field.details.get':
      return await executeDynamicArtifactDetails(context, artifactId)
    case 'artifact.action.publish.run':
      return await executeDynamicArtifactPublishAction(context, artifactId, input, true)
    case 'artifact.action.unpublish.run':
      return await executeDynamicArtifactPublishAction(context, artifactId, input, false)
    case 'artifact.action.run.run':
      return await executeDynamicArtifactRunAction(context, artifactId, input)
    case 'artifact.action.publish_status.get':
      return await executeDynamicArtifactPublishStatus(context, artifactId)
    case 'artifact.typed.invoke':
      return await executeDynamicArtifactTypedInvoke(context, artifactId, input)
    default:
      return {
        success: false,
        error: `Unknown dynamic control handler "${handlerId || 'unset'}".`,
        status: 400
      }
  }
}

function dynamicRecordToDefinition(record: ControlRegistryRecord): ControlDefinition {
  return {
    controlId: record.controlId,
    sourceType: record.sourceType,
    executorType: record.executorType,
    title: record.title,
    description: record.description,
    inputSchema: z.object({}).passthrough(),
    inputSchemaJson: record.inputSchema,
    outputSchema: record.outputSchema ?? null,
    schemaHint: record.schemaHint,
    riskLevel: record.riskLevel,
    status: record.status,
    tags: record.tags,
    scope: record.scope,
    executorConfig: record.executorConfig,
    origin: record.origin,
    handler: async (context, input) => await executeDynamicArtifactHandler(context, record, input)
  }
}

async function loadControlDefinitionsForUser(userId?: string | null): Promise<ControlDefinition[]> {
  if (!userId) return CONTROL_DEFINITIONS
  const records = await syncDynamicRegistryRecords(userId)
  const staticIds = new Set(CONTROL_DEFINITIONS.map((definition) => definition.controlId))
  const dynamic = records
    .map((record) => dynamicRecordToDefinition(record))
    .filter((definition) => !staticIds.has(definition.controlId))
  return [...CONTROL_DEFINITIONS, ...dynamic]
}

function normalizeControlIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  if (normalized.length === 0) return []
  return Array.from(new Set(normalized))
}

function controlIdMatchesAllowedEntries(controlId: string, allowedEntries: string[]): boolean {
  return allowedEntries.some((entry) => {
    if (entry === controlId) return true
    if (entry.endsWith('*')) {
      const prefix = entry.slice(0, -1)
      return prefix.length > 0 && controlId.startsWith(prefix)
    }
    return false
  })
}

function resolveDynamicArtifactAliasControl(options: {
  requestedControlId: string
  inputPayload: Record<string, any>
  controls: ControlDefinition[]
  agentId?: string | null
  runtimeMode?: ControlRuntimeMode | null
  allowedControlIds?: string[] | undefined
}):
  | { kind: 'none' }
  | { kind: 'resolved'; control: ControlDefinition }
  | { kind: 'ambiguous'; candidates: string[] } {
  const requested = options.requestedControlId.trim()
  if (!requested) return { kind: 'none' }
  if (requested.startsWith('sys.') || requested.startsWith('use.') || requested.startsWith('artifact.')) return { kind: 'none' }

  const suffix = `.${requested}`
  let candidates = options.controls.filter(
    (definition) =>
      definition.controlId.startsWith(DYNAMIC_ARTIFACT_CONTROL_PREFIX) &&
      definition.controlId.endsWith(suffix)
  )
  if (candidates.length === 0) return { kind: 'none' }

  if (Array.isArray(options.allowedControlIds)) {
    candidates = candidates.filter((definition) =>
      controlIdMatchesAllowedEntries(definition.controlId, options.allowedControlIds as string[])
    )
  }
  if (candidates.length === 0) return { kind: 'none' }

  candidates = candidates.filter((definition) =>
    isControlVisibleForContext(definition, {
      agentId: options.agentId ?? null,
      runtimeMode: options.runtimeMode ?? null,
      forFind: false
    })
  )
  if (candidates.length === 0) return { kind: 'none' }

  const explicitArtifactId = toNullableString(options.inputPayload.artifactId)
  if (explicitArtifactId) {
    const narrowed = candidates.filter((definition) =>
      definition.controlId.startsWith(`${DYNAMIC_ARTIFACT_CONTROL_PREFIX}${explicitArtifactId}.`)
    )
    if (narrowed.length === 1) {
      return { kind: 'resolved', control: narrowed[0] }
    }
    if (narrowed.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: narrowed.map((definition) => definition.controlId).sort((left, right) =>
          left.localeCompare(right)
        )
      }
    }
  }

  if (candidates.length === 1) {
    return { kind: 'resolved', control: candidates[0] }
  }

  return {
    kind: 'ambiguous',
    candidates: candidates.map((definition) => definition.controlId).sort((left, right) =>
      left.localeCompare(right)
    )
  }
}

function isControlVisibleForContext(
  definition: ControlDefinition,
  options: {
    agentId?: string | null
    runtimeMode?: ControlRuntimeMode | null
    forFind: boolean
  }
): boolean {
  const scope = definition.scope
  if (!scope) return true
  if (options.forFind && scope.hiddenFromFind) return false

  const agentId = options.agentId?.trim() || null
  if (Array.isArray(scope.blockedAgentIds) && scope.blockedAgentIds.length > 0 && agentId) {
    if (scope.blockedAgentIds.includes(agentId)) return false
  }

  if (Array.isArray(scope.allowedAgentIds) && scope.allowedAgentIds.length > 0) {
    if (!agentId) return false
    if (!scope.allowedAgentIds.includes(agentId)) return false
  }

  if (Array.isArray(scope.modeAllowList) && scope.modeAllowList.length > 0 && options.runtimeMode) {
    if (!scope.modeAllowList.includes(options.runtimeMode)) return false
  }

  return true
}

function matchesTagFilter(controlTags: string[], filterTags: string[]): boolean {
  if (filterTags.length === 0) return true
  const set = new Set(controlTags.map((tag) => tag.toLowerCase()))
  return filterTags.every((tag) => set.has(tag))
}

function buildControlQueryTokens(query: string): string[] {
  if (!query) return []

  const unique = new Set<string>()
  const addToken = (value: string) => {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return
    unique.add(trimmed)
  }

  const rawTokens = query.split(/\s+/).filter((token) => token.length > 0)
  for (const token of rawTokens) {
    addToken(token)
    for (const part of token.split(/[^a-z0-9]+/i)) {
      addToken(part)
    }
  }

  return Array.from(unique)
}

function scoreControlForQuery(options: {
  definition: ControlDefinition
  query: string
  queryTokens: string[]
}): { matched: boolean; score: number } {
  const { definition, query, queryTokens } = options
  if (queryTokens.length === 0) return { matched: true, score: 0 }

  const controlId = definition.controlId.toLowerCase()
  const title = definition.title.toLowerCase()
  const description = definition.description.toLowerCase()
  const tags = definition.tags.map((tag) => tag.toLowerCase())

  let score = 0
  let coverage = 0

  for (const token of queryTokens) {
    if (!token) continue
    let tokenMatched = false

    if (controlId === token) {
      score += 80
      tokenMatched = true
    } else if (controlId.startsWith(token)) {
      score += 55
      tokenMatched = true
    } else if (controlId.includes(token)) {
      score += 35
      tokenMatched = true
    }

    if (title === token) {
      score += 60
      tokenMatched = true
    } else if (title.startsWith(token)) {
      score += 40
      tokenMatched = true
    } else if (title.includes(token)) {
      score += 24
      tokenMatched = true
    }

    if (tags.some((tag) => tag === token)) {
      score += 28
      tokenMatched = true
    } else if (tags.some((tag) => tag.includes(token))) {
      score += 16
      tokenMatched = true
    }

    if (description.includes(token)) {
      score += 10
      tokenMatched = true
    }

    if (tokenMatched) coverage += 1
  }

  if (coverage === 0) return { matched: false, score: 0 }

  score += coverage * 100

  if (query.length > 0) {
    if (controlId.includes(query)) score += 60
    if (title.includes(query)) score += 40
    if (description.includes(query)) score += 20
  }

  if (queryTokens.includes('artifact')) {
    if (definition.controlId.startsWith('use.artifact.')) score += 24
    if (definition.controlId.startsWith('sys.artifact.')) score += 16
  }
  if (queryTokens.includes('use') && definition.controlId.startsWith('use.artifact.')) {
    score += 28
  }

  return { matched: true, score }
}

function isArtifactUseIntent(queryTokens: string[]): boolean {
  return queryTokens.includes('artifact') && queryTokens.includes('use')
}

function normalizeControlListFilter<T extends string>(value: T | T[] | undefined): Set<T> | null {
  if (!value) return null
  if (Array.isArray(value)) return new Set(value)
  return new Set([value])
}

async function resolveVisibleControls(options: {
  userId?: string | null
  agentId?: string | null
  runtimeMode?: ControlRuntimeMode | null
  includeDraft: boolean
  allowedControlIds?: string[]
}): Promise<ControlDefinition[]> {
  const allowedIds = normalizeControlIdList(options.allowedControlIds)
  const allowedSet = Array.isArray(allowedIds) ? new Set(allowedIds) : null
  const controls = await loadControlDefinitionsForUser(options.userId)

  return controls.filter((definition) => {
    if (!options.includeDraft && definition.status !== 'published') return false
    if (
      allowedSet &&
      !controlIdMatchesAllowedEntries(definition.controlId, Array.from(allowedSet))
    ) {
      return false
    }
    if (
      !isControlVisibleForContext(definition, {
        agentId: options.agentId,
        runtimeMode: options.runtimeMode,
        forFind: true
      })
    ) {
      return false
    }
    return true
  })
}

export async function findControls(options: ControlFindOptions): Promise<ControlFindResult> {
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const queryTokens = buildControlQueryTokens(query)
  const filterTags = (options.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
  const sourceFilter = normalizeControlListFilter(options.sourceType)
  const riskFilter = normalizeControlListFilter(options.riskLevel)
  const limit = clampNumber(options.limit ?? DEFAULT_CONTROL_RESULTS, 1, MAX_CONTROL_RESULTS)
  const includeDraft = options.includeDraft === true
  const artifactUseIntent = isArtifactUseIntent(queryTokens)

  const rows = (await resolveVisibleControls({
    userId: options.userId ?? null,
    agentId: options.agentId ?? null,
    runtimeMode: options.runtimeMode ?? null,
    includeDraft,
    allowedControlIds: options.allowedControlIds
  }))
    .map((definition) => {
      if (sourceFilter && !sourceFilter.has(definition.sourceType)) return false
      if (riskFilter && !riskFilter.has(definition.riskLevel)) return false
      if (!matchesTagFilter(definition.tags, filterTags)) return false
      const relevance = scoreControlForQuery({ definition, query, queryTokens })
      if (!relevance.matched) return false
      return {
        definition,
        score: relevance.score
      }
    })
    .filter((row): row is { definition: ControlDefinition; score: number } => row !== false)
    .sort((left, right) => {
      if (artifactUseIntent) {
        const leftTypedArtifact = left.definition.controlId.startsWith('use.artifact.') ? 0 : 1
        const rightTypedArtifact = right.definition.controlId.startsWith('use.artifact.') ? 0 : 1
        if (leftTypedArtifact !== rightTypedArtifact) return leftTypedArtifact - rightTypedArtifact
      }

      // Core sys.* controls normally sort before per-instance dynamic controls
      // so they are not pushed out by instance controls, except when the user
      // explicitly asks for typed artifact-use controls.
      const leftIsCore = left.definition.controlId.startsWith('sys.') ? 0 : 1
      const rightIsCore = right.definition.controlId.startsWith('sys.') ? 0 : 1
      if (leftIsCore !== rightIsCore) return leftIsCore - rightIsCore

      if (left.score !== right.score) return right.score - left.score

      const leftTypedArtifact = left.definition.controlId.startsWith('use.artifact.') ? 0 : 1
      const rightTypedArtifact = right.definition.controlId.startsWith('use.artifact.') ? 0 : 1
      if (leftTypedArtifact !== rightTypedArtifact) return leftTypedArtifact - rightTypedArtifact

      return left.definition.controlId.localeCompare(right.definition.controlId)
    })
    .map((row) => row.definition)

  const results: ControlFindResultItem[] = rows.slice(0, limit).map((definition) => ({
    controlId: definition.controlId,
    sourceType: definition.sourceType,
    executorType: definition.executorType,
    title: definition.title,
    description: definition.description,
    riskLevel: definition.riskLevel,
    status: definition.status,
    tags: definition.tags,
    schemaHint: definition.schemaHint,
    ...(options.includeSchema ? { inputSchema: definition.inputSchemaJson } : {})
  }))

  return {
    results,
    totalMatches: rows.length,
    query,
    limit
  }
}

export async function useControl(options: ControlUseOptions): Promise<ControlUseResult> {
  const startedAt = Date.now()
  const actorType = options.actorType ?? 'unknown'
  const requestedControlId = typeof options.controlId === 'string' ? options.controlId.trim() : ''
  const inputPayload =
    options.input && typeof options.input === 'object' && !Array.isArray(options.input) ? options.input : {}
  const selectedGateways = normalizeStringArray(options.selectedGateways)
  const allowedControlIds = normalizeControlIdList(options.allowedControlIds)
  const controlDefinitions = await loadControlDefinitionsForUser(options.userId)
  let control =
    STATIC_CONTROL_MAP.get(requestedControlId) ||
    controlDefinitions.find((definition) => definition.controlId === requestedControlId)
  const aliasResolution =
    !control
      ? resolveDynamicArtifactAliasControl({
          requestedControlId,
          inputPayload,
          controls: controlDefinitions,
          agentId: options.agentId ?? null,
          runtimeMode: options.runtimeMode ?? null,
          allowedControlIds
        })
      : { kind: 'none' as const }

  if (!control && aliasResolution.kind === 'resolved') {
    control = aliasResolution.control
  }
  const effectiveControlId = control?.controlId ?? requestedControlId

  const finalize = async (
    result: ControlUseResult,
    definition: ControlDefinition | undefined
  ): Promise<ControlUseResult> => {
    const auditEntry: ControlAuditEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
      userId: options.userId,
      actorType,
      controlId: definition?.controlId ?? requestedControlId,
      controlStatus: definition?.status ?? null,
      riskLevel: definition?.riskLevel ?? null,
      dryRun: options.dryRun === true,
      allowRisky: options.allowRisky === true,
      durationMs: Date.now() - startedAt,
      success: result.success,
      errorCode: result.success ? null : result.error.code,
      errorMessage: result.success ? null : result.error.message,
      inputKeys: Object.keys(inputPayload).sort(),
      selectedGateways: selectedGateways ?? []
    }
    await recordControlAudit(auditEntry)
    return result
  }

  if (!control) {
    if (aliasResolution.kind === 'ambiguous') {
      return await finalize(
        {
          success: false,
          controlId: requestedControlId,
          error: {
            code: 'CONTROL_NOT_FOUND',
            message: `Control "${requestedControlId}" is ambiguous. Use one exact controlId.`,
            details: {
              candidates: aliasResolution.candidates.slice(0, 8)
            }
          }
        },
        undefined
      )
    }

    return await finalize(
      {
        success: false,
        controlId: requestedControlId,
        error: {
          code: 'CONTROL_NOT_FOUND',
          message: `Control "${requestedControlId}" not found.`
        }
      },
      undefined
    )
  }

  if (
    Array.isArray(allowedControlIds) &&
    !controlIdMatchesAllowedEntries(control.controlId, allowedControlIds)
  ) {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_NOT_ALLOWED',
          message: `Control "${effectiveControlId}" is not allowed in this context.`
        }
      },
      control
    )
  }

  if (
    !isControlVisibleForContext(control, {
      agentId: options.agentId ?? null,
      runtimeMode: options.runtimeMode ?? null,
      forFind: false
    })
  ) {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_NOT_ALLOWED',
          message: `Control "${effectiveControlId}" is not available for the current agent scope.`
        }
      },
      control
    )
  }

  if (control.status !== 'published') {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_NOT_EXECUTABLE',
          message: `Control "${effectiveControlId}" is ${control.status} and cannot be executed yet.`
        }
      },
      control
    )
  }

  const riskScopeKey = resolveControlRiskScopeKey(effectiveControlId, inputPayload)
  let hasCachedRiskApproval = false
  if (control.riskLevel !== 'safe' && options.allowRisky !== true) {
    hasCachedRiskApproval = await hasRecentControlRiskApproval({
      userId: options.userId,
      controlId: effectiveControlId,
      agentId: options.agentId ?? null,
      scopeKey: riskScopeKey
    })
    if (!hasCachedRiskApproval) {
      const hasContextualApproval = await hasContextualControlRiskApproval({
        userId: options.userId,
        controlId: effectiveControlId,
        sessionId: options.sessionId,
        inputPayload
      })
      if (hasContextualApproval) {
        await recordControlRiskApproval({
          userId: options.userId,
          controlId: effectiveControlId,
          agentId: options.agentId ?? null,
          scopeKey: riskScopeKey
        })
        hasCachedRiskApproval = true
      }
    }
  }

  if (control.riskLevel !== 'safe' && options.allowRisky !== true && !hasCachedRiskApproval) {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_RISK_REQUIRES_APPROVAL',
          message: `Control "${effectiveControlId}" has risk level "${control.riskLevel}" and requires explicit approval.`,
          details: {
            riskLevel: control.riskLevel
          }
        }
      },
      control
    )
  }

  if (control.riskLevel !== 'safe' && options.allowRisky === true) {
    await recordControlRiskApproval({
      userId: options.userId,
      controlId: effectiveControlId,
      agentId: options.agentId ?? null,
      scopeKey: riskScopeKey
    })
  }

  const parsedInput = control.inputSchema.safeParse(inputPayload)
  if (!parsedInput.success) {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_INPUT_INVALID',
          message: `Invalid input for "${effectiveControlId}".`,
          details: parsedInput.error.flatten()
        }
      },
      control
    )
  }

  if (options.dryRun === true) {
    return await finalize(
      {
        success: true,
        controlId: effectiveControlId,
        dryRun: true,
        riskLevel: control.riskLevel,
        status: control.status,
        result: {
          validated: true
        }
      },
      control
    )
  }

  if (!control.handler) {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_NOT_EXECUTABLE',
          message: `Control "${effectiveControlId}" does not have an execution handler.`
        }
      },
      control
    )
  }

  try {
    const result = await control.handler(
      {
        userId: options.userId,
        agentId: options.agentId ?? null,
        sessionId: options.sessionId ?? null,
        selectedGateways: selectedGateways ?? undefined
      },
      parsedInput.data as Record<string, any>
    )

    if (result && result.success === false && typeof result.error === 'string') {
      return await finalize(
        {
          success: false,
          controlId: effectiveControlId,
          error: {
            code: 'CONTROL_EXECUTION_FAILED',
            message: result.error,
            details: result
          }
        },
        control
      )
    }

    return await finalize(
      {
        success: true,
        controlId: effectiveControlId,
        dryRun: false,
        riskLevel: control.riskLevel,
        status: control.status,
        result
      },
      control
    )
  } catch (error) {
    return await finalize(
      {
        success: false,
        controlId: effectiveControlId,
        error: {
          code: 'CONTROL_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Control execution failed.'
        }
      },
      control
    )
  }
}
