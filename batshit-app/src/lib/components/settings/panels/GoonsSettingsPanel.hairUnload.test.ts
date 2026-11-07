// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createHairState } from '$lib/goons/hairAssets'
import { snapshotHairImportEditorContext } from '$lib/components/goons/hair-import/hairImportUiState'

/** Execute the panel's actual beforeunload effect, using the same source extraction
 * pattern as GoonsSettingsPanel.writerContracts.test.ts. */
function panelUnloadEffect(context: { goonsUnsavedState: object | null; editorHairImportOpen: boolean }) {
  const script = readFileSync('src/lib/components/settings/panels/GoonsSettingsPanel.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('GoonsSettingsPanel.ts', script, ts.ScriptTarget.Latest, true)
  const effect = file.statements.find((statement) => ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) && statement.expression.expression.getText(file) === '$effect' &&
    statement.getText(file).includes("window.addEventListener('beforeunload'"))
  if (!effect) throw new Error('The panel beforeunload effect was not found')
  const js = ts.transpileModule(effect.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let cleanup: (() => void) | undefined
  const scope = new Proxy({ ...context, window, hasActiveHairImport: () => context.editorHairImportOpen,
    $effect: (fn: () => (() => void) | undefined) => { cleanup = fn() } }, {
    has: () => true,
    get(target, key) { return typeof key === 'symbol' ? undefined : key in target ? Reflect.get(target, key) : Reflect.get(globalThis, key) }
  })
  new Function('scope', `with (scope) { ${js} }`)(scope)
  return () => cleanup?.()
}

function panelHairImportActive(context: { editorHairImportOpen: boolean; hairImportRefitAsset: object | null; hairImportInitialFile: object | null }) {
  const script = readFileSync('src/lib/components/settings/panels/GoonsSettingsPanel.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('GoonsSettingsPanel.ts', script, ts.ScriptTarget.Latest, true)
  const declaration = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'hasActiveHairImport')
  if (!declaration) throw new Error('The panel Hair ownership predicate was not found')
  const js = ts.transpileModule(declaration.getText(file).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('scope', `with (scope) { ${js}; return hasActiveHairImport() }`)(context) as boolean
}

function unloadWasPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function panelRefitOpen(context: Record<string, unknown>) {
  const script = readFileSync('src/lib/components/settings/panels/GoonsSettingsPanel.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('GoonsSettingsPanel.ts', script, ts.ScriptTarget.Latest, true)
  const names = new Set(['openEditorHairRefit', 'resetEditorHairImportContext'])
  const declarations = file.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text))
  if (declarations.length !== names.size) throw new Error('The panel Hair refit owners were not found')
  const js = ts.transpileModule(declarations.map((item) => item.getText(file)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const scope = new Proxy(context, {
    has: () => true,
    get(target, key) { return typeof key === 'symbol' ? undefined : key in target ? Reflect.get(target, key) : Reflect.get(globalThis, key) },
    set(target, key, value) { return Reflect.set(target, key, value) }
  })
  return new Function('scope', `with (scope) { ${js}; return openEditorHairRefit }`)(scope) as (asset: object, source: object) => Promise<void>
}

describe('Goon editor Hair import unload protection', () => {
  it('keeps ownership during initial-file or refit setup as well as the open wizard', () => {
    expect(panelHairImportActive({ editorHairImportOpen: false, hairImportRefitAsset: null, hairImportInitialFile: null })).toBe(false)
    expect(panelHairImportActive({ editorHairImportOpen: true, hairImportRefitAsset: null, hairImportInitialFile: null })).toBe(true)
    expect(panelHairImportActive({ editorHairImportOpen: false, hairImportRefitAsset: {}, hairImportInitialFile: null })).toBe(true)
    expect(panelHairImportActive({ editorHairImportOpen: false, hairImportRefitAsset: null, hairImportInitialFile: {} })).toBe(true)
  })

  it('holds refit ownership while opening and clears it only after failed-opening cleanup', async () => {
    let rejectOpening!: (error: Error) => void
    const pending = new Promise<never>((_, reject) => { rejectOpening = reject })
    const context: Record<string, any> = {
      editorGoonId: 'owned-goon', editorHairSupported: true, editorHairImportOpen: false,
      hairPreviewOperation: 0,
      hairImportRefitAsset: null, hairImportInitialFile: null, hairMotionPaintResolver: null,
      editorHairState: createHairState(null), editorAppearanceDialsState: null,
      snapshotHairImportEditorContext, previewEngine: null,
      ensurePreviewGoonReady: vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(null),
      toast: { error: vi.fn() }
    }
    const open = panelRefitOpen(context)
    const asset = { assetId: 'hair', revisionId: 'hair-r1', display: { name: 'Hair' } }
    const operation = open(asset, { assetId: 'hair', revisionId: 'hair-r1' })
    expect(panelHairImportActive(context as any)).toBe(true)
    rejectOpening(new Error('preview failed'))
    await operation
    expect(panelHairImportActive(context as any)).toBe(false)
    expect(context.hairPreviewBusy).toBe(false)
    expect(context.toast.error).toHaveBeenCalledWith('preview failed')
  })

  it('warns for an unfinished Hair fit and clears only after close, preserving other dirty warnings', () => {
    let cleanup = panelUnloadEffect({ goonsUnsavedState: null, editorHairImportOpen: false })
    expect(unloadWasPrevented()).toBe(false)
    cleanup()
    cleanup = panelUnloadEffect({ goonsUnsavedState: null, editorHairImportOpen: true })
    expect(unloadWasPrevented()).toBe(true)
    cleanup()
    cleanup = panelUnloadEffect({ goonsUnsavedState: { message: 'other edit' }, editorHairImportOpen: false })
    expect(unloadWasPrevented()).toBe(true)
    cleanup()
    cleanup = panelUnloadEffect({ goonsUnsavedState: null, editorHairImportOpen: false })
    expect(unloadWasPrevented()).toBe(false)
    cleanup()
  })
})
