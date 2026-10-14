import { afterEach, describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { registerSettingsFileShell } from './settingsFileOwners'
import { executeSuppliedFileAction, suppliedFileActionAvailability } from './imports/registry'
import { emptyImportReceipt } from './imports/contracts'
import type { ActionContext, SettingsPanelHandle } from './owners'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
describe('Supplied file Settings shell selection', () => {
  it('ignores hidden mounted shells and refuses two visible shells or the wrong current entity/tab', async () => {
    let firstOpen = false, secondOpen = false, tab = 'agents', target = 'primary', effects = 0
    const panel: SettingsPanelHandle = { readAppActionState: () => ({ busy: false, dirty: false, entityId: target }),
      suppliedAvatarAvailability: args => args.entityId === target ? 'available' : 'target_mismatch',
      importAppActionAvatar: async () => { effects++; return { status: 'completed', import: { ...emptyImportReceipt(), staged: 'confirmed' } } } }
    cleanup.push(registerSettingsFileShell({ visible: () => firstOpen, tab: () => tab,
      panel: () => ({ readAppActionState: () => ({ mounted: true, error: null, panel }) }), pendingHumanAction: () => false }))
    cleanup.push(registerSettingsFileShell({ visible: () => secondOpen, tab: () => tab,
      panel: () => ({ readAppActionState: () => ({ mounted: true, error: null, panel }) }), pendingHumanAction: () => false }))
    const args = { entityType: 'agent', entityId: 'primary' }
    assert.equal(suppliedFileActionAvailability('avatar.import_file', args), 'unsupported_document')
    firstOpen = true
    assert.equal(suppliedFileActionAvailability('avatar.import_file', args), 'available')
    secondOpen = true
    assert.equal(suppliedFileActionAvailability('avatar.import_file', args), 'ambiguous_settings_owner')
    secondOpen = false; tab = 'groups'
    assert.equal(suppliedFileActionAvailability('avatar.import_file', args), 'unsupported_target')
    tab = 'agents'; target = 'other'
    assert.equal(suppliedFileActionAvailability('avatar.import_file', args), 'target_mismatch')
    target = 'primary'
    const context: ActionContext = { sessionId: 'chat', signal: new AbortController().signal, check() {}, effect() {}, report() {}, wait: async read => read()! }
    const result = await executeSuppliedFileAction('avatar.import_file', args, [new File(['image'], 'avatar.png', { type: 'image/png' })], context)
    assert.equal(result.import.staged, 'confirmed')
    assert.equal(effects, 1)
  })
})
