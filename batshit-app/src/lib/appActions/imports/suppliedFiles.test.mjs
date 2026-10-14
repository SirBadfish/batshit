import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

// Bounded, dependency-free owner/callback proof. No Vite, native build, runtime or real data.
// Node 24 is the application's required runtime. Only imported pure TS leaves are transformed.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sourceRoot = join(appRoot, 'src/lib')
let temp
let contracts, clips, avatars, registry, owners
const originalFetch = globalThis.fetch
before(async () => {
  temp = await mkdtemp('/tmp/sa122-import-offline-')
  const copied = new Set()
  async function copy(relative) {
    if (copied.has(relative)) return
    copied.add(relative)
    const source = await readFile(join(sourceRoot, relative + '.ts'), 'utf8')
    let js = stripTypeScriptTypes(source, { mode: 'transform' })
    const dependencies = []
    js = js.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_, prefix, path, quote) => {
      dependencies.push(join(dirname(relative), path))
      return prefix + path + '.mjs' + quote
    })
    const destination = join(temp, relative + '.mjs')
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, js)
    for (const dependency of dependencies) await copy(dependency)
  }
  for (const file of ['contracts', 'clips', 'avatars', 'registry']) await copy('appActions/imports/' + file)
  const load = relative => import(pathToFileURL(join(temp, relative + '.mjs')).href)
  ;[contracts, clips, avatars, registry, owners] = await Promise.all([
    ...['contracts', 'clips', 'avatars', 'registry'].map(file => load('appActions/imports/' + file)),
    load('appActions/owners')
  ])
  globalThis.fetch = async () => { throw new Error('Unplanned network request in offline proof') }
})
after(async () => { globalThis.fetch = originalFetch; if (temp) await rm(temp, { recursive: true, force: true }) })

function context(check = () => {}) {
  const reports = []
  let effects = 0
  return {
    sessionId: 'session_a', signal: new AbortController().signal,
    check, effect() { effects++ }, report(value) { reports.push(structuredClone(value)) },
    async wait(read) { const value = read(); if (value === undefined) throw new Error('timeout'); return value },
    reports, effects: () => effects
  }
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const file = () => new File(['file bytes'], 'sample.txt', { type: 'text/plain' })
const image = () => new File(['image owner validates signature'], 'avatar.png', { type: 'image/png' })
const uploaded = id => ({ originalName: 'sample.txt', mimetype: 'text/plain', localUrl: '/uploads/documents/sample.txt', clipData: { id, tokens: 3 } })
const state = ids => ({ sessionId: 'session_a', clips: ids.map(clipId => ({ clipId })) })

test('strict metadata refuses host paths, URL/staging refs, accessors, wrong owners and arbitrary fields', () => {
  for (const args of [{ sourceProfile: 'standard-vrm', url: 'https://outside/avatar.vrm' }, { sourceProfile: 'vrm' }, { sourceProfile: 'expert-custom-glb', stageId: 'untrusted' }]) {
    assert.throws(() => contracts.parseImportArgs('goon.import_file', args))
  }
  assert.throws(() => contracts.parseImportArgs('avatar.import_file', { entityType: 'agent', entityId: '../other' }))
  assert.throws(() => contracts.parseImportArgs('clip.import_files', { sessionId: null, attach: true }))
  assert.deepEqual(contracts.parseImportArgs('clip.import_files', { sessionId: 'session.a:1', attach: true }), { sessionId: 'session.a:1', attach: true })
  const accessor = Object.defineProperty({}, 'sourceProfile', { get() { throw new Error('Accessor executed') } })
  assert.throws(() => contracts.parseImportArgs('goon.import_file', accessor), /invalid_arguments/)
  for (const filename of ['/host/file.vrm', '../file.vrm', 'C:\\file.vrm', '..']) {
    assert.throws(() => contracts.materializeSuppliedFiles('goon.import_file', [{ filename, mimeType: 'model/vrm', bytes: new Uint8Array([1]) }]))
  }
  assert.throws(() => contracts.materializeSuppliedFiles('clip.import_files', Array.from({ length: 11 }, file)))
})

test('admission copies a Uint8Array subview and never retains caller bytes', async () => {
  const bytes = new Uint8Array([9, 1, 2, 9])
  const [admitted] = contracts.materializeSuppliedFiles('goon.import_file', [{ filename: 'avatar.vrm', mimeType: 'model/vrm', bytes: bytes.subarray(1, 3) }])
  bytes.fill(0)
  assert.deepEqual([...new Uint8Array(await admitted.arrayBuffer())], [1, 2])
  assert.throws(() => contracts.materializeSuppliedFiles('clip.import_files', [{ filename: 'large.txt', mimeType: 'text/plain', bytes: new Uint8Array(10 * 1024 * 1024 + 1) }]), /invalid_files/)
})

test('deferred Goon file actions refuse before materialization or owner effects', async () => {
  let reads = 0
  const supplied = Object.defineProperty({}, 'bytes', { get() { reads++; throw new Error('Unsupported bytes were inspected') } })
  for (const [id, args] of [
    ['goon.import_file', { sourceProfile: 'standard-vrm' }],
    ['goon.replace_vrm_file', { goonId: 'goon_a' }]
  ]) {
    const ctx = context()
    assert.equal(registry.suppliedFileActionAvailability(id, args), 'unsupported_document')
    await assert.rejects(registry.executeSuppliedFileAction(id, args, [supplied], ctx), /unsupported_document/)
    assert.equal(ctx.effects(), 0)
  }
  assert.equal(reads, 0)
})

test('missing owner and dirty drafts refuse before effect or supplied-byte execution', async () => {
  const ctx = context()
  await assert.rejects(registry.executeSuppliedFileAction('clip.import_files', { sessionId: 'session_a', attach: true }, [file()], ctx), /unsupported_document/)
  let called = 0
  const remove = registry.registerSuppliedFileOwner('clip.import_files', { available: () => 'available', execute: async () => { called++ } })
  const removeDraft = owners.registerAppActionDraft(() => true)
  try {
    await assert.rejects(registry.executeSuppliedFileAction('clip.import_files', { sessionId: 'session_a', attach: true }, [file()], ctx), /unsaved_changes/)
    assert.equal(called, 0)
    assert.equal(ctx.effects(), 0)
  } finally { removeDraft(); remove() }
})

for (const failure of ['http', 'transport', 'malformed']) test(`BL-1171 ${failure} settings failure refuses upload effects`, async () => {
  const calls = []
  const ctx = context()
  const result = await clips.importClipFiles([file()], { sessionId: 'session_a', attach: true }, ctx, async url => {
    calls.push(url)
    if (failure === 'transport') throw new Error('offline')
    return failure === 'http' ? response({ error: 'unavailable' }, 503) : response({})
  })
  assert.deepEqual(calls, ['/api/user/settings'])
  assert.equal(ctx.effects(), 0)
  assert.equal(result.outcome.reason, 'clip_settings_unconfirmed')
  assert.equal(result.outcome.import.uploaded, 'not_requested')
})

for (const failedAttach of ['http', 'transport']) test(`BL-1170 ${failedAttach} attachment retains saved Clip and never reports clipped success or retries`, async () => {
  const calls = []
  const result = await clips.importClipFiles([file()], { sessionId: 'session_a', attach: true }, context(), async (url, init) => {
    calls.push({ url, init })
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') return response({ files: [uploaded('clip_a')] })
    if (url === '/api/clips/clip_a') return response({ id: 'clip_a', systemClip: false })
    if (url === '/api/session-clips/state') {
      assert.deepEqual(JSON.parse(init.body), { sessionId: 'session_a', clipId: 'clip_a', action: 'attach' })
      if (failedAttach === 'transport') throw new Error('response lost')
      return response({ error: 'refused' }, 403)
    }
    throw new Error('Unexpected request ' + url)
  })
  assert.equal(result.outcome.import.uploaded, 'confirmed')
  assert.equal(result.outcome.import.saved, 'confirmed')
  assert.equal(result.outcome.import.staged, 'unknown')
  assert.deepEqual(result.outcome.import.attachedIds, [])
  assert.equal(result.files.length, 1)
  assert.equal(calls.filter(call => call.url === '/api/uploads/clips').length, 1)
  assert.equal(calls.filter(call => call.url === '/api/session-clips/state').length, 1)
})

for (const scenario of ['partial_confirmed', 'partial_unknown', '500_after_write', '500_lost_read']) test(`BL-1177 ${scenario} preserves each attachment fact without mutation retry`, async () => {
  const rendered = []
  let attachments = 0, reads = 0
  const two = scenario.startsWith('partial')
  const scope = { sessionId: 'session_a', clipUploadBusy: false, clipAttachmentUnresolved: [], importClipFiles: clips.importClipFiles,
    toast: { loading: () => 1, dismiss() {}, success() { throw new Error('Must not report batch success') }, error() {} },
    deriveFileType: () => 'text', upsertClip: (clip, attached, evidence) => rendered.push({ clip, attached, evidence }) }
  globalThis.fetch = async (url, init) => {
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') return response({ files: two ? [uploaded('clip_a'), uploaded('clip_b')] : [uploaded('clip_a')] })
    if (url.startsWith('/api/clips/')) return response({ id: url.split('/').at(-1), systemClip: false })
    if (url === '/api/session-clips/state') {
      attachments++
      assert.equal(JSON.parse(init.body).sessionId, 'session_a')
      return two && attachments === 1 ? response(state(['clip_a'])) : response({ error: 'index write failed' }, 500)
    }
    if (url === '/api/session-clips/state/session_a') {
      reads++
      if (scenario.endsWith('unknown') || scenario.endsWith('lost_read')) throw new Error('Read response lost')
      return response(state(['clip_a']))
    }
    throw new Error('Unexpected request ' + url)
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['uploadFilesInternal'], scope)
  const result = await panel.uploadFilesInternal(two ? [file(), file()] : [file()])
  assert.equal(result.import.saved, 'confirmed')
  assert.equal(attachments, two ? 2 : 1)
  assert.equal(reads, 1)
  assert.equal(result.import.ready, 'unknown')
  if (scenario === 'partial_confirmed') {
    assert.equal(result.status, 'failed')
    assert.equal(result.import.staged, 'failed')
    assert.deepEqual(rendered.map(row => [row.attached, row.clip.isClipped]), [[true, true], [false, false]])
  } else if (scenario === 'partial_unknown') {
    assert.equal(result.status, 'unknown_outcome')
    assert.deepEqual(rendered.map(row => [row.attached, row.clip.isClipped]), [[true, true], [false, undefined]])
    assert.deepEqual(result.import.unresolvedIds, ['clip_b'])
  } else if (scenario === '500_after_write') {
    assert.equal(result.status, 'unknown_outcome')
    assert.equal(result.import.staged, 'confirmed')
    assert.equal(rendered[0].attached, true)
  } else {
    assert.equal(result.status, 'unknown_outcome')
    assert.equal(result.import.staged, 'unknown')
    assert.equal(rendered[0].clip.isClipped, undefined)
  }
})

test('actual Clip read-only refresh resolves uncertainty, keeps failed reads and refuses a late different session', async () => {
  const scope = { sessionId: 'session_a', attachmentRefreshBusy: false,
    clipAttachmentUnresolved: [{ sessionId: 'session_a', ids: ['clip_a'] }],
    clipVault: [{ id: 'clip_a', isClipped: undefined }], clippedItems: [], toast: { error() {} } }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['applySessionStateToVault', 'refreshUnresolvedAttachments'], scope)
  globalThis.fetch = async (_, init) => { assert.equal(init.method, undefined); throw new Error('offline') }
  await panel.refreshUnresolvedAttachments()
  assert.equal(scope.clipAttachmentUnresolved.length, 1)
  globalThis.fetch = async () => { scope.sessionId = 'session_b'; return response(state(['clip_a'])) }
  await panel.refreshUnresolvedAttachments()
  assert.equal(scope.clipVault[0].isClipped, undefined)
  assert.equal(scope.clipAttachmentUnresolved.length, 1)
  scope.sessionId = 'session_a'
  globalThis.fetch = async () => response(state(['clip_a']))
  await panel.refreshUnresolvedAttachments()
  assert.equal(scope.clipVault[0].isClipped, true)
  assert.deepEqual(scope.clippedItems.map(clip => clip.id), ['clip_a'])
  assert.deepEqual(scope.clipAttachmentUnresolved, [])
})

