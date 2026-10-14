import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * BL-704 (D5) — the portable lane's admission list, pinned in the source.
 *
 * `resolveNativeToolUser` admits a Portable Skill Token only when its caller passes one of two
 * server-code policy constants. This file parses every non-test TypeScript file under `src/` and
 * holds the call sites to the reviewed list:
 *
 *   - exactly these 22 route files call the resolver (a new caller fails here, so someone has
 *     to decide on purpose whether it may ever see the portable lane);
 *   - only `/api/controls/find` passes a policy (scoped discovery) and only `/api/controls/use`
 *     passes one (scoped execution), each as the bare exported constant;
 *   - no call spreads anything into its options, no file imports the resolver under another
 *     name or hands it around as a value, and the two constants appear nowhere else.
 *
 * A source pin alone proves nothing about behavior: `nativeToolAuth.portable.test.ts` and
 * `portableSkillRouteAdmission.test.ts` prove what the real resolver and the real routes do.
 */

// Vitest runs from `batshit-app/` (its config root), so the source tree is `./src`.
const SRC = path.resolve(process.cwd(), 'src')
const RESOLVER_FILE = 'lib/server/services/nativeToolAuth.ts'
const POLICY_OPTION = 'portableSkillPolicy'
const PORTABLE_TOKENS_FILE = 'lib/server/services/portableSkillTokens.ts'
const POLICY_CONSTANTS = ['PORTABLE_SKILL_SCOPED_DISCOVERY', 'PORTABLE_SKILL_SCOPED_EXECUTION']

const EXPECTED_OPT_INS: Record<string, string> = {
  'routes/api/controls/find/+server.ts': 'PORTABLE_SKILL_SCOPED_DISCOVERY',
  'routes/api/controls/use/+server.ts': 'PORTABLE_SKILL_SCOPED_EXECUTION'
}

const EXPECTED_CALLERS = [
  'routes/api/artifacts/analyze/+server.ts',
  'routes/api/artifacts/comfyui/[...path]/+server.ts',
  'routes/api/artifacts/complete/+server.ts',
  'routes/api/artifacts/pinokio/[...path]/+server.ts',
  'routes/api/artifacts/run-event/+server.ts',
  'routes/api/artifacts/share/+server.ts',
  'routes/api/cli-tools/execute/+server.ts',
  'routes/api/cli-tools/find/+server.ts',
  'routes/api/controls/find/+server.ts',
  'routes/api/controls/use/+server.ts',
  'routes/api/mcp/tools/execute/+server.ts',
  'routes/api/mcp/tools/find/+server.ts',
  'routes/api/memory/recall-media/+server.ts',
  'routes/api/native-tools/agent-browser/+server.ts',
  'routes/api/native-tools/bash/execute/+server.ts',
  'routes/api/native-tools/dispatch/+server.ts',
  'routes/api/native-tools/fetch-zip/+server.ts',
  'routes/api/native-tools/guard-result/+server.ts',
  'routes/api/native-tools/sandbox/status/+server.ts',
  'routes/api/native-tools/web-search/+server.ts',
  'routes/api/skills/runtime/+server.ts',
  'routes/api/subagents/managed-execute/+server.ts'
]

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      listSourceFiles(full, out)
    } else if (
      entry.isFile() &&
      /\.(ts|js)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|js)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

type CallSite = { file: string; policy: string | null; problems: string[] }

