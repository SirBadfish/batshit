import { redis } from '$lib/server/redis'
import { MEMORY_CONFIG_KEY } from '$lib/server/services/memory/memoryKeys'
import type { ArtifactModelConfig, ArtifactModelRole } from '$lib/types/artifacts'
import { normalizeArtifactModelConfig } from '$lib/utils/artifactModelConfig'
import {
  normalizeAgentAutoCompactSettings,
  normalizeGlobalAutoCompactSettings
} from '$lib/utils/contextCompaction'
import { resolveMemoryWindowSettings } from '$lib/utils/memoryControl'

/**
 * BL-483: every place a saved model preset's id is stored. Deleting a preset one of these still
 * names broke it with an error that pointed somewhere else (a Subagent call, every memory save
 * and recall, automatic compaction, graduation, an artifact's model), so the delete route
 * refuses while any is left and names each one.
 */
export type ModelPresetReferenceKind =
  | 'agent_model'
  | 'subagent_model'
  | 'agent_auto_compact'
  | 'agent_memory_summary'
  | 'global_auto_compact'
  | 'memory_embedding'
  | 'artifact_model'

export interface ModelPresetReference {
  kind: ModelPresetReferenceKind
  /** The agent, Subagent, or artifact that names the preset; null for an instance setting. */
  ownerId: string | null
  /** Where the user changes it, in words. */
  label: string
}

/** Every role an artifact's model setting can name a preset for (the type's full list). */
const ARTIFACT_MODEL_ROLES = {
  primary: true,
  visual: true,
  audio: true,
  utility: true
} satisfies Record<ArtifactModelRole, true>

function sameId(value: unknown, presetId: string): boolean {
  return typeof value === 'string' && value.trim() === presetId
}

function unwrapJson(value: unknown): Record<string, any> | null {
  const record = Array.isArray(value) ? value[0] : value
  return record && typeof record === 'object' ? (record as Record<string, any>) : null
}

function recordName(record: Record<string, any>, fallback: string): string {
  const name = record.displayName ?? record.name
  return typeof name === 'string' && name.trim() ? name.trim() : fallback
}

/**
 * The model roles an artifact's saved setting points at this preset, read the way the artifact
 * runtime reads it (`normalizeArtifactModelConfig`: a basic setting uses its primary role only).
 */
function artifactPresetRoles(artifact: Record<string, any>, presetId: string): ArtifactModelRole[] {
  const config = normalizeArtifactModelConfig(
    (artifact.model_config ?? null) as ArtifactModelConfig | null,
    typeof artifact.model === 'string' ? artifact.model : null
  )
  return (Object.keys(ARTIFACT_MODEL_ROLES) as ArtifactModelRole[]).filter((role) => {
    const roleConfig = role === 'primary' ? config.primary : config[role]
    return roleConfig?.source === 'preset' && sameId(roleConfig.presetId, presetId)
  })
}

export async function findModelPresetReferences(
  userId: string,
  modelPresetId: string
): Promise<ModelPresetReference[]> {
  const presetId = modelPresetId.trim()
  const references: ModelPresetReference[] = []

  for (const agent of await redis.getAgents(userId)) {
    const record = agent as unknown as Record<string, any>
    const name = recordName(record, agent.id)
    if (sameId(agent.primary_model_preset_id, presetId)) {
      references.push({ kind: 'agent_model', ownerId: agent.id, label: `${name}'s model` })
    }
    const compact = normalizeAgentAutoCompactSettings(record.auto_compact_settings)
    if (compact.modelMode === 'preset' && sameId(compact.modelPresetId, presetId)) {
      references.push({ kind: 'agent_auto_compact', ownerId: agent.id, label: `${name}'s Auto Compact model` })
    }
    // THE memory_window read rule: a summary preset counts only in `preset` mode.
    if (sameId(resolveMemoryWindowSettings(record).summaryModelPresetId, presetId)) {
      references.push({ kind: 'agent_memory_summary', ownerId: agent.id, label: `${name}'s memory summary model` })
    }
  }

  for (const subagentId of await redis.sMembers(`user:${userId}:subagents`)) {
    const subagent = unwrapJson(await redis.json.get(`subagent:${subagentId}`))
    if (subagent && sameId(subagent.primary_model_preset_id, presetId)) {
      const name = recordName(subagent, subagentId)
      references.push({ kind: 'subagent_model', ownerId: subagentId, label: `the Subagent ${name}'s model` })
    }
  }

  const userSettings = await redis.getUserSettings(userId)
  const globalCompact = normalizeGlobalAutoCompactSettings(
    (userSettings as Record<string, any> | null)?.global_auto_compact_settings
  )
  if (globalCompact.modelMode === 'preset' && sameId(globalCompact.modelPresetId, presetId)) {
    references.push({
      kind: 'global_auto_compact',
      ownerId: null,
      label: 'the default Auto Compact model (Settings → Admin)'
    })
  }

  const memoryConfig = unwrapJson(await redis.json.get(MEMORY_CONFIG_KEY))
  const embedding = memoryConfig?.embedding
  if (embedding?.lane === 'preset' && sameId(embedding.preset?.presetId, presetId)) {
    references.push({
      kind: 'memory_embedding',
      ownerId: null,
      label: "the Memory System's embedding model (Settings → Memory)"
    })
  }

  for (const artifactId of await redis.sMembers(`user:${userId}:artifacts`)) {
    const artifact = unwrapJson(await redis.json.get(`artifact:${artifactId}`))
    if (!artifact) continue
    for (const role of artifactPresetRoles(artifact, presetId)) {
      const name = recordName(artifact, artifactId)
      references.push({ kind: 'artifact_model', ownerId: artifactId, label: `the artifact "${name}" (${role} model)` })
    }
  }

  return references
}

export function formatModelPresetReferenceMessage(references: ModelPresetReference[]): string {
  return `This model preset is still used by ${references.map((reference) => reference.label).join('; ')}. Pick a different model in each of those places before deleting it.`
}
