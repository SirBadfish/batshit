import path from 'node:path'
import { spawn } from 'node:child_process'
import { access, constants as fsConstants, stat } from 'node:fs/promises'

import { z } from 'zod'

import { cloneIconRef, isIconRef } from '$lib/icons/iconTypes'
import { normalizeOptionalIconRef } from '$lib/icons/iconLegacy'
import { redis } from '$lib/server/redis'
import {
  INFRA_API_KEY_SERVICES,
  apiKeyService,
  normalizeApiKeyServiceName
} from '$lib/services/apiKey.server'
import type {
  AgentRow,
  CliToolArgTemplateEntry,
  CliToolCwdPolicy,
  CliToolEnvRef,
  CliToolInputField,
  CliToolInputSchema,
  CliToolOrigin,
  CliToolOutputMode,
  CliToolParseMode,
  CliToolRecord,
  CliToolRegistryStore,
  CliToolRiskLevel,
  CliToolStatus,
  CliToolValidationStatus
} from '$lib/types/database'
import { normalizeCliToolGridSettings } from '$lib/utils/toolGridCli'

export const CLI_TOOL_REGISTRY_SCHEMA_VERSION = 1 as const

const CLI_TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const VALID_CWD_POLICIES = new Set<CliToolCwdPolicy>(['none', 'project', 'fixed'])
const VALID_OUTPUT_MODES = new Set<CliToolOutputMode>(['text', 'json', 'mixed'])
const VALID_PARSE_MODES = new Set<CliToolParseMode>(['text', 'json', 'json_in_text'])
const VALID_RISK_LEVELS = new Set<CliToolRiskLevel>(['safe', 'confirm', 'restricted'])
const VALID_STATUSES = new Set<CliToolStatus>(['active', 'disabled', 'archived'])
const VALID_ORIGINS = new Set<CliToolOrigin>(['manual', 'imported', 'generated'])
const VALIDATION_STATUSES = new Set<CliToolValidationStatus>(['never', 'passed', 'failed'])
const PATH_FIELD_FORMATS = new Set(['path'])
const SHELL_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'cmd.exe'
])
const INLINE_SHELL_FLAGS = new Set(['-c', '-lc', '-ic', '/c', '-command', '-encodedcommand'])

export const DEFAULT_CLI_TOOL_TIMEOUT_MS = 60_000
export const MIN_CLI_TOOL_TIMEOUT_MS = 1_000
export const MAX_CLI_TOOL_TIMEOUT_MS = 300_000
export const MAX_CLI_TOOL_OUTPUT_CHARS = 200_000
const CLI_TOOL_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 30
const MAX_FIND_RESULTS = 25

const cliToolInputFieldSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'array']),
    description: z.string().trim().min(1).optional(),
    required: z.boolean().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    items: z
      .object({
        type: z.enum(['string', 'number', 'boolean'])
      })
      .strict()
      .optional(),
    format: z.enum(['plain', 'path']).optional()
  })
  .strict()

const cliToolInputSchemaSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string().trim().min(1), cliToolInputFieldSchema),
    required: z.array(z.string().trim().min(1)).optional()
  })
  .strict()

const cliToolArgTemplateEntrySchema = z.union([
  z
    .object({
      kind: z.literal('literal'),
      value: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('input'),
      field: z.string().trim().min(1),
      required: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('option'),
      flag: z.string().trim().min(1),
      field: z.string().trim().min(1),
      required: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('flag'),
      flag: z.string().trim().min(1),
      field: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal('repeat'),
      field: z.string().trim().min(1),
      flag: z.string().trim().min(1).optional(),
      required: z.boolean().optional()
    })
    .strict()
])

const cliToolEnvRefSchema = z
  .object({
    envVar: z.string().trim().min(1),
    savedKeyRef: z.string().trim().min(1)
  })
  .strict()

const iconRefSchema = z.custom((value) => isIconRef(value), 'Invalid iconRef')

const cliToolRecordSchema = z
  .object({
    toolId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).default([]),
    origin: z.enum(['manual', 'imported', 'generated']),
    status: z.enum(['active', 'disabled', 'archived']),
    executable: z.string().trim().min(1),
    argsTemplate: z.array(cliToolArgTemplateEntrySchema).default([]),
    inputSchema: cliToolInputSchemaSchema,
    outputMode: z.enum(['text', 'json', 'mixed']),
    parseMode: z.enum(['text', 'json', 'json_in_text']),
    cwdPolicy: z.enum(['none', 'project', 'fixed']),
    cwdValue: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(MIN_CLI_TOOL_TIMEOUT_MS).max(MAX_CLI_TOOL_TIMEOUT_MS),
    envRefs: z.array(cliToolEnvRefSchema).optional(),
    riskLevel: z.enum(['safe', 'confirm', 'restricted']),
    allowNetwork: z.boolean(),
    allowWrite: z.boolean(),
    allowedPaths: z.array(z.string().trim().min(1)).optional(),
    helpCommand: z.array(z.string()).optional(),
    validationInput: z.record(z.string(), z.any()).optional(),
    examples: z.array(z.string().trim().min(1)).optional(),
    iconRef: iconRefSchema.nullable().optional(),
    iconHint: z.string().trim().min(1).optional(),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    lastValidatedAt: z.string().trim().min(1).optional(),
    lastValidationStatus: z.enum(['never', 'passed', 'failed']).optional(),
    lastValidationError: z.string().trim().min(1).nullable().optional(),
    lastValidationSummary: z.string().trim().min(1).nullable().optional()
  })
  .strict()

const cliToolRegistryStoreSchema = z
  .object({
    version: z.literal(CLI_TOOL_REGISTRY_SCHEMA_VERSION),
    records: z.array(cliToolRecordSchema).default([])
  })
  .strict()

type CliToolExecutionAuditEntry = {
  id: string
  userId: string
  agentId?: string | null
  sessionId?: string | null
  toolId: string
  title: string
  riskLevel: CliToolRiskLevel
  success: boolean
  blocked: boolean
  executable: string
  args: string[]
  cwd?: string
  outputMode: CliToolOutputMode
  parseMode: CliToolParseMode
  exitCode: number | null
  durationMs: number
  createdAt: string
  error?: string
}

