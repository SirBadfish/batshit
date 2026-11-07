import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('keeps only the newest same-engine Dock Closet intent current, including A to B to A', () => {
  const script = readFileSync('src/lib/components/goons/GoonDock.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('GoonDock.ts', script, ts.ScriptTarget.Latest, true)
  const owner = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'applyClosetAssignments')
  const effect = file.statements.find((s) => ts.isExpressionStatement(s) &&
    ts.isCallExpression(s.expression) && s.expression.expression.getText(file) === '$effect' &&
    s.getText(file).includes('lastClosetSignature = signature'))
  if (!owner || !effect) throw new Error('Dock Closet owners were not found')
  const js = ts.transpileModule(owner.getText(file) + '\n' + effect.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let run!: () => void
  const apply = vi.fn().mockResolvedValue(undefined)
  const scope: Record<string, any> = {
    engine: { resetMaterialOverrides: vi.fn() }, goon: { id: 'goon' }, goonsSettings: null,
    signature: 'A', lastClosetSignature: '', closetRuntimeRequest: 0,
    buildClosetRuntimeSignature: () => scope.signature, resolveGoonKind: () => 'vrm',
    applyMountedLiveGoonClosetAssignments: apply, $effect: (fn: () => void) => { run = fn }
  }
  const proxy = new Proxy(scope, {
    has: () => true,
    get(target, key) { return typeof key === 'symbol' ? undefined : key in target ? Reflect.get(target, key) : Reflect.get(globalThis, key) },
    set(target, key, value) { return Reflect.set(target, key, value) }
  })
  new Function('scope', `with (scope) { ${js} }`)(proxy)
  run(); scope.signature = 'B'; run(); scope.signature = 'A'; run()
  expect(apply).toHaveBeenCalledTimes(3)
  const guards = apply.mock.calls.map((call) => call[1].isCurrent as () => boolean)
  expect(guards.map((guard) => guard())).toEqual([false, false, true])
  scope.engine = { resetMaterialOverrides: vi.fn() }
  expect(guards[2]!()).toBe(false)
})
