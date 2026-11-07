import { projectAutoCompact } from './settings/autoCompactAdapter'
import { projectConfiguredTts } from './settings/configuredTtsAdapter'
import { projectModelSelection } from './settings/modelSelectionAdapter'
import type { AdapterContext } from './managementTypes'
export type { AdapterContext, AdapterCommitContext } from './managementTypes'
import type { SettingsFamily } from '$lib/appActions/settings/validation'
import type { SettingsReportId } from '$lib/appActions/settings/reportContract'
import type { AppActionsSemanticId } from '$lib/appActions/settings/definitions'
import { projectIdentity, projectMemory, type Group } from './settings/scalarProjection'
import { projectApiPresentation, projectApiRetention } from './settings/apiReasoningAdapter'
import { projectInstructions } from './settings/instructionAdapter'
import type { BoundedInstructionTextDescriptor } from './settings/instructionTextSnapshot'
import type { SettingsSubjectEntry } from './settings/subjects'

/** Finite server bindings; labels/schema/effect/category metadata stays in definitions.ts. */
export const SUBJECT_SETTINGS_BINDINGS = Object.freeze({
  'agent.voice.tts-selection': { family: null, project: projectConfiguredTts },
  'agent.context.auto-compact': { family: null, project: projectAutoCompact },
  'agent.instructions': { family: null, project(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
    const projected = projectInstructions(entry, record)
    return projected.status === 'unavailable' ? projected : Object.freeze({ id: 'agent.instructions', status: 'available', fields: Object.freeze({
      customPrompt: (record.__instructionMetadata as BoundedInstructionTextDescriptor | undefined) ?? projected.customPrompt,
      includeGlobalPrompt: projected.includeGlobalPrompt }) })
  } },
  'agent.model.selection': { family: null, project: projectModelSelection },
  'agent.model.preset-copy': { family: null, project(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
    return Object.freeze({ ...projectModelSelection(entry, record), id: 'agent.model.preset-copy' })
  } },
  'agent.identity': { family: 'identity', project: projectIdentity },
  'agent.memory.preferences': { family: 'memory', project: projectMemory },
  'agent.reasoning.presentation': { family: 'api-presentation', project: projectApiPresentation },
  'agent.reasoning.retention': { family: 'api-retention', project: projectApiRetention }
} as const satisfies Record<SettingsReportId, {
  family: SettingsFamily | null
  project(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group
}>)

/** Fixed leaf imports retain singleton domain owners; model input never supplies an executor. */
export const MANAGEMENT_ADAPTER_BINDINGS = Object.freeze({
  'agent.voice.tts-selection': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.voice.tts-selection'] },
  'agent.context.auto-compact': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.context.auto-compact'] },
  'agent.instructions': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.instructions'] },
  'agent.model.selection': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.model.selection'] },
  'agent.model.preset-copy': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.model.preset-copy'] },
  'agent.identity': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.identity'] },
  'agent.memory.preferences': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.memory.preferences'] },
  'agent.reasoning.presentation': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.reasoning.presentation'] },
  'agent.reasoning.retention': { kind: 'subjects' as const, ...SUBJECT_SETTINGS_BINDINGS['agent.reasoning.retention'] },
  'agent.skills.access': {
    kind: 'alias-access' as const,
    async read(...args: Parameters<typeof import('./settings/skillAccessReport').readSkillAccess>) {
      return (await import('./settings/skillAccessReport')).readSkillAccess(...args)
    },
    async prepare(...args: Parameters<typeof import('./settings/skillAccessOperations').prepareSkillAccessChange>) {
      return (await import('./settings/skillAccessOperations')).prepareSkillAccessChange(...args)
    },
    async commit(...args: Parameters<typeof import('./settings/skillAccessOperations').commitSkillAccessChange>) {
      return (await import('./settings/skillAccessOperations')).commitSkillAccessChange(...args)
    }
  },
  'runtime.inspection': {
    kind: 'instance-read' as const,
    async read(ctx: AdapterContext) { return (await import('./runtimeInspection')).readRuntimeStatus(ctx) }
  }
} satisfies Record<AppActionsSemanticId, { kind: 'subjects' | 'alias-access' | 'instance-read' } & Record<string, unknown>>)