export type CliToolExecutionParams = {
  userId: string
  toolId: string
  input?: Record<string, any> | null
  agentId?: string | null
  sessionId?: string | null
  selectedToolIds?: string[] | null
  allowRisky?: boolean
  projectPath?: string | null
}

export type CliToolExecutionResult =
  | {
      success: true
      toolId: string
      title: string
      executable: string
      args: string[]
      cwd?: string
      outputMode: CliToolOutputMode
      parseMode: CliToolParseMode
      exitCode: number
      stdout: string
      stderr: string
      parsedOutput?: unknown
      durationMs: number
      auditId: string
      riskLevel: CliToolRiskLevel
    }
  | {
      success: false
      toolId: string
      title?: string
      executable?: string
      args?: string[]
      cwd?: string
      outputMode?: CliToolOutputMode
      parseMode?: CliToolParseMode
      exitCode?: number | null
      stdout?: string
      stderr?: string
      durationMs?: number
      auditId?: string
      blocked?: boolean
      requiresApproval?: boolean
      code:
        | 'NOT_FOUND'
        | 'OUT_OF_SCOPE'
        | 'INVALID_STATUS'
        | 'INPUT_VALIDATION_FAILED'
        | 'POLICY_BLOCKED'
        | 'REQUIRES_APPROVAL'
        | 'EXECUTION_FAILED'
        | 'OUTPUT_PARSE_FAILED'
      error: string
      riskLevel?: CliToolRiskLevel
    }

export type CliToolValidationResult = {
  success: boolean
  toolId: string
  executable?: string
  args?: string[]
  cwd?: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
  summary: string
  error?: string
}

export type CliToolFindParams = {
  userId: string
  agentId?: string | null
  selectedToolIds?: string[] | null
  query?: string
  limit?: number
  includeSchema?: boolean
}

export type CliToolFindResult = {
  toolId: string
  title: string
  description: string
  tags: string[]
  outputMode: CliToolOutputMode
  executable: string
  schemaHint: string
  inputSchema?: CliToolInputSchema
  lastValidationStatus: CliToolValidationStatus
}

function buildCliToolRegistryKey(userId: string): string {
  return `cli_tool_registry:${userId}`
}

function buildCliToolAuditKey(userId: string, auditId: string): string {
  return `cli_tool_audit:${userId}:${auditId}`
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return Array.from(new Set(normalized))
}

function normalizeCliToolIconRef(input: unknown, existing?: CliToolRecord | null): CliToolRecord['iconRef'] {
  if (input === null) return null
  if (input !== undefined) {
    if (!isIconRef(input)) {
      throw new Error('iconRef must be a valid icon picker reference')
    }
    return cloneIconRef(input)
  }

  if (existing?.iconRef) return cloneIconRef(existing.iconRef)
  return normalizeOptionalIconRef(existing?.iconHint)
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clampTimeout(value: unknown): number {
  const numeric = normalizeOptionalNumber(value) ?? DEFAULT_CLI_TOOL_TIMEOUT_MS
  return Math.min(Math.max(Math.floor(numeric), MIN_CLI_TOOL_TIMEOUT_MS), MAX_CLI_TOOL_TIMEOUT_MS)
}

export function normalizeCliToolId(value: unknown): string {
  const normalized = normalizeString(value)?.toLowerCase()
  if (!normalized) {
    throw new Error('toolId is required')
  }
  if (!CLI_TOOL_ID_PATTERN.test(normalized)) {
    throw new Error('toolId must use lowercase letters, numbers, dot, dash, or underscore.')
  }
  return normalized
}

function deriveCliToolIdFromTitle(title: string): string {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')

  return normalizeCliToolId(normalized)
}

function sanitizeCliToolInputField(value: unknown): CliToolInputField {
  const parsed = cliToolInputFieldSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`Invalid CLI input field: ${parsed.error.issues[0]?.message ?? 'unknown error'}`)
  }
  const field = { ...parsed.data }
  if (field.type === 'array' && !field.items) {
    field.items = { type: 'string' }
  }
  if (field.type !== 'array') {
    delete field.items
  }
  if (!field.format) {
    field.format = 'plain'
  }
  return field
}

function sanitizeCliToolInputSchema(value: unknown): CliToolInputSchema {
  if (!value || typeof value !== 'object') {
    throw new Error('inputSchema is required')
  }
  const raw = value as Record<string, unknown>
  const propertiesRaw = raw.properties
  if (!propertiesRaw || typeof propertiesRaw !== 'object' || Array.isArray(propertiesRaw)) {
    throw new Error('inputSchema.properties is required')
  }
  const properties: Record<string, CliToolInputField> = {}
  for (const [key, entry] of Object.entries(propertiesRaw)) {
    const fieldName = key.trim()
    if (!fieldName) continue
    properties[fieldName] = sanitizeCliToolInputField(entry)
  }
  const requiredList =
    normalizeStringList(raw.required) ??
    Object.entries(properties)
      .filter(([, field]) => field.required === true)
      .map(([fieldName]) => fieldName)

  return {
    type: 'object',
    properties,
    ...(requiredList.length > 0 ? { required: requiredList } : {})
  }
}

function sanitizeCliToolArgTemplate(value: unknown): CliToolArgTemplateEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('argsTemplate must be an array')
  }

  const entries = value.map((entry) => {
    const parsed = cliToolArgTemplateEntrySchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error(`Invalid argsTemplate entry: ${parsed.error.issues[0]?.message ?? 'unknown error'}`)
    }
    return parsed.data as CliToolArgTemplateEntry
  })

  return entries
}