test('actual Clip normal refresh cannot turn retained attachments into absence after a lost session GET', async () => {
  const scope = { sessionId: 'session_a', clipAttachmentUnresolved: [{ sessionId: 'session_a', ids: ['clip_b'] }],
    clipVault: [{ id: 'clip_a', isClipped: true }, { id: 'clip_b', isClipped: undefined }], clippedItems: [{ id: 'clip_a' }], toast: { error() {} } }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['loadClips', 'applySessionStateToVault'], scope)
  globalThis.fetch = async url => url === '/api/clips' ? response([{ id: 'clip_a' }, { id: 'clip_b' }]) : response({}, 503)
  await panel.loadClips()
  assert.deepEqual(scope.clipVault.map(clip => clip.isClipped), [true, undefined])
  assert.deepEqual(scope.clippedItems.map(clip => clip.id), ['clip_a'])
  assert.equal(scope.clipAttachmentUnresolved.length, 1)
})

test('Clip owner confirms each saved record and separate session readback, using confirmed saved compression', async () => {
  let attachCount = 0
  const result = await clips.importClipFiles([file(), file()], { sessionId: 'session_a', attach: true }, context(), async (url, init) => {
    if (url === '/api/user/settings') return response({ settings: { ui_settings: { compress_images: false } } })
    if (url === '/api/uploads/clips') {
      assert.equal(init.body.get('userId'), null)
      assert.equal(JSON.parse(init.body.get('compressionSettings')).compress_images, false)
      return response({ files: [uploaded('clip_a'), uploaded('clip_b')] })
    }
    if (url.startsWith('/api/clips/')) return response({ id: url.split('/').at(-1), systemClip: false })
    if (url === '/api/session-clips/state') return response(state(++attachCount === 1 ? ['clip_a'] : ['clip_a', 'clip_b']))
    if (url === '/api/session-clips/state/session_a') return response(state(['clip_a', 'clip_b']))
    throw new Error('Unexpected request ' + url)
  })
  assert.equal(result.outcome.status, 'completed')
  assert.equal(result.outcome.import.saved, 'confirmed')
  assert.equal(result.outcome.import.staged, 'confirmed')
  assert.equal(result.outcome.import.ready, 'confirmed')
})

test('an upload response with no persisted Clip never reaches attachment', async () => {
  const calls = []
  const result = await clips.importClipFiles([file()], { sessionId: 'session_a', attach: true }, context(), async url => {
    calls.push(url)
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') return response({ files: [uploaded('clip_a')] })
    return response({ error: 'Clip not found' }, 404)
  })
  assert.equal(result.outcome.import.uploaded, 'confirmed')
  assert.equal(result.outcome.import.saved, 'unknown')
  assert.ok(!calls.includes('/api/session-clips/state'))
})

