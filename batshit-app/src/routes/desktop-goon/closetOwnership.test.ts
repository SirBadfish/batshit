import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('invalidates an in-flight Desktop Closet refresh when the Goon load changes', async () => {
  const script = readFileSync('src/routes/desktop-goon/+page.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('DesktopGoon.ts', script, ts.ScriptTarget.Latest, true)
  const owner = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'applyClosetRefresh')
  if (!owner) throw new Error('Desktop Closet owner was not found')
  const js = ts.transpileModule(owner.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const apply = vi.fn((_engine: unknown, _context: any) => pending)
  const updated = '2026-11-06T00:00:00.000Z'
  const scope: Record<string, any> = {
    loadGeneration: 1, engine: { resetMaterialOverrides: vi.fn() },
    snapshot: { goon: { goonId: 'goon', recordUpdatedAt: 'old' } },
    loadGoons: async () => [{ id: 'goon', updated_at: updated }],
    refreshUserSettingsRequest: async () => ({ goons_settings: {} }),
    normalizeGoonsSettings: (settings: unknown) => settings,
    applyMountedLiveGoonClosetAssignments: apply, statusMessage: '', errorMessage: null
  }
  const proxy = new Proxy(scope, {
    has: () => true,
    get(target, key) { return typeof key === 'symbol' ? undefined : key in target ? Reflect.get(target, key) : Reflect.get(globalThis, key) },
    set(target, key, value) { return Reflect.set(target, key, value) }
  })
  const run = new Function('scope', `with (scope) { ${js}; return applyClosetRefresh }`)(proxy)
  const operation = run('goon', updated)
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
  const isCurrent = apply.mock.calls[0]![1].isCurrent as () => boolean
  expect(isCurrent()).toBe(true)
  scope.loadGeneration += 1
  expect(isCurrent()).toBe(false)
  finish()
  await operation
  expect(scope.snapshot.goon.recordUpdatedAt).toBe('old')
})