function sanitizeCliToolEnvRefs(value: unknown): CliToolEnvRef[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  const refs: CliToolEnvRef[] = []
  for (const entry of value) {
    const parsed = cliToolEnvRefSchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error(`Invalid envRefs entry: ${parsed.error.issues[0]?.message ?? 'unknown error'}`)
    }
    const envVar = parsed.data.envVar.trim()
    const savedKeyRef = parsed.data.savedKeyRef.trim()
    const dedupeKey = `${envVar}::${savedKeyRef}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    refs.push({ envVar, savedKeyRef })
  }
  return refs
}

function sanitizeCliToolAllowedPaths(value: unknown): string[] | undefined {
  const paths = normalizeStringList(value)
  if (!paths) return undefined
  return paths.map((entry) => path.resolve(entry))
}

function sanitizeCliToolStringArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((entry) => (typeof entry === 'string' ? entry : String(entry)))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function sanitizeCliToolValidationInput(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return { ...(value as Record<string, any>) }
}

function sanitizeCliToolRecordInput(
  input: Record<string, any>,
  options: { existing?: CliToolRecord | null } = {}
): CliToolRecord {
  const existing = options.existing ?? null
  const now = new Date().toISOString()
  const title = normalizeString(input.title ?? existing?.title)
  const toolId = normalizeCliToolId(input.toolId ?? existing?.toolId ?? (title ? deriveCliToolIdFromTitle(title) : undefined))
  const description = normalizeString(input.description ?? existing?.description)
  const executable = normalizeString(input.executable ?? existing?.executable)
  const originRaw = normalizeString(input.origin ?? existing?.origin)?.toLowerCase()
  const statusRaw = normalizeString(input.status ?? existing?.status)?.toLowerCase()
  const outputModeRaw = normalizeString(input.outputMode ?? existing?.outputMode)?.toLowerCase()
  const parseModeRaw = normalizeString(input.parseMode ?? existing?.parseMode)?.toLowerCase()
  const cwdPolicyRaw = normalizeString(input.cwdPolicy ?? existing?.cwdPolicy)?.toLowerCase()
  const riskLevelRaw = normalizeString(input.riskLevel ?? existing?.riskLevel)?.toLowerCase()
  const lastValidationStatusRaw = normalizeString(
    input.lastValidationStatus ?? existing?.lastValidationStatus
  )?.toLowerCase()

  if (!title) throw new Error('title is required')
  if (!description) throw new Error('description is required')
  if (!executable) throw new Error('executable is required')
  if (!originRaw || !VALID_ORIGINS.has(originRaw as CliToolOrigin)) {
    throw new Error('origin must be manual, imported, or generated')
  }
  if (!statusRaw || !VALID_STATUSES.has(statusRaw as CliToolStatus)) {
    throw new Error('status must be active, disabled, or archived')
  }
  if (!outputModeRaw || !VALID_OUTPUT_MODES.has(outputModeRaw as CliToolOutputMode)) {
    throw new Error('outputMode must be text, json, or mixed')
  }
  if (!parseModeRaw || !VALID_PARSE_MODES.has(parseModeRaw as CliToolParseMode)) {
    throw new Error('parseMode must be text, json, or json_in_text')
  }
  if (!cwdPolicyRaw || !VALID_CWD_POLICIES.has(cwdPolicyRaw as CliToolCwdPolicy)) {
    throw new Error('cwdPolicy must be none, project, or fixed')
  }
  if (riskLevelRaw && !VALID_RISK_LEVELS.has(riskLevelRaw as CliToolRiskLevel)) {
    throw new Error('riskLevel must be safe, confirm, or restricted')
  }
  const resolvedRiskLevel = (riskLevelRaw ?? 'safe') as CliToolRiskLevel

  const inputSchema = sanitizeCliToolInputSchema(input.inputSchema ?? existing?.inputSchema)
  const argsTemplate = sanitizeCliToolArgTemplate(input.argsTemplate ?? existing?.argsTemplate ?? [])
  const envRefs = sanitizeCliToolEnvRefs(input.envRefs ?? existing?.envRefs)
  const allowedPaths = sanitizeCliToolAllowedPaths(input.allowedPaths ?? existing?.allowedPaths)
  const helpCommand = sanitizeCliToolStringArgs(input.helpCommand ?? existing?.helpCommand)
  const validationInput = sanitizeCliToolValidationInput(input.validationInput ?? existing?.validationInput)
  const examples = normalizeStringList(input.examples ?? existing?.examples)
  const tags = normalizeStringList(input.tags ?? existing?.tags) ?? []
  const iconRef = normalizeCliToolIconRef(input.iconRef, existing) ?? normalizeOptionalIconRef(input.iconHint)
  const cwdValue = normalizeString(input.cwdValue ?? existing?.cwdValue)
  const allowNetwork = normalizeOptionalBoolean(input.allowNetwork ?? existing?.allowNetwork)
  const allowWrite = normalizeOptionalBoolean(input.allowWrite ?? existing?.allowWrite)

  if (allowNetwork === undefined) throw new Error('allowNetwork must be true or false')
  if (allowWrite === undefined) throw new Error('allowWrite must be true or false')
  if (cwdPolicyRaw === 'fixed') {
    if (!cwdValue) {
      throw new Error('cwdValue is required when cwdPolicy is fixed')
    }
    if (!path.isAbsolute(cwdValue)) {
      throw new Error('cwdValue must be an absolute path when cwdPolicy is fixed')
    }
  }
  if (allowWrite && (!allowedPaths || allowedPaths.length === 0)) {
    throw new Error('write-capable CLI tools must declare at least one allowed path')
  }
  if (parseModeRaw === 'json' && outputModeRaw === 'text') {
    throw new Error('parseMode=json is not valid when outputMode=text')
  }

  validateInputSchemaContract(inputSchema)
  validateArgsTemplateContract(argsTemplate, inputSchema)
  validateEnvRefsContract(envRefs)
  validateHelpCommandContract(executable, helpCommand)

  const timeoutMs = clampTimeout(input.timeoutMs ?? existing?.timeoutMs)
  const createdAt = existing?.createdAt ?? now
  const updatedAt = now
  const lastValidatedAt = normalizeString(input.lastValidatedAt ?? existing?.lastValidatedAt)
  const lastValidationStatus =
    lastValidationStatusRaw && VALIDATION_STATUSES.has(lastValidationStatusRaw as CliToolValidationStatus)
      ? (lastValidationStatusRaw as CliToolValidationStatus)
      : existing?.lastValidationStatus ?? 'never'
  const lastValidationError =
    input.lastValidationError === null
      ? null
      : normalizeString(input.lastValidationError ?? existing?.lastValidationError) ?? null
  const lastValidationSummary =
    input.lastValidationSummary === null
      ? null
      : normalizeString(input.lastValidationSummary ?? existing?.lastValidationSummary) ?? null

  const record: CliToolRecord = {
    toolId,
    title,
    description,
    tags,
    origin: originRaw as CliToolOrigin,
    status: statusRaw as CliToolStatus,
    executable,
    argsTemplate,
    inputSchema,
    outputMode: outputModeRaw as CliToolOutputMode,
    parseMode: parseModeRaw as CliToolParseMode,
    cwdPolicy: cwdPolicyRaw as CliToolCwdPolicy,
    timeoutMs,
    riskLevel: resolvedRiskLevel,
    allowNetwork,
    allowWrite,
    createdAt,
    updatedAt,
    lastValidationStatus,
    ...(cwdValue ? { cwdValue } : {}),
    ...(envRefs !== undefined ? { envRefs } : {}),
    ...(allowedPaths !== undefined ? { allowedPaths } : {}),
    ...(helpCommand !== undefined ? { helpCommand } : {}),
    ...(validationInput !== undefined ? { validationInput } : {}),
    ...(examples !== undefined ? { examples } : {}),
    ...(iconRef ? { iconRef } : {}),
    ...(lastValidatedAt ? { lastValidatedAt } : {}),
    ...(lastValidationError !== undefined ? { lastValidationError } : {}),
    ...(lastValidationSummary !== undefined ? { lastValidationSummary } : {})
  }

  const parsed = cliToolRecordSchema.safeParse(record)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid CLI tool record')
  }

  return parsed.data as CliToolRecord
}

function validateInputSchemaContract(inputSchema: CliToolInputSchema): void {
  const required = new Set(inputSchema.required ?? [])
  for (const [fieldName, field] of Object.entries(inputSchema.properties)) {
    if (field.required === true) {
      required.add(fieldName)
    }
    if (field.type === 'array' && !field.items) {
      throw new Error(`inputSchema field "${fieldName}" requires an item type`)
    }
  }
}

function validateArgsTemplateContract(
  argsTemplate: CliToolArgTemplateEntry[],
  inputSchema: CliToolInputSchema
): void {
  const knownFields = new Set(Object.keys(inputSchema.properties))
  if (argsTemplate.length === 0) {
    throw new Error('argsTemplate must include at least one entry')
  }

  for (const entry of argsTemplate) {
    if (entry.kind === 'literal') continue
    if (!knownFields.has(entry.field)) {
      throw new Error(`argsTemplate references unknown input field "${entry.field}"`)
    }
    const field = inputSchema.properties[entry.field]
    if (entry.kind === 'repeat') {
      if (field.type !== 'array') {
        throw new Error(`repeat argsTemplate entry requires array input field "${entry.field}"`)
      }
      continue
    }
    if (field.type === 'array') {
      throw new Error(`Use repeat for array input field "${entry.field}"`)
    }
  }
}

function validateEnvRefsContract(envRefs?: CliToolEnvRef[]): void {
  if (!envRefs || envRefs.length === 0) return
  const seen = new Set<string>()
  for (const entry of envRefs) {
    if (!ENV_VAR_PATTERN.test(entry.envVar)) {
      throw new Error(`Invalid env var name "${entry.envVar}"`)
    }
    const savedKeyRef = normalizeApiKeyServiceName(entry.savedKeyRef)
    if (INFRA_API_KEY_SERVICES.has(savedKeyRef)) {
      throw new Error(`envRefs cannot use Batshit infrastructure key "${savedKeyRef}"`)
    }
    const dedupeKey = `${entry.envVar}::${savedKeyRef}`
    if (seen.has(dedupeKey)) {
      throw new Error(`Duplicate envRefs mapping for ${entry.envVar}`)
    }
    seen.add(dedupeKey)
  }
}

function validateHelpCommandContract(executable: string, helpCommand?: string[]): void {
  if (!helpCommand || helpCommand.length === 0) return
  const commandBase = path.basename(executable).toLowerCase()
  if (!SHELL_COMMANDS.has(commandBase)) return
  if (helpCommand.some((entry) => INLINE_SHELL_FLAGS.has(entry.trim().toLowerCase()))) {
    throw new Error('helpCommand must be argv-style; inline shell commands are not allowed')
  }
}

async function readRegistry(userId: string): Promise<CliToolRegistryStore> {
  const raw = await redis.execute(async (client) => {
    return await client.json.get(buildCliToolRegistryKey(userId))
  })

  if (!raw) {
    return {
      version: CLI_TOOL_REGISTRY_SCHEMA_VERSION,
      records: []
    }
  }

  const parsed = cliToolRegistryStoreSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`CLI tool registry is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`)
  }
  return parsed.data as CliToolRegistryStore
}

async function writeRegistry(userId: string, store: CliToolRegistryStore): Promise<void> {
  await redis.execute(async (client) => {
    await client.json.set(buildCliToolRegistryKey(userId), '$', store as any)
  })
}

function sortRecords(records: CliToolRecord[]): CliToolRecord[] {
  return [...records].sort((left, right) => left.title.localeCompare(right.title))
}

export async function listCliTools(userId: string): Promise<CliToolRecord[]> {
  const store = await readRegistry(userId)
  return sortRecords(store.records)
}

export async function getCliTool(userId: string, toolId: string): Promise<CliToolRecord | null> {
  const normalizedToolId = normalizeCliToolId(toolId)
  const store = await readRegistry(userId)
  return store.records.find((record) => record.toolId === normalizedToolId) ?? null
}

export async function createCliTool(userId: string, input: Record<string, any>): Promise<CliToolRecord> {
  const store = await readRegistry(userId)
  const nextRecord = sanitizeCliToolRecordInput(input)
  if (store.records.some((record) => record.toolId === nextRecord.toolId)) {
    throw new Error(`CLI tool "${nextRecord.toolId}" already exists`)
  }
  const nextStore: CliToolRegistryStore = {
    version: CLI_TOOL_REGISTRY_SCHEMA_VERSION,
    records: sortRecords([...store.records, nextRecord])
  }
  await writeRegistry(userId, nextStore)
  return nextRecord
}

export async function updateCliTool(
  userId: string,
  toolId: string,
  updates: Record<string, any>
): Promise<CliToolRecord> {
  const normalizedToolId = normalizeCliToolId(toolId)
  const store = await readRegistry(userId)
  const existing = store.records.find((record) => record.toolId === normalizedToolId)
  if (!existing) {
    throw new Error(`CLI tool "${normalizedToolId}" was not found`)
  }
  const nextRecord = sanitizeCliToolRecordInput(
    {
      ...existing,
      ...updates,
      toolId: normalizedToolId
    },
    { existing }
  )
  const nextStore: CliToolRegistryStore = {
    version: CLI_TOOL_REGISTRY_SCHEMA_VERSION,
    records: sortRecords(
      store.records.map((record) => (record.toolId === normalizedToolId ? nextRecord : record))
    )
  }
  await writeRegistry(userId, nextStore)
  return nextRecord
}

export async function deleteCliTool(userId: string, toolId: string): Promise<void> {
  const normalizedToolId = normalizeCliToolId(toolId)
  const store = await readRegistry(userId)
  if (!store.records.some((record) => record.toolId === normalizedToolId)) {
    throw new Error(`CLI tool "${normalizedToolId}" was not found`)
  }
  const nextStore: CliToolRegistryStore = {
    version: CLI_TOOL_REGISTRY_SCHEMA_VERSION,
    records: store.records.filter((record) => record.toolId !== normalizedToolId)
  }
  await writeRegistry(userId, nextStore)
}

function validateScalarValue(fieldName: string, field: CliToolInputField, value: unknown): void {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') throw new Error(`"${fieldName}" must be a string`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`"${fieldName}" must be a number`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`"${fieldName}" must be true or false`)
      break
    case 'array':
      if (!Array.isArray(value)) throw new Error(`"${fieldName}" must be an array`)
      const itemType = field.items?.type ?? 'string'
      value.forEach((entry, index) => {
        if (itemType === 'string' && typeof entry !== 'string') {
          throw new Error(`"${fieldName}[${index}]" must be a string`)
        }
        if (itemType === 'number' && (typeof entry !== 'number' || !Number.isFinite(entry))) {
          throw new Error(`"${fieldName}[${index}]" must be a number`)
        }
        if (itemType === 'boolean' && typeof entry !== 'boolean') {
          throw new Error(`"${fieldName}[${index}]" must be true or false`)
        }
      })
      break
    default:
      throw new Error(`Unsupported input field type for "${fieldName}"`)
  }

    if (Array.isArray(field.enum) && field.enum.length > 0) {
    const enumValues = field.enum ?? []
    if (field.type === 'array') {
      ;(value as unknown[]).forEach((entry, index) => {
        if (!enumValues.includes(entry as any)) {
          throw new Error(`"${fieldName}[${index}]" must be one of ${enumValues.join(', ')}`)
        }
      })
    } else if (!enumValues.includes(value as any)) {
      throw new Error(`"${fieldName}" must be one of ${enumValues.join(', ')}`)
    }
  }
}

export function validateCliToolInput(
  inputSchema: CliToolInputSchema,
  input: Record<string, any> | null | undefined
): Record<string, any> {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {}
  const allowedFields = new Set(Object.keys(inputSchema.properties))
  const requiredFields = new Set([
    ...(inputSchema.required ?? []),
    ...Object.entries(inputSchema.properties)
      .filter(([, field]) => field.required === true)
      .map(([fieldName]) => fieldName)
  ])

  for (const key of Object.keys(payload)) {
    if (!allowedFields.has(key)) {
      throw new Error(`Unexpected input field "${key}"`)
    }
  }

  for (const fieldName of requiredFields) {
    if (!(fieldName in payload)) {
      throw new Error(`Missing required input field "${fieldName}"`)
    }
  }

  for (const [fieldName, field] of Object.entries(inputSchema.properties)) {
    if (!(fieldName in payload)) continue
    validateScalarValue(fieldName, field, payload[fieldName])
  }

  return payload
}

function stringifyArgValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value)
}

export function compileCliToolArgs(
  record: Pick<CliToolRecord, 'argsTemplate' | 'inputSchema'>,
  input: Record<string, any>
): string[] {
  const argv: string[] = []

  for (const entry of record.argsTemplate) {
    if (entry.kind === 'literal') {
      argv.push(entry.value)
      continue
    }

    const field = entry.field
    const value = input[field]
    const fieldSchema = record.inputSchema.properties[field]
    const isMissing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0)

    if (isMissing) {
      if (entry.kind !== 'flag' && (entry.required === true || fieldSchema?.required === true)) {
        throw new Error(`Input field "${field}" is required`)
      }
      continue
    }

    if (entry.kind === 'flag') {
      if (value === true) {
        argv.push(entry.flag)
      }
      continue
    }

    if (entry.kind === 'repeat') {
      if (!Array.isArray(value)) {
        throw new Error(`Input field "${field}" must be an array for repeat entries`)
      }
      for (const item of value) {
        if (entry.flag) argv.push(entry.flag)
        argv.push(stringifyArgValue(item as string | number | boolean))
      }
      continue
    }

    if (Array.isArray(value)) {
      throw new Error(`Input field "${field}" must use a repeat argsTemplate entry`)
    }

    const serialized = stringifyArgValue(value as string | number | boolean)
    if (entry.kind === 'option') {
      argv.push(entry.flag, serialized)
      continue
    }

    argv.push(serialized)
  }

  return argv
}

function buildSchemaHint(inputSchema: CliToolInputSchema): string {
  const parts = Object.entries(inputSchema.properties).map(([fieldName, field]) => {
    const suffix = field.type === 'array' ? `array<${field.items?.type ?? 'string'}>` : field.type
    const required = field.required === true || inputSchema.required?.includes(fieldName) ? 'required' : 'optional'
    return `${fieldName}:${suffix} (${required})`
  })
  return parts.join(', ')
}

function searchScore(record: CliToolRecord, query: string): number {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 1

  let score = 0
  const title = record.title.toLowerCase()
  const description = record.description.toLowerCase()
  const toolId = record.toolId.toLowerCase()
  const tags = record.tags.join(' ').toLowerCase()

  if (toolId === normalizedQuery) score += 200
  if (title === normalizedQuery) score += 180
  if (toolId.includes(normalizedQuery)) score += 120
  if (title.includes(normalizedQuery)) score += 100
  if (description.includes(normalizedQuery)) score += 50
  if (tags.includes(normalizedQuery)) score += 30

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    if (toolId.includes(token)) score += 20
    if (title.includes(token)) score += 16
    if (description.includes(token)) score += 8
    if (tags.includes(token)) score += 6
  }

  return score
}

export async function resolveCliToolSelectionScope(params: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  selectedToolIds?: string[] | null
}): Promise<{
  toolIds: string[]
  source: 'selected' | 'agent' | 'user-global' | 'none'
}> {
  if (Array.isArray(params.selectedToolIds)) {
    return {
      toolIds: Array.from(
        new Set(
          params.selectedToolIds
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter((entry) => entry.length > 0)
        )
      ),
      source: 'selected'
    }
  }

  if (params.agentId) {
    const agent = (await redis.get(`agent:${params.agentId}`)) as AgentRow | null
    if (agent && agent.user_id === params.userId) {
      const defaultTools = Array.isArray((agent as any).defaultTools)
        ? (agent as any).defaultTools
        : Array.isArray((agent as any).default_tools)
          ? (agent as any).default_tools
          : null

      if (Array.isArray(defaultTools)) {
        return {
          toolIds: Array.from(
            new Set(
              defaultTools
                .map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : ''))
                .filter((entry: string) => entry.length > 0)
            )
          ),
          source: 'agent'
        }
      }
    }
  }

  const metadataDefaultTools = Array.isArray(params.agentMetadata?.defaultTools)
    ? params.agentMetadata.defaultTools
    : Array.isArray(params.agentMetadata?.default_tools)
      ? params.agentMetadata.default_tools
      : null

  if (Array.isArray(metadataDefaultTools)) {
    return {
      toolIds: Array.from(
        new Set(
          metadataDefaultTools
            .map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter((entry: string) => entry.length > 0)
        )
      ),
      source: 'agent'
    }
  }

  const userSettings = await redis.getUserSettings(params.userId).catch(() => null)
  const cliDefaults = normalizeCliToolGridSettings(
    userSettings?.global_tool_grid_settings?.cli ?? null
  )

  if (cliDefaults.discoverableToolIds.length > 0) {
    return {
      toolIds: cliDefaults.discoverableToolIds,
      source: 'user-global'
    }
  }

  return {
    toolIds: [],
    source: 'none'
  }
}

export async function findCliTools(params: CliToolFindParams): Promise<{
  results: CliToolFindResult[]
  totalMatches: number
  query: string
}> {
  const { toolIds: selectedToolIds } = await resolveCliToolSelectionScope(params)
  const selectedSet = new Set(selectedToolIds)
  const records = (await listCliTools(params.userId))
    .filter((record) => record.status === 'active')
    .filter((record) => selectedSet.has(record.toolId))

  const query = params.query?.trim() ?? ''
  const scored = records
    .map((record) => ({ record, score: searchScore(record, query) }))
    .filter((entry) => (query ? entry.score > 0 : true))
    .sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))

  const limit = Math.min(Math.max(params.limit ?? 10, 1), MAX_FIND_RESULTS)
  const results = scored.slice(0, limit).map(({ record }) => ({
    toolId: record.toolId,
    title: record.title,
    description: record.description,
    tags: record.tags,
    outputMode: record.outputMode,
    executable: record.executable,
    schemaHint: buildSchemaHint(record.inputSchema),
    ...(params.includeSchema ? { inputSchema: record.inputSchema } : {}),
    lastValidationStatus: record.lastValidationStatus ?? 'never'
  }))

  return {
    results,
    totalMatches: scored.length,
    query
  }
}

async function ensureDirectoryExists(candidate: string, label: string): Promise<string> {
  const resolved = path.resolve(candidate)
  const details = await stat(resolved).catch(() => null)
  if (!details || !details.isDirectory()) {
    throw new Error(`${label} directory not found: ${resolved}`)
  }
  return resolved
}

async function resolveProjectDirectory(userId: string, projectPath?: string | null): Promise<string> {
  const direct = normalizeString(projectPath)
  if (direct) {
    return await ensureDirectoryExists(direct, 'Project')
  }

  const preferences = await redis.getProjectPreferences(userId).catch(() => null)
  const fallback = normalizeString(preferences?.default_workspace_path)
  if (!fallback) {
    throw new Error('CLI tool is set to use the project directory, but no active project or default workspace is available')
  }

  return await ensureDirectoryExists(fallback, 'Default workspace')
}

async function findExecutableInPath(command: string): Promise<string | null> {
  const rawPath = process.env.PATH ?? ''
  const pathEntries = rawPath.split(path.delimiter).filter((entry) => entry.length > 0)
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : ['']

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === 'win32' ? `${command}${extension}` : command)
      try {
        await access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Keep searching.
      }
    }
  }

  return null
}

async function resolveCommandExecutable(command: string, cwd?: string): Promise<string> {
  const trimmed = command.trim()
  if (trimmed.includes(path.sep) || trimmed.startsWith('.')) {
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd ?? process.cwd(), trimmed)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      throw new Error(`CLI executable not found or not executable: ${candidate}`)
    }
  }

  const fromPath = await findExecutableInPath(trimmed)
  if (!fromPath) {
    throw new Error(`CLI executable not found in PATH: ${trimmed}`)
  }
  return fromPath
}

async function resolveSavedKeyValue(savedKeyRef: string, userId: string): Promise<string> {
  const normalized = normalizeApiKeyServiceName(savedKeyRef)
  const stored = await apiKeyService.retrieve(normalized, userId).catch(() => null)
  const trimmed = stored?.trim()
  if (!trimmed) {
    throw new Error(`Missing saved API key "${normalized}" for CLI tool`)
  }
  return trimmed
}

async function resolveCliToolRuntimeContext(params: {
  userId: string
  record: CliToolRecord
  projectPath?: string | null
}): Promise<{ executable: string; cwd?: string; env: Record<string, string> }> {
  const cwdPolicy = params.record.cwdPolicy ?? 'none'
  let cwd: string | undefined
  if (cwdPolicy === 'fixed') {
    cwd = await ensureDirectoryExists(params.record.cwdValue!, 'CLI fixed cwd')
  } else if (cwdPolicy === 'project') {
    cwd = await resolveProjectDirectory(params.userId, params.projectPath)
  }

  const executable = await resolveCommandExecutable(params.record.executable, cwd)
  const env: Record<string, string> = {}
  for (const entry of params.record.envRefs ?? []) {
    env[entry.envVar] = await resolveSavedKeyValue(entry.savedKeyRef, params.userId)
  }

  return { executable, cwd, env }
}

function collectPathFieldValues(
  inputSchema: CliToolInputSchema,
  input: Record<string, any>,
  cwd?: string
): string[] {
  const paths: string[] = []
  for (const [fieldName, field] of Object.entries(inputSchema.properties)) {
    if (!PATH_FIELD_FORMATS.has(field.format ?? 'plain')) continue
    const value = input[fieldName]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
          paths.push(path.resolve(cwd ?? process.cwd(), entry))
        }
      }
      continue
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      paths.push(path.resolve(cwd ?? process.cwd(), value))
    }
  }
  return paths
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function enforceAllowedPaths(record: CliToolRecord, input: Record<string, any>, cwd?: string): void {
  if (!record.allowedPaths || record.allowedPaths.length === 0) return
  const roots = record.allowedPaths.map((entry) => path.resolve(entry))
  const pathValues = collectPathFieldValues(record.inputSchema, input, cwd)
  for (const candidate of pathValues) {
    if (!roots.some((root) => isPathWithinRoot(candidate, root))) {
      throw new Error(`Path "${candidate}" is outside the CLI tool's allowed paths`)
    }
  }
}