test('avatar upload stage/save are distinct, no old-asset delete, and timed-out save is not retried', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return response({ url: '/uploads/avatars/agent_a.jpg' }) }
  let draft, saved = null
  const ports = { check() {}, stage(url) { draft = url }, savedAvatar: () => saved, saveError: () => null }
  const result = await avatars.performAvatarImport(image(), { entityType: 'agent', entityId: 'agent_a' }, ports, context())
  assert.equal(draft, '/uploads/avatars/agent_a.jpg')
  assert.equal(saved, null)
  assert.equal(result.import.uploaded, 'confirmed')
  assert.equal(result.import.staged, 'confirmed')
  assert.equal(result.import.saved, 'unknown')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/uploads/avatar')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.body.get('oldAvatarUrl'), null)
  ports.stage = url => { draft = url; saved = url }
  const completed = await avatars.performAvatarImport(image(), { entityType: 'agent', entityId: 'agent_a' }, ports, context())
  assert.equal(completed.import.saved, 'confirmed')
  assert.equal(completed.import.ready, 'pending')
})

async function panelFunctions(path, names, scope) {
  if (path === 'clips/ClipsManagerDropdown.svelte') {
    names = [...new Set([...names, 'markClipEvidence', 'beginClipRead', 'clipReadCurrent', 'clipAttachmentPending'])]
    scope.clipEvidenceGenerations ??= new Map()
    scope.clipReadSequences ??= new Map()
    scope.currentUnsettledClipIds ??= []
    scope.clipAttachmentFlightSession ??= null
  }
  const source = (await readFile(join(appRoot, 'src/lib/components', path), 'utf8')).split('<script lang="ts">')[1].split('</script>')[0]
  const declarations = names.map(name => {
    const start = source.search(new RegExp('^  (?:export )?(?:async )?function ' + name + '\\b', 'm'))
    assert.notEqual(start, -1, 'Missing actual panel callback ' + name)
    const end = source.indexOf('\n  }', start)
    return source.slice(start, end + 4).replace('export ', '')
  }).join('\n')
  const js = stripTypeScriptTypes(declarations, { mode: 'transform' })
  const environment = new Proxy(scope, { has: () => true,
    get(target, key) { return key === Symbol.unscopables ? undefined : Object.hasOwn(target, key) ? target[key] : globalThis[key] },
    set(target, key, value) { target[key] = value; return true } })
  return new Function('environment', `with (environment) { ${js}; return { ${names.join(',')} }; }`)(environment)
}

test('actual Clip component callback avoids optimistic attachment and success toast after HTTP refusal', async () => {
  const messages = []
  const rendered = []
  const scope = { sessionId: 'session_a', clipUploadBusy: false, clipAttachmentUnresolved: [], importClipFiles: clips.importClipFiles,
    toast: { loading: () => 1, dismiss() {}, success: text => messages.push(['success', text]), error: text => messages.push(['error', text]) },
    deriveFileType: () => 'text', upsertClip: (clip, attached) => rendered.push({ clip, attached }) }
  globalThis.fetch = async url => url === '/api/user/settings' ? response({ settings: null })
    : url === '/api/uploads/clips' ? response({ files: [uploaded('clip_a')] })
    : url === '/api/clips/clip_a' ? response({ id: 'clip_a', systemClip: false }) : response({ error: 'refused' }, 403)
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['uploadFilesInternal'], scope)
  const result = await panel.uploadFilesInternal([file()])
  assert.equal(result.import.saved, 'confirmed')
  assert.equal(rendered[0].attached, false)
  assert.equal(rendered[0].clip.isClipped, undefined)
  assert.deepEqual(result.import.unresolvedIds, ['clip_a'])
  assert.equal(messages.filter(([kind]) => kind === 'success').length, 0)
  assert.equal(messages.filter(([kind]) => kind === 'error').length, 1)
})

test('actual Clip callback preserves known attached Clip when final readback is lost, without success toast or retry', async () => {
  const rendered = []
  let uploads = 0, attachments = 0, successes = 0
  const scope = { sessionId: 'session_a', clipUploadBusy: false, clipAttachmentUnresolved: [], importClipFiles: clips.importClipFiles,
    toast: { loading: () => 1, dismiss() {}, success() { successes++ }, error() {} },
    deriveFileType: () => 'text', upsertClip: (clip, attached) => rendered.push({ clip, attached }) }
  globalThis.fetch = async url => {
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') { uploads++; return response({ files: [uploaded('clip_a')] }) }
    if (url === '/api/clips/clip_a') return response({ id: 'clip_a', systemClip: false })
    if (url === '/api/session-clips/state') { attachments++; return response(state(['clip_a'])) }
    throw new Error('Readback response lost')
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['uploadFilesInternal'], scope)
  const result = await panel.uploadFilesInternal([file()])
  assert.equal(result.import.uploaded, 'confirmed')
  assert.equal(result.import.saved, 'confirmed')
  assert.equal(result.import.staged, 'unknown')
  assert.equal(rendered[0].attached, true)
  assert.equal(rendered[0].clip.isClipped, true)
  assert.deepEqual(scope.clipAttachmentUnresolved, [{ sessionId: 'session_a', ids: [], unsettledIds: [] }])
  assert.equal(successes, 0)
  assert.equal(uploads, 1)
  assert.equal(attachments, 1)
})

test('actual Clip component captures session across delayed upload and keeps another session unclipped', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const attachedSessions = []
  const rendered = []
  const scope = { sessionId: 'session_a', clipUploadBusy: false, clipAttachmentUnresolved: [], importClipFiles: clips.importClipFiles,
    toast: { loading: () => 1, dismiss() {}, success() {}, error() {} }, deriveFileType: () => 'text', upsertClip: (clip, attached) => rendered.push({ clip, attached }) }
  globalThis.fetch = async (url, init) => {
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') { entered(); await held; return response({ files: [uploaded('clip_a')] }) }
    if (url === '/api/clips/clip_a') return response({ id: 'clip_a', systemClip: false })
    if (url === '/api/session-clips/state') { attachedSessions.push(JSON.parse(init.body).sessionId); return response(state(['clip_a'])) }
    return response(state(['clip_a']))
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['uploadFilesInternal'], scope)
  const running = panel.uploadFilesInternal([file()])
  try { await started; scope.sessionId = 'session_b'; release(); await running }
  finally { release() }
  assert.deepEqual(attachedSessions, ['session_a'])
  assert.equal(rendered[0].attached, false)
})

