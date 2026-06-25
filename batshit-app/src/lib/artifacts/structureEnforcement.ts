export const ENFORCE_BATSHIT_ARTIFACT_STRUCTURE_KEY = 'enforce_batshit_artifact_structure'

export const DEFAULT_ARTIFACT_SCAFFOLD_CONTENT = '<!-- New artifact - ready for AI to create! -->'

export type ArtifactStructureIssueCode =
  | 'BUILDER_KIT_REQUIRED'
  | 'FABRIC_RUNTIME_REQUIRED'
  | 'FABRIC_BINDINGS_REQUIRED'

export type ArtifactStructureValidationIssue = {
  code: ArtifactStructureIssueCode
  message: string
}

export type ArtifactStructureValidationResult = {
  ok: boolean
  enforced: boolean
  usesBuilderKit: boolean
  usesStandardControls: boolean
  hasFabricRuntimeContract: boolean
  hasFabricBindings: boolean
  runOnly: boolean
  fabricFieldIds: string[]
  issues: ArtifactStructureValidationIssue[]
}

const BUILDER_KIT_PATTERNS = [
  /window\.batshit\.builder\./,
  /(?:const|let|var)\s+builder\s*=\s*window\.batshit\.builder\b/,
  /(?:const|let|var)\s*\{\s*builder\s*\}\s*=\s*window\.batshit\b/,
  /\bbuilder\.(?:form|output|action|createRoot|mount)\b/
]