function extractJsonCandidateFromText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  const firstBrace = trimmed.search(/[{\[]/)
  if (firstBrace === -1) return null
  return trimmed.slice(firstBrace).trim()
}

function parseCliToolOutput(record: CliToolRecord, stdout: string): { parsedOutput?: unknown } {
  if (record.parseMode === 'text') {
    return {}
  }

  const candidate =
    record.parseMode === 'json'
      ? stdout.trim()
      : extractJsonCandidateFromText(stdout) ?? ''

  if (!candidate) {
    throw new Error('CLI tool did not produce parsable JSON output')
  }

  try {
    return { parsedOutput: JSON.parse(candidate) }
  } catch (error) {
    throw new Error(
      `CLI tool JSON parse failed: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

async function runCliProcess(params: {
  executable: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  timeoutMs: number
}): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}> {
  const startedAt = Date.now()
  return await new Promise((resolve, reject) => {
    const child = spawn(params.executable, params.args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: { exitCode: number | null; stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      resolve({
        ...result,
        durationMs: Date.now() - startedAt
      })
    }

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish({
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}Process timed out after ${params.timeoutMs}ms`
      })
    }, params.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_CLI_TOOL_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_CLI_TOOL_OUTPUT_CHARS)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_CLI_TOOL_OUTPUT_CHARS) {
        stderr = stderr.slice(0, MAX_CLI_TOOL_OUTPUT_CHARS)
      }
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      finish({
        exitCode: typeof code === 'number' ? code : null,
        stdout,
        stderr
      })
    })
  })
}