for (const entityType of ['user', 'group', 'agent', 'subagent']) test(`actual ${entityType} avatar callback preserves changed owner and stages only for the captured save owner`, async () => {
  const signature = value => JSON.stringify(value)
  const initial = { avatar_url: '/uploads/avatars/old.jpg', avatar: '/uploads/avatars/old.jpg' }
  const scope = {
    performAvatarImport: avatars.performAvatarImport, refuse(reason) { throw new Error(reason) }, untrack: fn => fn(),
    avatarPanelAlive: true, avatarAppActionBusy: false, userId: 'user_a', settingsLoaded: true, isLoading: false, settingsLoadBusy: false,
    settings: { ...initial }, persistedSettings: { ...initial }, saveInFlight: false, pendingSavePayload: null, pendingSaveTimeout: null,
    isUploadingAvatar: false, makeFullSignature: signature, makeProfileSignature: signature, makePromptSignature: signature, makeChatSignature: signature,
    persistedProfileSignature: signature(initial), persistedPromptSignature: signature(initial), persistedChatSignature: signature(initial),
    listLoading: false, formHydrating: false, formPersistedSignature: signature(initial), selectedGroupId: 'group_a', groupForm: { ...initial },
    groupReadGeneration: 1, groupSelectionGeneration: 1, groupDrafts: new Map(), pendingGroupSaves: new Map(), groupSaveFlights: new Set(), groupSaveErrors: new Map(), deleteBusy: false,
    groups: [{ id: 'group_a', avatar_url: initial.avatar_url }], isUploadingGroupAvatar: false, saveState: 'idle', saveError: null,
    makeFormSignature: signature, updateForm(patch) { scope.groupForm = { ...scope.groupForm, ...patch } },
    settingsPanelAlive: true, selectedEntity: { kind: entityType, id: entityType + '_a' }, selectedAgentId: 'agent_a', selectedEditableSubagentId: 'subagent_a',
    primarySettingsReadWaiting: false, subagentSettingsReadWaiting: false, primaryOwnedSaveInFlightUi: false, subagentOwnedSaveInFlightUi: false,
    basicPersistedForm: { ...initial }, subagentPersistedForm: { ...initial }, basicForm: { ...initial }, subagentForm: { ...initial },
    isUploadingAgentAvatar: false, subagentAvatarUploading: false, agentSectionsAtRest: () => ({ basic: true }), subagentSectionsAtRest: () => ({ core: true }),
    agentHydrationRequestId: 1, subagentReadGeneration: 1, makeBasicSignature: signature, makeSubagentFormSignature: signature,
    basicSaveError: null, subagentEditSaveError: null
  }
  const path = entityType === 'user' ? 'UserSettingsPanel' : entityType === 'group' ? 'GroupSettingsPanel' : 'AgentSettingsPanel'
  const panel = await panelFunctions('settings/panels/' + path + '.svelte', ['suppliedAvatarAvailability', 'importAppActionAvatar'], scope)
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  let uploadCount = 0
  globalThis.fetch = async () => { uploadCount++; entered(); await held; return response({ url: '/uploads/avatars/new.jpg' }) }
  const running = panel.importAppActionAvatar({ entityType, entityId: entityType + '_a' }, [image()], context())
  try {
    await started
    if (entityType === 'user') scope.avatarPanelAlive = false
    else if (entityType === 'group') scope.selectedGroupId = 'group_b'
    else scope.selectedEntity = { kind: entityType, id: entityType + '_b' }
    release()
  } finally { release() }
  const result = await running
  assert.equal(result.import.uploaded, 'confirmed')
  assert.equal(result.import.staged, 'not_requested')
  assert.equal(result.import.saved, 'not_requested')
  assert.equal(scope.settings.avatar_url, initial.avatar_url)
  assert.equal(scope.groupForm.avatar_url, initial.avatar_url)
  assert.equal(scope.basicForm.avatar_url, initial.avatar_url)
  assert.equal(scope.subagentForm.avatar, initial.avatar)
  assert.equal(uploadCount, 1)

  // Then prove the same actual callback releases its upload gate before the existing
  // form saver observes the staged URL; the callback itself sends no settings write.
  scope.avatarPanelAlive = true
  scope.selectedGroupId = 'group_a'
  scope.selectedEntity = { kind: entityType, id: entityType + '_a' }
  globalThis.fetch = async url => { assert.equal(url, '/api/uploads/avatar'); uploadCount++; return response({ url: '/uploads/avatars/new.jpg' }) }
  const savedContext = context()
  savedContext.wait = async read => {
    const uploading = entityType === 'user' ? scope.isUploadingAvatar : entityType === 'group' ? scope.isUploadingGroupAvatar
      : entityType === 'agent' ? scope.isUploadingAgentAvatar : scope.subagentAvatarUploading
    assert.equal(uploading, false)
    if (entityType === 'user') scope.persistedSettings = { ...scope.settings }
    else if (entityType === 'group') scope.groups = [{ id: 'group_a', ...scope.groupForm }]
    else if (entityType === 'agent') scope.basicPersistedForm = { ...scope.basicForm }
    else scope.subagentPersistedForm = { ...scope.subagentForm }
    return read()
  }
  const completed = await panel.importAppActionAvatar({ entityType, entityId: entityType + '_a' }, [image()], savedContext)
  assert.equal(completed.import.staged, 'confirmed')
  assert.equal(completed.import.saved, 'confirmed')
  assert.equal(completed.import.ready, 'pending')
  assert.equal(uploadCount, 2)
})

// Supplemental timer/persistence evidence uses the actual component functions;
// only the Svelte lifetime is simulated. The mounted suite separately owns that proof.
async function groupOwnerHarness() {
  const writes = [], deletes = [], cacheUpdates = [], messages = []
  const timers = new Map()
  let timerId = 0
  const saved = new Map([['group_a', { id: 'group_a', name: 'Group A', avatar_url: '/old_a.jpg' }],
    ['group_b', { id: 'group_b', name: 'Group B', avatar_url: '/old_b.jpg' }]])
  const scope = {
    avatarPanelAlive: true, selectedGroupId: null, groupReadGeneration: 1, groupSelectionGeneration: 0,
    deletingGroupId: null, deleteBusy: false, listLoading: false, listError: null, formHydrating: false, formPersistedSignature: null, groupForm: {},
    saveError: null, saveState: 'idle', saveTarget: 'settings', groupAvatarError: null,
    groupDrafts: new Map(), pendingGroupSaves: new Map(), groupSaveTimers: new Map(), groupSaveFlights: new Set(), activeGroupSaves: new Map(), groupSaveErrors: new Map(), groupStatusTimers: new Map(),
    groups: [...saved.values()].map(value => structuredClone(value)), isUploadingGroupAvatar: false, avatarAppActionBusy: false,
    SAVE_DEBOUNCE_MS: 650, GROUP_CHAT_SESSION_DEFAULTS: { max_followups_total: 5, max_agents: 4, driver_mode: false, driver_agent_id: null, shared_tools: [] },
    DEFAULT_GROUP_ICON_REF: 'group', EMPTY_FORM: {}, normalizeIconRef: (value, fallback) => value ?? fallback,
    normalizeAvatarIconFit: value => value ?? 'fill', iconRefKey: value => value,
    normalizeGroupMaxFollowupsTotal: (value, fallback) => value ?? fallback, normalizeGroupMaxAgents: (value, fallback) => value ?? fallback,
    untrack: fn => fn(), $state: { snapshot: value => value }, shouldTidyAvatarPictures: () => false,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
    groupStore: { setGroups() {}, updateGroup(id, record) { cacheUpdates.push(id) }, deleteGroup(id) { deletes.push(id) } },
    sessionStore: { getSessions: () => [], updateSession() {} }, toast: { error: text => messages.push(text) },
    groupService: { async loadGroups() { return [...saved.values()].map(value => structuredClone(value)) }, async updateGroup(id, payload) { writes.push({ id, payload }); saved.set(id, { ...saved.get(id), ...structuredClone(payload) }) },
      async deleteGroup(id) { return { clearedSessionIds: [] } } }, confirmDialog: async () => true,
    console: { error() {} }
  }
  globalThis.fetch = async url => response(saved.get(decodeURIComponent(url.split('/').at(-1))))
  const panel = await panelFunctions('settings/panels/GroupSettingsPanel.svelte',
    ['normalizeGroup', 'makeFormSignature', 'selectGroup', 'buildGroupPayload', 'persistGroupForm', 'runGroupSave', 'queueGroupSave', 'updateForm', 'handleDeleteGroup', 'destroyGroupOwner', 'loadGroups', 'reconcileGroupDraft', 'finishConfirmedGroupDraft', 'suppliedAvatarAvailability'], scope)
  panel.selectGroup(scope.groups[0])
  async function fireDebounce() {
    for (const [id, timer] of [...timers]) if (timer.ms === 650) { timers.delete(id); timer.fn() }
    await new Promise(setImmediate)
  }
  return { panel, scope, writes, deletes, cacheUpdates, messages, saved, fireDebounce }
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('BL-579 actual 650ms queue saves staged A avatar to A after selecting B, and leaves B form/status alone', async () => {
  const h = await groupOwnerHarness()
  h.panel.updateForm({ avatar_url: '/new_a.jpg', name: 'Edited A' })
  h.panel.selectGroup(h.scope.groups[1])
  await h.fireDebounce()
  assert.deepEqual(h.writes.map(write => write.id), ['group_a'])
  assert.equal(h.writes[0].payload.avatar_url, '/new_a.jpg')
  assert.equal(h.scope.groupForm.name, 'Group B')
  assert.equal(h.scope.groupForm.avatar_url, '/old_b.jpg')
  assert.equal(h.scope.saveState, 'idle')
  assert.deepEqual(h.cacheUpdates, ['group_a'])
})

test('BL-579 actual flight preserves a later same-owner draft and serializes it against canonical saved baseline', async () => {
  const h = await groupOwnerHarness(), held = deferred(), entered = deferred()
  const update = h.scope.groupService.updateGroup
  h.scope.groupService.updateGroup = async (...args) => { entered.resolve(); await held.promise; await update(...args) }
  h.panel.updateForm({ name: 'First A' })
  const started = h.fireDebounce()
  await entered.promise
  h.panel.updateForm({ name: 'Later A' })
  h.panel.selectGroup(h.scope.groups[1])
  h.panel.selectGroup(h.scope.groups[0])
  held.resolve(); await started
  assert.equal(h.scope.groupForm.name, 'Later A')
  assert.equal(h.scope.groupForm.id, 'group_a')
  await h.fireDebounce()
  assert.deepEqual(h.writes.map(write => [write.id, write.payload.name]), [['group_a', 'First A'], ['group_a', 'Later A']])
  assert.equal(h.scope.groupForm.name, 'Later A')
  assert.equal(h.scope.groupDrafts.size, 0)
})

test('BL-579 lost canonical save read stays dirty/unknown without automatic retry or false saved cache', async () => {
  const h = await groupOwnerHarness()
  globalThis.fetch = async () => { throw new Error('GET response lost') }
  h.panel.updateForm({ avatar_url: '/new_a.jpg' })
  await h.fireDebounce()
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.cacheUpdates, [])
  assert.equal(h.scope.groupDrafts.size, 1)
  assert.equal(h.scope.groupSaveErrors.get('group_a').outcome, 'unknown')
  assert.match(h.scope.saveError, /GET response lost/)
  await h.fireDebounce()
  assert.equal(h.writes.length, 1)
})

