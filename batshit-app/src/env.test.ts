// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { variables } from './env'

const forwardedOwners = [
  'src/hooks.server.ts',
  'src/lib/server/services/hostedAppGuard.ts',
  'src/lib/server/services/appActions/policy.ts',
  'src/lib/server/services/runtimeContext.ts',
  'src/lib/server/services/runtimeUrlRewrites.ts',
  'src/lib/server/services/cliHelperBaseUrl.ts',
  'src/lib/server/services/dockerGatewayConfig.ts',
  'src/lib/server/services/cliExecutableResolution.ts',
  'src/lib/server/services/projectPathValidation.ts',
  'src/lib/server/services/liveKitVoiceRuntime.ts',
  'src/lib/server/services/liveKitSidecarUrls.ts',
  'src/lib/server/services/diagnosticsExportService.ts',
  'src/lib/server/services/n8nRuntimeStatus.ts',
  'src/lib/server/services/typesafe/typesafe.constants.ts',
  '../batshit-server/server/src/utils/macCustodyPaths.cjs'
] as const
const computedOwners = new Set([
  'typedFileToolsHost.server.ts', 'typedFileWorkspaceAdmission.server.ts',
  'voiceRealtimeSttRuntime.ts', 'voiceService.ts', 'updateStatusService.ts',
  'configuredTtsAccountCatalog.ts', 'configuredTtsSources.ts', 'modelPresetSelectionOwner.ts',
  'runtimeEnv.ts', 'typesafeAvailability.ts'
])
const keyArrays = new Set([
  'PROVIDER_KEY_CONFIG', 'CREDENTIALS', 'DIRECT_SOURCE_ENV_VARS',
  'GOOGLE_API_KEY_ENV_NAMES', 'FISH_ENV_NAMES', 'TYPESAFE_API_KEY_ENV',
  'valueKeys', 'presenceKeys'
])
const keyCalls = new Set([
  'getRuntimeEnv', 'requireRuntimeEnv', 'configured', 'readEnv',
  'firstEnvValue', 'resolveApiKey', 'resolveApiKeyValue'
])
const envName = /^[A-Z][A-Z0-9_]*$/

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
  return node
}

async function sources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'test-utils') continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(file))
    else if (/\.(?:ts|js|cjs|mjs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) files.push(file)
  }
  return files
}

describe('the explicit Kit environment preserves supported runtime configuration', () => {
  it('keeps all declared variables dynamic and optional without collapsing blank or zero', () => {
    for (const configuration of Object.values(variables)) {
      expect(configuration.static).toBe(false)
      for (const value of [undefined, '', '0', 'runtime-value']) {
        expect(configuration.schema['~standard'].validate(value)).toEqual({ value })
      }
    }
    expect(Object.keys(variables).filter(key => variables[key as keyof typeof variables].public)).toEqual([
      'PUBLIC_BASE_URL', 'PUBLIC_BATSHIT_APP_VERSION', 'PUBLIC_BATSHIT_SERVER_API_URL', 'PUBLIC_BATSHIT_SERVER_URL'
    ])
  })

  it('covers imported, cast-wrapped, finite-computed and delegated environment readers', async () => {
    const files = new Set([...await sources('src'), ...forwardedOwners])
    const required = new Map<string, string>()
    const excludedFromPrivate = new Set<string>()
    const unreviewed: string[] = []
    const add = (name: string, file: string) => {
      if (!envName.test(name)) return
      // A PUBLIC_ fallback delegated through a private map was previously undefined.
      // It must stay excluded there; declaring a new browser export is unnecessary.
      if (name.startsWith('PUBLIC_')) excludedFromPrivate.add(name)
      else required.set(name, file)
    }
    const fileList = [...files]
    for (let offset = 0; offset < fileList.length; offset += 32) {
      const batch = await Promise.all(fileList.slice(offset, offset + 32).map(async file => ({
        file, text: await readFile(file, 'utf8')
      })))
      for (const { file, text } of batch) {
        // This visitor reads children and source positions, never parent links.
        const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
        const aliases = new Set<string>()
        const publicAliases = new Set<string>()
        for (const statement of ast.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('$env/')) continue
          const bindings = statement.importClause?.namedBindings
          if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
            if ((item.propertyName ?? item.name).text === 'env') {
              aliases.add(item.name.text)
              if (statement.moduleSpecifier.text.endsWith('/public')) publicAliases.add(item.name.text)
            }
          }
        }
        const delegated = forwardedOwners.some(owner => path.normalize(owner) === path.normalize(file))
        const strings = (node: ts.Node) => {
          if (ts.isStringLiteralLike(node)) add(node.text, file)
          ts.forEachChild(node, strings)
        }
        const visit = (node: ts.Node) => {
          if (ts.isPropertyAccessExpression(node)) {
            const source = unwrap(node.expression)
            if (delegated || (ts.isIdentifier(source) && aliases.has(source.text))) {
              if (ts.isIdentifier(source) && publicAliases.has(source.text)) required.set(node.name.text, file)
              else add(node.name.text, file)
            }
          }
          if (ts.isElementAccessExpression(node) && node.argumentExpression) {
            const source = unwrap(node.expression)
            if (ts.isIdentifier(source) && aliases.has(source.text)) {
              const argument = unwrap(node.argumentExpression)
              if (ts.isStringLiteralLike(argument)) {
                if (publicAliases.has(source.text)) required.set(argument.text, file)
                else add(argument.text, file)
              }
              else if (ts.isIdentifier(argument) && argument.text === 'TYPESAFE_API_KEY_ENV') add('TYPESAFE_API_KEY', file)
              else if (!computedOwners.has(path.basename(file))) unreviewed.push(`${file}:${ast.getLineAndCharacterOfPosition(node.pos).line + 1}`)
            }
          }
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && keyArrays.has(node.name.text) && node.initializer) strings(node.initializer)
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && keyCalls.has(node.expression.text) && (aliases.size || delegated || node.expression.text.endsWith('RuntimeEnv'))) {
            for (const argument of node.arguments) strings(argument)
          }
          ts.forEachChild(node, visit)
        }
        visit(ast)
      }
    }
    expect(unreviewed, 'a new computed environment reader needs a finite source-family review').toEqual([])
    const missing = [...required].filter(([name]) => !(name in variables)).map(([name, file]) => `${name} (${file})`)
    expect(missing).toEqual([])
    for (const name of required.keys()) {
      expect(Boolean(variables[name as keyof typeof variables].public), name).toBe(name.startsWith('PUBLIC_'))
    }
    for (const name of excludedFromPrivate) {
      expect(name in variables ? variables[name as keyof typeof variables].public : true, name).not.toBe(false)
    }
  })
})