async function recordCliToolAudit(entry: CliToolExecutionAuditEntry): Promise<void> {
  try {
    await redis.execute(async (client) => {
      const auditKey = buildCliToolAuditKey(entry.userId, entry.id)
      const recentKey = `recent_cli_tool_executions:${entry.userId}`
      await client.json.set(auditKey, '$', entry as any)
      await client.expire(auditKey, CLI_TOOL_AUDIT_TTL_SECONDS)
      await client.lPush(recentKey, auditKey)
      await client.lTrim(recentKey, 0, 49)
      await client.expire(recentKey, CLI_TOOL_AUDIT_TTL_SECONDS)
    })
  } catch (error) {
    console.warn('[CliToolRegistry] Failed to record CLI tool audit entry:', error)
  }
}

export async function validateCliTool(
  userId: string,
  toolId: string,
  options: { projectPath?: string | null; persist?: boolean } = {}
): Promise<CliToolValidationResult> {
  const record = await getCliTool(userId, toolId)
  if (!record) {
    throw new Error(`CLI tool "${toolId}" was not found`)
  }

  const runtime = await resolveCliToolRuntimeContext({
    userId,
    record,
    projectPath: options.projectPath ?? null
  })

  let result: CliToolValidationResult
  if (record.validationInput) {
    const validatedInput = validateCliToolInput(record.inputSchema, record.validationInput)
    enforceAllowedPaths(record, validatedInput, runtime.cwd)
    const args = compileCliToolArgs(record, validatedInput)
    const execution = await runCliProcess({
      executable: runtime.executable,
      args,
      cwd: runtime.cwd,
      env: runtime.env,
      timeoutMs: record.timeoutMs
    })
    if (execution.exitCode !== 0) {
      result = {
        success: false,
        toolId: record.toolId,
        executable: runtime.executable,
        args,
        cwd: runtime.cwd,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        summary: 'Validation command exited with a non-zero status',
        error: execution.stderr.trim() || execution.stdout.trim() || 'Validation command failed'
      }
    } else {
      try {
        parseCliToolOutput(record, execution.stdout)
        result = {
          success: true,
          toolId: record.toolId,
          executable: runtime.executable,
          args,
          cwd: runtime.cwd,
          exitCode: execution.exitCode,
          stdout: execution.stdout,
          stderr: execution.stderr,
          summary: 'Validation input executed successfully'
        }
      } catch (error) {
        result = {
          success: false,
          toolId: record.toolId,
          executable: runtime.executable,
          args,
          cwd: runtime.cwd,
          exitCode: execution.exitCode,
          stdout: execution.stdout,
          stderr: execution.stderr,
          summary: 'Validation output did not match the declared parse contract',
          error: error instanceof Error ? error.message : 'Output parse failed'
        }
      }
    }
  } else if (record.helpCommand && record.helpCommand.length > 0) {
    const execution = await runCliProcess({
      executable: runtime.executable,
      args: record.helpCommand,
      cwd: runtime.cwd,
      env: runtime.env,
      timeoutMs: Math.min(record.timeoutMs, 30_000)
    })
    result = {
      success: execution.exitCode === 0,
      toolId: record.toolId,
      executable: runtime.executable,
      args: record.helpCommand,
      cwd: runtime.cwd,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      summary:
        execution.exitCode === 0
          ? 'Executable and help command completed successfully'
          : 'Help command failed',
      ...(execution.exitCode === 0
        ? {}
        : {
            error: execution.stderr.trim() || execution.stdout.trim() || 'Help command failed'
          })
    }
  } else {
    result = {
      success: true,
      toolId: record.toolId,
      executable: runtime.executable,
      cwd: runtime.cwd,
      summary: 'Executable resolved successfully'
    }
  }

  if (options.persist !== false) {
    await updateCliTool(userId, record.toolId, {
      lastValidatedAt: new Date().toISOString(),
      lastValidationStatus: result.success ? 'passed' : 'failed',
      lastValidationError: result.success ? null : result.error ?? result.summary,
      lastValidationSummary: result.summary
    })
  }

  return result
}