for (const drift of ['selection', 'refresh', 'teardown', 'queued_save']) test(`BL-1179 actual confirmation refuses ${drift} before DELETE`, async () => {
  const h = await groupOwnerHarness(), answer = deferred()
  let calls = 0
  h.scope.confirmDialog = () => answer.promise
  h.scope.groupService.deleteGroup = async () => { calls++; return { clearedSessionIds: [] } }
  const deleting = h.panel.handleDeleteGroup()
  if (drift === 'selection') h.panel.selectGroup(h.scope.groups[1])
  if (drift === 'refresh') h.scope.groupReadGeneration++
  if (drift === 'teardown') h.scope.avatarPanelAlive = false
  if (drift === 'queued_save') h.panel.updateForm({ name: 'Draft A' })
  answer.resolve(true); await deleting
  assert.equal(calls, 0)
  assert.equal(h.deletes.length, 0)
})

test('BL-1179 actual in-flight delete removes only captured A, leaves B draft and newly reassigned chat intact', async () => {
  const h = await groupOwnerHarness(), held = deferred(), entered = deferred()
  const deletedIds = [], sessionWrites = []
  h.scope.groupService.deleteGroup = async id => { deletedIds.push(id); entered.resolve(); await held.promise; return { clearedSessionIds: ['chat_a'] } }
  h.scope.sessionStore = { getSessions: () => [{ id: 'chat_a', metadata: { group_chat: { group_id: 'group_b' } } }],
    updateSession: (...args) => sessionWrites.push(args) }
  const deleting = h.panel.handleDeleteGroup()
  await entered.promise
  h.panel.updateForm({ name: 'Must not save deleted A' })
  assert.equal(h.scope.pendingGroupSaves.size, 0)
  h.panel.selectGroup(h.scope.groups[1])
  h.panel.updateForm({ name: 'B draft' })
  held.resolve(); await deleting
  assert.deepEqual(deletedIds, ['group_a'])
  assert.deepEqual(h.deletes, ['group_a'])
  assert.deepEqual(sessionWrites, [])
  assert.equal(h.scope.selectedGroupId, 'group_b')
  assert.equal(h.scope.groupForm.name, 'B draft')
  assert.deepEqual(h.scope.groups.map(group => group.id), ['group_b'])
  await h.fireDebounce()
  assert.deepEqual(h.writes.map(write => write.id), ['group_b'])
})

test('BL-579 actual owner teardown cancels queued timer/write and surfaces unsaved cancellation', async () => {
  const h = await groupOwnerHarness()
  h.panel.updateForm({ name: 'Not saved A' })
  h.panel.destroyGroupOwner()
  await h.fireDebounce()
  assert.equal(h.writes.length, 0)
  assert.equal(h.scope.pendingGroupSaves.size, 0)
  assert.equal(h.scope.groupSaveTimers.size, 0)
  assert.match(h.messages[0], /closed before queued changes were saved/)
})

test('BL-1179 actual in-flight DELETE after teardown removes captured cache without replacing component form', async () => {
  const h = await groupOwnerHarness(), entered = deferred(), held = deferred()
  h.scope.groupService.deleteGroup = async () => { entered.resolve(); await held.promise; return { clearedSessionIds: [] } }
  const deleting = h.panel.handleDeleteGroup()
  await entered.promise
  h.panel.destroyGroupOwner()
  const form = h.scope.groupForm
  held.resolve(); await deleting
  assert.deepEqual(h.deletes, ['group_a'])
  assert.equal(h.scope.groupForm, form)
  assert.equal(h.scope.groups.length, 2)
})

test('Group avatar failed save uses unknown receipt for uncertain committed-write/readback evidence', async () => {
  globalThis.fetch = async () => response({ url: '/new_a.jpg' })
  const result = await avatars.performAvatarImport(image(), { entityType: 'group', entityId: 'group_a' }, {
    check() {}, stage() {}, savedAvatar: () => '/old_a.jpg', saveError: () => 'Save read lost', saveFailureKind: () => 'unknown'
  }, context())
  assert.equal(result.status, 'unknown_outcome')
  assert.equal(result.import.uploaded, 'confirmed')
  assert.equal(result.import.staged, 'confirmed')
  assert.equal(result.import.saved, 'unknown')
})

function clipOwnerScope() {
  const scope = { sessionId: 'session_a', clipUploadBusy: false, attachmentRefreshBusy: false,
    clipAttachmentUnresolved: [], clipVault: [], clippedItems: [], importClipFiles: clips.importClipFiles,
    toast: { loading: () => 1, dismiss() {}, error() {}, success() {} }, deriveFileType: () => 'text',
    refuse(reason) { throw new Error(reason) }, console: { error() {} } }
  Object.defineProperty(scope, 'currentUnresolvedClipIds', { get: () => scope.clipAttachmentUnresolved.find(entry => entry.sessionId === scope.sessionId)?.ids ?? [] })
  Object.defineProperty(scope, 'currentUnsettledClipIds', { get: () => scope.clipAttachmentUnresolved.find(entry => entry.sessionId === scope.sessionId)?.unsettledIds ?? [] })
  return scope
}

