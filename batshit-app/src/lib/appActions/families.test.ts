import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { APP_ACTION_FAMILIES, describeAppActionFamily, discoverAppActionFamilies } from './families'
import { P1_APP_ACTION_DESCRIPTORS } from './catalog'
import { SETTINGS_ACTION_DESCRIPTORS } from './settings/fields'
import { SUPPLIED_FILE_ACTION_CATALOG } from './imports/catalog'
import { VOICE_ONLY_ACTION_DESCRIPTORS } from './voice/quickActionExecutor'
import { parseSettingsAction } from './settingsContract'

describe('App Actions family assembly is metadata, not authority', () => {
  it('references the single owner catalogs and offers bounded progressive discovery', () => {
    assert.equal(APP_ACTION_FAMILIES.views, P1_APP_ACTION_DESCRIPTORS)
    assert.equal(APP_ACTION_FAMILIES.settings, SETTINGS_ACTION_DESCRIPTORS)
    assert.equal(APP_ACTION_FAMILIES.suppliedFiles, SUPPLIED_FILE_ACTION_CATALOG)
    assert.equal(APP_ACTION_FAMILIES.voice, VOICE_ONLY_ACTION_DESCRIPTORS)
    assert.throws(() => describeAppActionFamily('developer', 'goon.import_file'), /unsupported_action/)
    assert.throws(() => describeAppActionFamily('developer', 'goon.replace_vrm_file'), /unsupported_action/)
    const first = discoverAppActionFamilies('developer', { limit: 5 })
    assert.equal(first.count, 8)
    assert.equal(first.nextOffset, 5)
    const second = discoverAppActionFamilies('developer', { offset: first.nextOffset! })
    assert.equal(second.nextOffset, null)
    assert.equal(new Set([...first.actions, ...second.actions].map(action => action.id)).size, 8)
    assert.ok(new TextEncoder().encode(JSON.stringify(second)).byteLength < 16_384)
    assert.throws(() => discoverAppActionFamilies('developer', { limit: 6 }), /invalid_discovery/)
    assert.throws(() => discoverAppActionFamilies('agent', { query: 'x'.repeat(129) }), /invalid_discovery/)
    assert.throws(() => discoverAppActionFamilies('agent', { offset: -1 }), /invalid_discovery/)
    first.actions[0].label = 'mutated'
    assert.notEqual(discoverAppActionFamilies('developer').actions[0].label, 'mutated')
  })
  it('never offers bytes or speech execution to agents, and keeps fixed Settings risks', () => {
    const agent = discoverAppActionFamilies('agent', { query: 'import' })
    assert.equal(agent.count, 0)
    assert.throws(() => describeAppActionFamily('agent', 'avatar.import_file'), /unsupported_action/)
    assert.throws(() => describeAppActionFamily('developer', 'settings.agent.memory.update'), /unsupported_action/)
    assert.throws(() => describeAppActionFamily('agent', 'reply.stop'), /unsupported_action/)
    const memory = describeAppActionFamily('agent', 'settings.agent.memory.update')
    assert.equal(memory.risk, 'confirm')
    assert.equal(memory.execution.controlId, 'sys.ui.settings_agent_memory_update')
    assert.equal(describeAppActionFamily('agent', 'settings.agent.identity.update').risk, 'safe')
    const bytes = describeAppActionFamily('developer', 'clip.import_files')
    assert.equal(bytes.risk, 'confirm')
    assert.equal(bytes.execution.transport, 'supplied_bytes')
    assert.equal(bytes.execution.controlId, undefined)
    const speech = discoverAppActionFamilies('speech')
    assert.equal(speech.count, 2)
    assert.equal(Object.keys(speech.projection!).length, 6)
    assert.ok(speech.actions.every(action => action.risk === 'restricted' && action.execution.transport === 'voice_owner_only'))
    assert.equal(speech.projection!.close_goon_dock, 'goon.hide')
  })
  it('uses exact leaf validation before consent and cannot turn an admitted action into an arbitrary writer', () => {
    const expectedRevision = `sha256:${'a'.repeat(64)}`
    assert.deepEqual(parseSettingsAction('settings.agent.memory.update', { subjectAgentId: 'primary', expectedRevision, changes: { onMyMind: 0, recallLingerTurns: 8 } }), {
      subjectAgentId: 'primary', expectedRevision, changes: { onMyMind: 0, recallLingerTurns: 8 }
    })
    assert.throws(() => parseSettingsAction('settings.agent.memory.update', { subjectAgentId: 'primary', expectedRevision, changes: { permissions: true } }), /invalid_arguments/)
    assert.throws(() => parseSettingsAction('settings.agent.memory.update', { subjectAgentId: 'primary', expectedRevision, changes: { recalled: 20_001 } }), /invalid_recalled/)
    assert.throws(() => parseSettingsAction('settings.agent.identity.update', { subjectAgentId: 'primary', expectedRevision, changes: { displayName: 'Name' }, risk: 'safe' }), /invalid_arguments/)
    assert.throws(() => parseSettingsAction('settings.inspect', { tab: 'tools', subjectAgentId: 'other' }), /invalid_subject_for_tab/)
    assert.throws(() => parseSettingsAction('arbitrary.action' as any, {}), /unsupported_action/)
  })
})