function scan() {
  const calls: CallSite[] = []
  const problems: string[] = []
  const constantUses = new Map<string, string[]>()

  for (const full of listSourceFiles(SRC)) {
    const text = readFileSync(full, 'utf8')
    if (!text.includes('resolveNativeToolUser') && !POLICY_CONSTANTS.some((name) => text.includes(name))) {
      continue
    }
    const file = path.relative(SRC, full).split(path.sep).join('/')
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    const visit = (node: ts.Node) => {
      if (ts.isImportSpecifier(node)) {
        const imported = (node.propertyName ?? node.name).text
        if (imported === 'resolveNativeToolUser' && node.name.text !== imported) {
          problems.push(`${file}: imports resolveNativeToolUser under another name`)
        }
      }

      if (ts.isIdentifier(node) && POLICY_CONSTANTS.includes(node.text) && file !== RESOLVER_FILE) {
        if (!ts.isImportSpecifier(node.parent)) {
          constantUses.set(node.text, [...(constantUses.get(node.text) ?? []), file])
        }
      }

      if (ts.isIdentifier(node) && node.text === 'resolveNativeToolUser' && file !== RESOLVER_FILE) {
        const parent = node.parent
        const isCallee = ts.isCallExpression(parent) && parent.expression === node
        const isImport = ts.isImportSpecifier(parent)
        const isTypeQuery = ts.isTypeQueryNode(parent)
        if (!isCallee && !isImport && !isTypeQuery) {
          problems.push(`${file}: uses resolveNativeToolUser as a value, not a direct call`)
        }
        if (isCallee) {
          const call = parent as ts.CallExpression
          const site: CallSite = { file, policy: null, problems: [] }
          const [options] = call.arguments
          if (call.arguments.length !== 1 || !options || !ts.isObjectLiteralExpression(options)) {
            site.problems.push('options are not one object literal')
          } else {
            for (const property of options.properties) {
              if (ts.isSpreadAssignment(property)) {
                site.problems.push('spreads into the options')
                continue
              }
              const name = property.name && ts.isIdentifier(property.name) ? property.name.text : null
              if (name === null) site.problems.push('has a computed or quoted option name')
              if (name !== POLICY_OPTION) continue
              if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
                site.policy = property.initializer.text
              } else {
                site.problems.push(`${POLICY_OPTION} is not a bare constant`)
              }
            }
          }
          calls.push(site)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { calls, problems, constantUses }
}

describe('BL-704: the portable lane is admitted only by the two control routes', () => {
  const { calls, problems, constantUses } = scan()

  it('finds every caller, and the caller list is exactly the reviewed 22 route files', () => {
    const files = [...new Set(calls.map((call) => call.file))].sort()
    expect(files).toEqual([...EXPECTED_CALLERS].sort())
    expect(calls).toHaveLength(EXPECTED_CALLERS.length)
  })

  it('only /api/controls/find and /api/controls/use pass a portable policy, each its own constant', () => {
    const optedIn = Object.fromEntries(
      calls.filter((call) => call.policy !== null).map((call) => [call.file, call.policy])
    )
    expect(optedIn).toEqual(EXPECTED_OPT_INS)
  })

  it('no call spreads into its options, and nothing aliases or passes the resolver around', () => {
    expect(problems).toEqual([])
    expect(calls.filter((call) => call.problems.length > 0)).toEqual([])
  })

  it('only the resolver reads the portable header or validates a portable token', () => {
    // A second path that read the header or called the validator itself would bypass the
    // admission policy, and the caller list above would not see it (BL-704 review).
    const readers = listSourceFiles(SRC)
      .filter((full) =>
        /validatePortableSkillToken|PORTABLE_SKILL_TOKEN_HEADER|x-batshit-portable-token/.test(
          readFileSync(full, 'utf8')
        )
      )
      .map((full) => path.relative(SRC, full).split(path.sep).join('/'))
      .sort()
    expect(readers).toEqual([PORTABLE_TOKENS_FILE, RESOLVER_FILE].sort())
  })

  it('the policy constants are used only by their one route each', () => {
    expect(Object.fromEntries(constantUses)).toEqual({
      PORTABLE_SKILL_SCOPED_DISCOVERY: ['routes/api/controls/find/+server.ts'],
      PORTABLE_SKILL_SCOPED_EXECUTION: ['routes/api/controls/use/+server.ts']
    })
  })
})