test('BL-1177 lost POST can commit after a negative GET: absence stays unknown and recovery never proves server completion', async () => {
  const scope = clipOwnerScope(), attached = []
  let serverWrite, uploads = 0, mutations = 0
  globalThis.fetch = async url => {
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') { uploads++; return response({ files: [uploaded('clip_a')] }) }
    if (url === '/api/clips/clip_a') return response({ id: 'clip_a', systemClip: false })
    if (url === '/api/session-clips/state') {
      mutations++
      serverWrite = () => attached.push('clip_a')
      // The browser response is lost; the independent server handler remains pending.
      throw new Error('Browser fetch rejected before the pending server write')
    }
    if (url === '/api/session-clips/state/session_a') return response(state(attached))
    throw new Error('Unexpected ' + url)
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte',
    ['uploadFilesInternal', 'upsertClip', 'applySessionStateToVault', 'refreshUnresolvedAttachments', 'toggleClip', 'unclipAll', 'setClipOneTimeMode'], scope)
  const result = await panel.uploadFilesInternal([file()])
  assert.equal(result.status, 'unknown_outcome')
  assert.equal(result.import.staged, 'unknown')
  assert.deepEqual(result.import.unresolvedIds, ['clip_a'])
  assert.deepEqual(result.import.unsettledIds, ['clip_a'])
  assert.equal(scope.clipVault[0].isClipped, undefined)
  await panel.refreshUnresolvedAttachments()
  assert.equal(scope.clipVault[0].isClipped, undefined)
  await assert.rejects(panel.uploadFilesInternal([file()], { sessionId: 'session_a', attach: true }, context()), /attachment_completion_unknown/)
  await panel.toggleClip(scope.clipVault[0]); await panel.unclipAll(); await panel.setClipOneTimeMode('clip_a', true)
  assert.equal(uploads, 1)
  assert.equal(mutations, 1)
  serverWrite()
  await panel.refreshUnresolvedAttachments()
  assert.equal(scope.clipVault[0].isClipped, true)
  assert.deepEqual(scope.clippedItems.map(clip => clip.id), ['clip_a'])
  assert.deepEqual(scope.clipAttachmentUnresolved, [{ sessionId: 'session_a', ids: [], unsettledIds: ['clip_a'] }])
  assert.equal(mutations, 1)
})

for (const readKind of ['explicit', 'normal']) for (const newer of ['known', 'unresolved']) test(`BL-1177 old ${readKind} same-session read cannot erase newer ${newer} upload evidence`, async () => {
  const scope = clipOwnerScope(), held = deferred(), entered = deferred()
  scope.clipVault = [{ id: 'clip_a', filename: 'a.txt', isClipped: false }]
  scope.clipAttachmentUnresolved = [{ sessionId: 'session_a', ids: ['clip_a'] }]
  let reads = 0, mutations = 0
  globalThis.fetch = async url => {
    if (url === '/api/clips') return response([{ id: 'clip_a', filename: 'a.txt' }])
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') return response({ files: [uploaded('clip_b')] })
    if (url === '/api/clips/clip_b') return response({ id: 'clip_b', systemClip: false })
    if (url === '/api/session-clips/state') { mutations++; return newer === 'known' ? response(state(['clip_b'])) : response({}, 500) }
    if (url === '/api/session-clips/state/session_a') {
      if (++reads === 1) { entered.resolve(); await held.promise; return response(state([])) }
      if (newer === 'unresolved') throw new Error('New attachment read response lost')
      return response(state(['clip_b']))
    }
    throw new Error('Unexpected ' + url)
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte',
    ['loadClips', 'refreshUnresolvedAttachments', 'applySessionStateToVault', 'uploadFilesInternal', 'upsertClip'], scope)
  const oldRead = readKind === 'explicit' ? panel.refreshUnresolvedAttachments() : panel.loadClips()
  await entered.promise
  await panel.uploadFilesInternal([file()])
  const evidence = structuredClone(scope.clipAttachmentUnresolved)
  held.resolve(); await oldRead
  assert.equal(scope.clipVault.find(clip => clip.id === 'clip_b').isClipped, newer === 'known' ? true : undefined)
  assert.deepEqual(scope.clippedItems.map(clip => clip.id), newer === 'known' ? ['clip_b'] : [])
  assert.deepEqual(scope.clipAttachmentUnresolved, evidence)
  assert.equal(mutations, 1)
})

test('BL-1177 a newer normal recovery supersedes an older explicit recovery in the same session', async () => {
  const scope = clipOwnerScope(), held = deferred(), entered = deferred()
  scope.clipVault = [{ id: 'clip_a', isClipped: undefined }]
  scope.clipAttachmentUnresolved = [{ sessionId: 'session_a', ids: ['clip_a'] }]
  let reads = 0
  globalThis.fetch = async url => {
    if (url === '/api/clips') return response([{ id: 'clip_a' }])
    if (++reads === 1) { entered.resolve(); await held.promise; return response(state([])) }
    return response(state(['clip_a']))
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['loadClips', 'refreshUnresolvedAttachments', 'applySessionStateToVault'], scope)
  const old = panel.refreshUnresolvedAttachments(); await entered.promise
  await panel.loadClips()
  held.resolve(); await old
  assert.deepEqual(scope.clippedItems.map(clip => clip.id), ['clip_a'])
  assert.deepEqual(scope.clipAttachmentUnresolved, [])
})

test('BL-1177 an older read cannot restore an attachment detached by the actual existing owner', async () => {
  const scope = clipOwnerScope(), held = deferred(), entered = deferred()
  scope.clipVault = [{ id: 'clip_a', isClipped: true }]
  scope.clippedItems = [...scope.clipVault]
  scope.clipAttachmentUnresolved = [{ sessionId: 'session_a', ids: [] }]
  let mutations = 0
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/session_a')) { entered.resolve(); await held.promise; return response(state(['clip_a'])) }
    mutations++; assert.equal(JSON.parse(init.body).action, 'detach'); return response(state([]))
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['refreshUnresolvedAttachments', 'applySessionStateToVault', 'toggleClip'], scope)
  const old = panel.refreshUnresolvedAttachments(); await entered.promise
  await panel.toggleClip(scope.clipVault[0])
  held.resolve(); await old
  assert.deepEqual(scope.clippedItems, [])
  assert.equal(scope.clipVault[0].isClipped, false)
  assert.equal(mutations, 1)
})

test('BL-1186 matching authoritative read retires matching queued draft after old detail flight, without another PUT', async () => {
  const h = await groupOwnerHarness(), held = deferred(), entered = deferred()
  globalThis.fetch = async url => {
    const saved = structuredClone(h.saved.get(url.split('/').at(-1)))
    entered.resolve(); await held.promise; return response(saved)
  }
  h.panel.updateForm({ name: 'Saved A' })
  await h.fireDebounce(); await entered.promise
  // A second identical deliberate edit coalesces behind the admitted save.
  h.panel.updateForm({ name: 'Saved A' })
  const removeDraft = owners.registerAppActionDraft(() => h.scope.groupDrafts.size > 0 || h.scope.groupSaveFlights.size > 0)
  try {
    await h.panel.loadGroups()
    assert.equal(h.scope.pendingGroupSaves.size, 0)
    assert.equal(h.scope.groupSaveTimers.size, 0)
    assert.equal(owners.appActionsHaveDrafts(), true) // The actual flight is still owned.
    held.resolve(); await new Promise(setImmediate)
    assert.equal(h.scope.groupDrafts.size, 0)
    assert.equal(h.scope.groupSaveErrors.size, 0)
    assert.equal(owners.appActionsHaveDrafts(), false)
    assert.equal(h.panel.suppliedAvatarAvailability({ entityType: 'group', entityId: 'group_a' }), 'available')
    await h.fireDebounce(); await h.panel.loadGroups()
    assert.equal(h.writes.length, 1)
    assert.equal(h.scope.groupDrafts.size, 0)
  } finally { held.resolve(); removeDraft() }
})

test('BL-1186 differing newer Group draft remains owned and stale queued PUT is refused after a newer read', async () => {
  const h = await groupOwnerHarness(), held = deferred(), entered = deferred()
  globalThis.fetch = async url => { const saved = structuredClone(h.saved.get(url.split('/').at(-1))); entered.resolve(); await held.promise; return response(saved) }
  h.panel.updateForm({ name: 'Saved first A' }); await h.fireDebounce(); await entered.promise
  h.panel.updateForm({ name: 'Later draft A' })
  await h.panel.loadGroups()
  assert.equal(h.scope.pendingGroupSaves.size, 1)
  assert.equal(h.scope.groupDrafts.size, 1)
  held.resolve(); await new Promise(setImmediate)
  await h.fireDebounce()
  assert.equal(h.scope.groupForm.name, 'Later draft A')
  assert.equal(h.scope.groupDrafts.size, 1)
  assert.equal(h.writes.length, 1)
  assert.match(h.scope.saveError, /refreshed before this save started/)
  assert.equal(h.panel.suppliedAvatarAvailability({ entityType: 'group', entityId: 'group_a' }), 'unsaved_changes')
})