export async function executeCliTool(params: CliToolExecutionParams): Promise<CliToolExecutionResult> {
  const { toolIds: selectedToolIds } = await resolveCliToolSelectionScope(params)
  const selectedSet = new Set(selectedToolIds)
  const record = await getCliTool(params.userId, params.toolId)
  if (!record) {
    return {
      success: false,
      toolId: params.toolId,
      blocked: true,
      code: 'NOT_FOUND',
      error: `CLI tool "${params.toolId}" was not found`
    }
  }
  if (!selectedSet.has(record.toolId)) {
    return {
      success: false,
      toolId: record.toolId,
      title: record.title,
      blocked: true,
      code: 'OUT_OF_SCOPE',
      error: `CLI tool "${record.toolId}" is outside the active agent tool scope`,
      riskLevel: record.riskLevel
    }
  }
  if (record.status !== 'active') {
    return {
      success: false,
      toolId: record.toolId,
      title: record.title,
      blocked: true,
      code: 'INVALID_STATUS',
      error: `CLI tool "${record.toolId}" is ${record.status}`,
      riskLevel: record.riskLevel
    }
  }

  if (record.riskLevel !== 'safe' && params.allowRisky !== true) {
    return {
      success: false,
      toolId: record.toolId,
      title: record.title,
      blocked: true,
      requiresApproval: true,
      code: 'REQUIRES_APPROVAL',
      error: `CLI tool "${record.toolId}" has ${record.riskLevel} risk and requires explicit approval before execution`,
      riskLevel: record.riskLevel
    }
  }

  let validatedInput: Record<string, any>
  try {
    validatedInput = validateCliToolInput(record.inputSchema, params.input ?? {})
  } catch (error) {
    return {
      success: false,
      toolId: record.toolId,
      title: record.title,
      blocked: true,
      code: 'INPUT_VALIDATION_FAILED',
      error: error instanceof Error ? error.message : 'CLI input validation failed',
      riskLevel: record.riskLevel
    }
  }

  try {
    const runtime = await resolveCliToolRuntimeContext({
      userId: params.userId,
      record,
      projectPath: params.projectPath ?? null
    })
    enforceAllowedPaths(record, validatedInput, runtime.cwd)
    const args = compileCliToolArgs(record, validatedInput)
    const execution = await runCliProcess({
      executable: runtime.executable,
      args,
      cwd: runtime.cwd,
      env: runtime.env,
      timeoutMs: record.timeoutMs
    })
    const auditId = crypto.randomUUID()

    if (execution.exitCode !== 0) {
      await recordCliToolAudit({
        id: auditId,
        userId: params.userId,
        agentId: params.agentId ?? null,
        sessionId: params.sessionId ?? null,
        toolId: record.toolId,
        title: record.title,
        riskLevel: record.riskLevel,
        success: false,
        blocked: false,
        executable: runtime.executable,
        args,
        cwd: runtime.cwd,
        outputMode: record.outputMode,
        parseMode: record.parseMode,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        createdAt: new Date().toISOString(),
        error: execution.stderr.trim() || execution.stdout.trim() || 'CLI tool exited non-zero'
      })
      return {
        success: false,
        toolId: record.toolId,
        title: record.title,
        executable: runtime.executable,
        args,
        cwd: runtime.cwd,
        outputMode: record.outputMode,
        parseMode: record.parseMode,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
        auditId,
        code: 'EXECUTION_FAILED',
        error: execution.stderr.trim() || execution.stdout.trim() || 'CLI tool exited non-zero',
        riskLevel: record.riskLevel
      }
    }

    let parsedOutput: unknown
    try {
      parsedOutput = parseCliToolOutput(record, execution.stdout).parsedOutput
    } catch (error) {
      await recordCliToolAudit({
        id: auditId,
        userId: params.userId,
        agentId: params.agentId ?? null,
        sessionId: params.sessionId ?? null,
        toolId: record.toolId,
        title: record.title,
        riskLevel: record.riskLevel,
        success: false,
        blocked: false,
        executable: runtime.executable,
        args,
        cwd: runtime.cwd,
        outputMode: record.outputMode,
        parseMode: record.parseMode,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        createdAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Output parse failed'
      })
      return {
        success: false,
        toolId: record.toolId,
        title: record.title,
        executable: runtime.executable,
        args,
        cwd: runtime.cwd,
        outputMode: record.outputMode,
        parseMode: record.parseMode,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
        auditId,
        code: 'OUTPUT_PARSE_FAILED',
        error: error instanceof Error ? error.message : 'Output parse failed',
        riskLevel: record.riskLevel
      }
    }

    await recordCliToolAudit({
      id: auditId,
      userId: params.userId,
      agentId: params.agentId ?? null,
      sessionId: params.sessionId ?? null,
      toolId: record.toolId,
      title: record.title,
      riskLevel: record.riskLevel,
      success: true,
      blocked: false,
      executable: runtime.executable,
      args,
      cwd: runtime.cwd,
      outputMode: record.outputMode,
      parseMode: record.parseMode,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      createdAt: new Date().toISOString()
    })
    return {
      success: true,
      toolId: record.toolId,
      title: record.title,
      executable: runtime.executable,
      args,
      cwd: runtime.cwd,
      outputMode: record.outputMode,
      parseMode: record.parseMode,
      exitCode: execution.exitCode ?? 0,
      stdout: execution.stdout,
      stderr: execution.stderr,
      ...(parsedOutput !== undefined ? { parsedOutput } : {}),
      durationMs: execution.durationMs,
      auditId,
      riskLevel: record.riskLevel
    }
  } catch (error) {
    return {
      success: false,
      toolId: record.toolId,
      title: record.title,
      blocked: true,
      code: 'POLICY_BLOCKED',
      error: error instanceof Error ? error.message : 'CLI tool policy check failed',
      riskLevel: record.riskLevel
    }
  }
}