const STANDARD_CONTROLS_PATTERNS = [
  /window\.batshit\.builder\.action\.standardControls\s*\(/,
  /\bbuilder\.action\.standardControls\s*\(/,
  /\bstandardControls\s*\(/
]

const FABRIC_BINDING_PATTERNS = [
  /\bfabricId\s*:/,
  /\bfabricId\s*=/,
  /["']fabricId["']\s*:/,
  /data-fabric-id/i
]

function asMetadataRecord(metadata: Record<string, any> | null | undefined): Record<string, any> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  return metadata
}

export function isBatshitArtifactStructureEnforced(
  metadata: Record<string, any> | null | undefined
): boolean {
  const record = asMetadataRecord(metadata)
  if (record[ENFORCE_BATSHIT_ARTIFACT_STRUCTURE_KEY] === false) return false
  if (record.enforceBatshitArtifactStructure === false) return false
  return true
}

export function applyBatshitArtifactStructureSetting(
  metadata: Record<string, any> | null | undefined,
  enforced: boolean
): Record<string, any> {
  return {
    ...asMetadataRecord(metadata),
    [ENFORCE_BATSHIT_ARTIFACT_STRUCTURE_KEY]: enforced
  }
}

export function hasFabricFieldsMetadata(
  metadata: Record<string, any> | null | undefined
): boolean {
  return getFabricFieldIds(metadata).length > 0
}

export function isRunOnlyMetadata(metadata: Record<string, any> | null | undefined): boolean {
  const record = asMetadataRecord(metadata)
  return record.run_only === true || record.runOnly === true
}

export function artifactRuntimeSchemaReady(
  metadata: Record<string, any> | null | undefined
): boolean {
  return hasFabricFieldsMetadata(metadata) || isRunOnlyMetadata(metadata)
}

export function getFabricFieldIds(
  metadata: Record<string, any> | null | undefined
): string[] {
  const record = asMetadataRecord(metadata)
  const fields = Array.isArray(record.fabric_fields) ? record.fabric_fields : []
  return fields
    .map((field) => (typeof field?.fabricId === "string" ? field.fabricId.trim() : ''))
    .filter(Boolean)
}

export function artifactStructureValidationCanBeDeferred(
  content: string | null | undefined,
  mode: 'edit' | 'published'
): boolean {
  if (mode !== 'edit') return false
  const trimmed = typeof content === 'string' ? content.trim() : ''
  return trimmed.length === 0 || trimmed === DEFAULT_ARTIFACT_SCAFFOLD_CONTENT
}

function detectBuilderKitUsage(content: string): boolean {
  return BUILDER_KIT_PATTERNS.some((pattern) => pattern.test(content))
}

function detectStandardControlsUsage(content: string): boolean {
  return STANDARD_CONTROLS_PATTERNS.some((pattern) => pattern.test(content))
}

function detectFabricBindings(
  content: string,
  metadata: Record<string, any> | null | undefined
): { ok: boolean; missingIds: string[] } {
  if (isRunOnlyMetadata(metadata)) {
    return { ok: true, missingIds: [] }
  }

  const fabricFieldIds = getFabricFieldIds(metadata)
  if (fabricFieldIds.length === 0) {
    return { ok: false, missingIds: [] }
  }

  const hasBindingToken = FABRIC_BINDING_PATTERNS.some((pattern) => pattern.test(content))
  const missingIds = fabricFieldIds.filter((fabricId) => !content.includes(fabricId))
  return {
    ok: hasBindingToken && missingIds.length === 0,
    missingIds
  }
}

export function validateBatshitArtifactStructure(
  content: string | null | undefined,
  metadata: Record<string, any> | null | undefined
): ArtifactStructureValidationResult {
  const normalizedContent = typeof content === 'string' ? content : ''
  const enforced = isBatshitArtifactStructureEnforced(metadata)
  const usesBuilderKit = detectBuilderKitUsage(normalizedContent)
  const usesStandardControls = detectStandardControlsUsage(normalizedContent)
  const hasFabricRuntimeContract = artifactRuntimeSchemaReady(metadata)
  const { ok: hasFabricBindings, missingIds } = detectFabricBindings(normalizedContent, metadata)
  const runOnly = isRunOnlyMetadata(metadata)
  const fabricFieldIds = getFabricFieldIds(metadata)
  const issues: ArtifactStructureValidationIssue[] = []

  if (!usesBuilderKit) {
    issues.push({
      code: 'BUILDER_KIT_REQUIRED',
      message:
        'Use Batshit Builder Kit primitives in the artifact HTML (`window.batshit.builder.*`). Raw hand-rolled controls are blocked while structure enforcement is on.'
    })
  }

  if (!hasFabricRuntimeContract) {
    issues.push({
      code: 'FABRIC_RUNTIME_REQUIRED',
      message:
        'Declare a Fabric runtime contract before saving. Add `metadata.fabric_fields` for typed fields, or set `metadata.run_only=true` for a trigger-only artifact.'
    })
  }

  if (hasFabricRuntimeContract && !runOnly && !hasFabricBindings) {
    const missingSuffix =
      missingIds.length > 0
        ? ` Missing or mismatched fabricId values: ${missingIds.join(', ')}.`
        : ''
    issues.push({
      code: 'FABRIC_BINDINGS_REQUIRED',
      message:
        'The artifact HTML must include matching `fabricId` bindings for every declared Fabric field so Batshit can wire agent inputs into the UI.' +
        missingSuffix
    })
  }

  return {
    ok: issues.length === 0,
    enforced,
    usesBuilderKit,
    usesStandardControls,
    hasFabricRuntimeContract,
    hasFabricBindings,
    runOnly,
    fabricFieldIds,
    issues
  }
}

export function buildArtifactStructureEnforcementMessage(
  validation: ArtifactStructureValidationResult
): string {
  const lines = [
    'Artifact save blocked: "Enforce Batshit Artifact Structure" is enabled.',
    ...validation.issues.map((issue) => `- ${issue.message}`),
    'Turn the toggle off in Settings -> Artifacts only if you intentionally want to save a manual/raw artifact without Builder Kit + Fabric.'
  ]
  return lines.join('\n')
}

export function buildArtifactStandardControlsAdvisory(): string {
  return 'No `window.batshit.builder.action.standardControls()` action bar was detected. Result artifacts should usually include Share to Chat, Save to Clip Vault, and Download unless the artifact is intentionally trigger-only or otherwise special-case.'
}