test('BL-1186 a matching read cannot retire a draft while an older different-value write may still commit', async () => {
  const h = await groupOwnerHarness(), held = deferred(), entered = deferred()
  const update = h.scope.groupService.updateGroup
  h.scope.groupService.updateGroup = async (...args) => { entered.resolve(); await held.promise; await update(...args) }
  h.panel.updateForm({ name: 'Old admitted A' }); await h.fireDebounce(); await entered.promise
  h.panel.updateForm({ name: 'New draft A' })
  h.saved.set('group_a', { ...h.saved.get('group_a'), name: 'New draft A' })
  await h.panel.loadGroups()
  assert.equal(h.scope.pendingGroupSaves.size, 1)
  assert.equal(h.scope.groupDrafts.size, 1)
  held.resolve(); await new Promise(setImmediate); await h.fireDebounce()
  assert.equal(h.saved.get('group_a').name, 'Old admitted A')
  assert.equal(h.scope.groupForm.name, 'New draft A')
  assert.equal(h.scope.groupDrafts.size, 1)
  assert.equal(h.writes.length, 1)
})

test('BL-1186 authoritative matching read recovers settled unknown Group save/error and releases admission', async () => {
  const h = await groupOwnerHarness()
  globalThis.fetch = async () => { throw new Error('Saved detail response lost') }
  h.panel.updateForm({ name: 'Actually saved A' }); await h.fireDebounce()
  assert.equal(h.scope.groupDrafts.size, 1)
  assert.equal(h.scope.groupSaveErrors.size, 1)
  await h.panel.loadGroups()
  assert.equal(h.scope.groupDrafts.size, 0)
  assert.equal(h.scope.groupSaveErrors.size, 0)
  assert.equal(h.scope.saveError, null)
  assert.equal(h.panel.suppliedAvatarAvailability({ entityType: 'group', entityId: 'group_a' }), 'available')
  assert.equal(h.writes.length, 1)
})

for (const kind of ['single', 'bulk']) for (const timing of ['before_confirmation', 'during_confirmation']) test(`Clip ${kind} permanent delete refuses unsettled imported POST ${timing}`, async () => {
  const scope = clipOwnerScope(), held = deferred(), entered = deferred(), requests = []
  const clip = { id: 'clip_a', filename: 'a.txt', isClipped: false }
  Object.assign(scope, { pageData: { user: { id: 'user_a' } }, clipVault: [clip], userClipVault: [clip], selectedClipIds: ['clip_a'],
    bulkDeleteBusy: false, bulkDeleteMode: false, confirmDialog: () => { entered.resolve(); return held.promise } })
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return response({ success: true }) }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['deleteClip', 'deleteSelectedClips', 'clipDeleteBlocked'], scope)
  if (timing === 'before_confirmation') scope.clipAttachmentUnresolved = [{ sessionId: 'session_a', ids: ['clip_a'], unsettledIds: ['clip_a'] }]
  const deleting = kind === 'single' ? panel.deleteClip(clip) : panel.deleteSelectedClips()
  if (timing === 'during_confirmation') {
    await entered.promise
    scope.clipAttachmentUnresolved = [{ sessionId: 'session_a', ids: ['clip_b'], unsettledIds: ['clip_b'] }]
    scope.sessionId = 'session_b' // Captured-session pending work still owns refusal.
    held.resolve(true)
  }
  await deleting
  assert.equal(requests.length, 0)
  assert.equal(scope.clipVault.length, 1)
})

for (const kind of ['single', 'bulk']) test(`Clip ${kind} delete keeps captured target across its confirmation await`, async () => {
  const scope = clipOwnerScope(), held = deferred(), entered = deferred(), requests = []
  const clip = { id: 'clip_a', filename: 'a.txt', isClipped: false }
  Object.assign(scope, { pageData: { user: { id: 'user_a' } }, clipVault: [clip, { id: 'clip_b' }], userClipVault: [clip], selectedClipIds: ['clip_a'],
    bulkDeleteBusy: false, bulkDeleteMode: false, confirmDialog: () => { entered.resolve(); return held.promise }, toast: { error() {}, success() {} } })
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return response({ success: true }) }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte', ['deleteClip', 'deleteSelectedClips', 'clipDeleteBlocked'], scope)
  const deleting = kind === 'single' ? panel.deleteClip(clip) : panel.deleteSelectedClips()
  await entered.promise
  scope.selectedClipIds = ['clip_b']
  clip.id = 'clip_c'; clip.filename = 'Changed after confirmation.txt'
  held.resolve(true); await deleting
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.method, 'DELETE')
  if (kind === 'single') assert.equal(requests[0].url, '/api/clips/clip_a')
  else assert.deepEqual(JSON.parse(requests[0].init.body), { clipIds: ['clip_a'] })
})

for (const kind of ['single', 'bulk']) test(`Clip ${kind} delete refuses while the imported attachment POST response is still pending`, async () => {
  const scope = clipOwnerScope(), postHeld = deferred(), postEntered = deferred(), confirmHeld = deferred(), confirmEntered = deferred()
  const requests = [], clip = { id: 'clip_a', filename: 'a.txt', isClipped: false }
  let confirmations = 0
  Object.assign(scope, { pageData: { user: { id: 'user_a' } }, clipVault: [clip], userClipVault: [clip], selectedClipIds: ['clip_a'],
    bulkDeleteBusy: false, bulkDeleteMode: false,
    confirmDialog: () => { confirmations++; confirmEntered.resolve(); return confirmHeld.promise } })
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') return response({ files: [uploaded('clip_b')] })
    if (url === '/api/clips/clip_b') return response({ id: 'clip_b', systemClip: false })
    if (url === '/api/session-clips/state') { postEntered.resolve(); await postHeld.promise; return response(state(['clip_b'])) }
    if (url === '/api/session-clips/state/session_a') return response(state(['clip_b']))
    if (init.method === 'DELETE') return response({ success: true })
    throw new Error('Unexpected ' + url)
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte',
    ['uploadFilesInternal', 'upsertClip', 'deleteClip', 'deleteSelectedClips', 'clipDeleteBlocked', 'toggleClip', 'setClipOneTimeMode', 'unclipAll'], scope)
  // Bulk owns a confirmation already open before the import; single tries
  // deletion after the POST is issued. Both must refuse before their DELETE.
  const deleting = kind === 'bulk' ? panel.deleteSelectedClips() : undefined
  if (deleting) await confirmEntered.promise
  const importing = panel.uploadFilesInternal([new File(['bytes'], 'b.txt')], { sessionId: 'session_a', attach: true })
  await postEntered.promise
  assert.equal(scope.clipAttachmentFlightSession, 'session_a')
  if (deleting) { confirmHeld.resolve(true); await deleting }
  else await panel.deleteClip(clip)
  await panel.toggleClip(clip)
  await panel.setClipOneTimeMode('clip_a', true)
  await panel.unclipAll()
  assert.equal(requests.filter(entry => entry.init.method === 'DELETE').length, 0)
  assert.equal(requests.filter(entry => entry.url === '/api/session-clips/state').length, 1)
  assert.equal(confirmations, kind === 'bulk' ? 1 : 0)
  postHeld.resolve()
  const result = await importing
  assert.equal(result.status, 'completed')
  assert.equal(scope.clipAttachmentFlightSession, null)
  confirmHeld.resolve(true)
  if (kind === 'single') await panel.deleteClip(clip)
  else await panel.deleteSelectedClips()
  assert.equal(requests.filter(entry => entry.init.method === 'DELETE').length, 1)
})

async function crossSessionClipDeleteHarness(completion) {
  const scope = clipOwnerScope(), held = deferred(), entered = deferred(), requests = [], notices = []
  // X is already in A's whole state. The imported POST adds Y, so deleting X
  // in another chat would race the old snapshot even though X is not imported.
  const clip = { id: 'clip_x', filename: 'x.txt', isClipped: true }
  const serverStates = new Map([['session_a', ['clip_x']], ['session_b', []]])
  let lateWrite
  Object.assign(scope, { pageData: { user: { id: 'user_a' } }, clipVault: [clip], clippedItems: [clip], userClipVault: [clip],
    selectedClipIds: ['clip_x'], bulkDeleteBusy: false, bulkDeleteMode: false,
    toast: { loading: () => 1, dismiss() {}, success() {}, error: value => notices.push(value) }, confirmDialog: async () => true })
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    if (url === '/api/user/settings') return response({ settings: null })
    if (url === '/api/uploads/clips') return response({ files: [uploaded('clip_y')] })
    if (url === '/api/clips/clip_y') return response({ id: 'clip_y', systemClip: false })
    if (url === '/api/session-clips/state') {
      const payload = JSON.parse(init.body)
      const existing = serverStates.get(payload.sessionId) ?? []
      const next = payload.action === 'detach' ? existing.filter(id => id !== payload.clipId)
        : payload.action === 'update_duration' ? [...existing] : [...new Set([...existing, payload.clipId])]
      if (payload.sessionId === 'session_a') {
        lateWrite = () => serverStates.set('session_a', next)
        entered.resolve()
        if (completion === 'lost') throw new Error('Browser response lost while the whole-state write is pending')
        await held.promise
      }
      serverStates.set(payload.sessionId, next)
      return response({ ...state(next), sessionId: payload.sessionId })
    }
    if (url.startsWith('/api/session-clips/state/')) {
      const target = decodeURIComponent(url.split('/').at(-1))
      if (init.method === 'DELETE') serverStates.set(target, [])
      return response({ ...state(serverStates.get(target) ?? []), sessionId: target })
    }
    if (init.method === 'DELETE' && (url === '/api/clips' || url.startsWith('/api/clips/'))) {
      const ids = url === '/api/clips' ? JSON.parse(init.body).clipIds : [url.split('/').at(-1)]
      // Match the real permanent-delete owner: remove from every user session.
      for (const [target, existing] of serverStates) serverStates.set(target, existing.filter(id => !ids.includes(id)))
      return response({ success: true })
    }
    throw new Error('Unexpected ' + url)
  }
  const panel = await panelFunctions('clips/ClipsManagerDropdown.svelte',
    ['uploadFilesInternal', 'upsertClip', 'applySessionStateToVault', 'refreshUnresolvedAttachments', 'deleteClip', 'deleteSelectedClips', 'clipDeleteBlocked', 'toggleClip', 'setClipOneTimeMode', 'unclipAll'], scope)
  const importing = () => panel.uploadFilesInternal([new File(['bytes'], 'y.txt')], { sessionId: 'session_a', attach: true })
  return { scope, panel, clip, importing, entered, requests, notices, serverStates,
    release() { if (!lateWrite) throw new Error('No admitted write'); lateWrite(); held.resolve() },
    permanentDeletes: () => requests.filter(({ url, init }) => init.method === 'DELETE' && url.startsWith('/api/clips')) }
}

for (const kind of ['single', 'bulk']) for (const nextSession of ['session_b', null]) for (const completion of ['pending', 'lost']) {
  test(`BL-1193 ${kind} permanent delete after A→${nextSession ?? 'null'} refuses an A ${completion} whole-state attachment`, async () => {
    const h = await crossSessionClipDeleteHarness(completion)
    let confirmations = 0
    h.scope.confirmDialog = async () => { confirmations++; return true }
    const importing = h.importing()
    await h.entered.promise
    if (completion === 'lost') {
      const result = await importing
      assert.equal(result.status, 'unknown_outcome')
      assert.deepEqual(result.import.unsettledIds, ['clip_y'])
    }
    h.scope.sessionId = nextSession
    const deleting = () => kind === 'single' ? h.panel.deleteClip(h.clip) : h.panel.deleteSelectedClips()
    await deleting()
    assert.equal(h.permanentDeletes().length, 0)
    assert.equal(confirmations, 0)
    assert.ok(h.notices.some(value => value.includes('this or another chat') && value.includes('Deleting Clips could race')))
    assert.equal(h.requests.filter(entry => entry.url === '/api/session-clips/state').length, 1)
    h.release()
    assert.deepEqual(h.serverStates.get('session_a'), ['clip_x', 'clip_y'])
    if (completion === 'lost') {
      // Positive readback can prove presence, never retire unknown completion.
      h.scope.sessionId = 'session_a'
      await h.panel.refreshUnresolvedAttachments()
      h.scope.sessionId = nextSession
      await deleting()
      assert.equal(h.permanentDeletes().length, 0)
      assert.equal(confirmations, 0)
    } else {
      assert.equal((await importing).status, 'completed')
      // A genuinely returned handler with no sticky uncertainty releases this
      // local admission hold; captured X can then be removed across sessions.
      await deleting()
      assert.equal(h.permanentDeletes().length, 1)
      assert.deepEqual(h.serverStates.get('session_a'), ['clip_y'])
    }
  })
}

for (const kind of ['single', 'bulk']) for (const completion of ['pending', 'lost']) {
  test(`BL-1193 ${kind} held B confirmation refuses when A ${completion} attachment appears before returning to B`, async () => {
    const h = await crossSessionClipDeleteHarness(completion), confirmed = deferred(), entered = deferred()
    h.scope.sessionId = 'session_b'
    h.scope.confirmDialog = () => { entered.resolve(); return confirmed.promise }
    const deleting = kind === 'single' ? h.panel.deleteClip(h.clip) : h.panel.deleteSelectedClips()
    await entered.promise
    h.scope.sessionId = 'session_a'
    const importing = h.importing()
    await h.entered.promise
    if (completion === 'lost') await importing
    h.scope.sessionId = 'session_b'
    confirmed.resolve(true)
    await deleting
    assert.equal(h.permanentDeletes().length, 0)
    assert.ok(h.notices.some(value => value.includes('this or another chat')))
    assert.equal(h.requests.filter(entry => entry.url === '/api/session-clips/state').length, 1)
    h.release()
    if (completion === 'pending') await importing
    assert.deepEqual(h.serverStates.get('session_a'), ['clip_x', 'clip_y'])
  })
}

test('BL-1193 permanent-delete hold does not block ordinary B attachment, duration or detach after lost A completion', async () => {
  const h = await crossSessionClipDeleteHarness('lost')
  await h.importing()
  h.scope.sessionId = 'session_b'
  h.clip.isClipped = false
  await h.panel.toggleClip(h.clip)
  await h.panel.setClipOneTimeMode('clip_x', true)
  await h.panel.unclipAll()
  const bActions = h.requests.filter(entry => entry.url === '/api/session-clips/state').map(entry => JSON.parse(entry.init.body)).filter(body => body.sessionId === 'session_b')
  assert.deepEqual(bActions.map(body => body.action), ['attach', 'update_duration'])
  assert.ok(h.requests.some(entry => entry.url === '/api/session-clips/state/session_b' && entry.init.method === 'DELETE'))
  assert.equal(h.permanentDeletes().length, 0)
  assert.deepEqual(h.scope.clipAttachmentUnresolved[0].unsettledIds, ['clip_y'])
  h.release()
})
