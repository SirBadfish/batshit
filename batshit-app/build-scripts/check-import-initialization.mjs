#!/usr/bin/env node
/**
 * declared-loads-v2: zero cycles in the explicitly declared-load graph, with a
 * complete dependency inventory. Causal initialization proof is NOT_PERFORMED.
 * Run from the owning app after its own generated/config inputs are ready.
 * No application source module is imported or executed by this build tool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const codeExtension = /\.(?:[cm]?[jt]s|svelte)$/;
export const contract = 'declared-loads-v2';
const slash = (name) => name.replaceAll(path.sep, '/');
const inside = (root, name) => name === root || name.startsWith(`${root}${path.sep}`);
const fullWorkLimit = 100000000;
function selectedWorkLimit(diagnosticWorkLimit) {
  if (diagnosticWorkLimit === undefined) return fullWorkLimit;
  if (!Number.isSafeInteger(diagnosticWorkLimit) || diagnosticWorkLimit < 1 || diagnosticWorkLimit > fullWorkLimit) throw new Error(`diagnosticWorkLimit must be a positive integer no greater than ${fullWorkLimit}; diagnostics may only lower the full workload bound`);
  return diagnosticWorkLimit;
}
export function parseImportGateArguments(args) {
  if (![2, 4].includes(args.length) || args[0] !== '--report' || !args[1] || (args.length === 4 && (args[2] !== '--diagnostic-work-limit' || !/^[0-9]+$/.test(args[3])))) throw new Error('Usage: node build-scripts/check-import-initialization.mjs --report <diagnostic.json> [--diagnostic-work-limit <lower-positive-integer>]');
  const diagnosticWorkLimit = args.length === 4 ? Number(args[3]) : undefined;
  selectedWorkLimit(diagnosticWorkLimit);
  return { reportPath: args[1], diagnosticWorkLimit };
}

// Iterative Tarjan keeps graph depth out of the JS call stack. The owning
// evaluator meters every node/edge; a partial result is never a zero-cycle proof.
export function cyclicGroups(graph, consume = () => true) {
  let next = 0;
  const indices = new Map(), lows = new Map(), pending = [], active = new Set(), self = new Set(), groups = [];
  for (const root of Object.keys(graph).sort()) {
    if (indices.has(root)) continue;
    const frames = [{node:root, parent:undefined, index:0, entered:false}];
    while (frames.length) {
      const frame = frames.at(-1), node = frame.node;
      if (!frame.entered) {
        if (!consume()) return groups;
        frame.entered = true; indices.set(node, next); lows.set(node, next++); pending.push(node); active.add(node);
      }
      const children = graph[node] ?? [];
      if (frame.index < children.length) {
        if (!consume()) return groups;
        const child = children[frame.index++];
        if (child === node) self.add(node);
        if (!indices.has(child)) frames.push({node:child, parent:node, index:0, entered:false});
        else if (active.has(child)) lows.set(node, Math.min(lows.get(node), indices.get(child)));
      } else {
        frames.pop();
        if (frame.parent !== undefined) lows.set(frame.parent, Math.min(lows.get(frame.parent), lows.get(node)));
        if (lows.get(node) === indices.get(node)) {
          const group = []; let child;
          do { child = pending.pop(); active.delete(child); group.push(child); } while (child !== node);
          if (group.length > 1 || self.has(node)) groups.push(group.sort());
        }
      }
    }
  }
  return groups.sort((a,b) => b.length-a.length || a[0].localeCompare(b[0]));
}

function packageRoot(specifier, from) {
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  for (let directory = path.dirname(from); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return { directory: path.dirname(candidate), manifest: JSON.parse(fs.readFileSync(candidate, 'utf8')) };
    if (directory === path.dirname(directory)) return undefined;
  }
}

// Package exports can be import-only (Kit 3), so require.resolve alone is not
// a runtime resolver. Check declared browser/server/import targets as external
// boundaries, excluding the types condition. No package code is executed.
function importExportTargets(pkg, specifier, mode = 'import') {
  const subpath = specifier === pkg.manifest.name ? '.' : `.${specifier.slice(pkg.manifest.name.length)}`;
  const exports = pkg.manifest.exports;
  let selected, replacement;
  if (typeof exports === 'string' || Array.isArray(exports) || (exports && !Object.keys(exports).some((name) => name.startsWith('.')))) {
    if (subpath === '.') selected = exports;
  } else if (exports) {
    selected = exports[subpath];
    if (selected === undefined) for (const pattern of Object.keys(exports).filter((name) => name.includes('*')).sort((a, b) => b.length - a.length)) {
      const [prefix, suffix] = pattern.split('*');
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        replacement = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
        selected = exports[pattern]; break;
      }
    }
  }
  const candidates = [];
  const conditions = new Set(mode === 'require' ? ['require', 'node', 'default', 'node-addons'] : ['import', 'browser', 'node', 'default', 'svelte', 'worker', 'development', 'production', 'module', 'node-addons']);
  function visit(value, trail = []) {
    if (typeof value === 'string' && value.startsWith('./')) {
      const filename = path.resolve(pkg.directory, replacement === undefined ? value : value.replaceAll('*', replacement));
      candidates.push({ target: filename, conditions: trail.length ? trail : ['unconditional'], valid: inside(pkg.directory, filename) && !/\.d\.[cm]?ts$/.test(filename) && fs.existsSync(filename) && fs.statSync(filename).isFile() });
    } else if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, [...trail, `fallback[${index}]`]));
    else if (value && typeof value === 'object') {
      for (const [condition, target] of Object.entries(value)) if (conditions.has(condition)) visit(target, [...trail, condition]);
    }
  }
  visit(selected);
  return candidates;
}

const frameworkCache = new Map();
/** Exact installed aliases/runtime wrappers, not historical virtual names. */
function virtualOwner(specifier, appRoot) {
  let kit = frameworkCache.get(appRoot);
  if (kit === undefined) {
    kit = packageRoot('@sveltejs/kit', path.join(appRoot, 'src', '_entry.ts')) ?? null;
    if (kit) {
      kit.aliases = new Set();
      const filename = path.join(kit.directory, 'src/exports/vite/index.js');
      if (fs.existsSync(filename)) {
        const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
        function aliases(node) {
          if (ts.isObjectLiteralExpression(node)) {
            const find = property(node, 'find'), replacement = property(node, 'replacement');
            if (find && ts.isStringLiteralLike(find) && ['$app', '$env'].includes(find.text) && replacement && ts.isTemplateExpression(replacement) && replacement.head.text === '' && replacement.templateSpans.length === 1 && replacement.templateSpans[0].expression.getText() === 'runtime_directory' && replacement.templateSpans[0].literal.text === `/${find.text.slice(1)}`) kit.aliases.add(find.text);
          }
          ts.forEachChild(node, aliases);
        }
        aliases(source);
      }
    }
    frameworkCache.set(appRoot, kit);
  }
  if (!kit) return undefined;
  const [prefix, ...parts] = specifier.split('/');
  if (!kit.aliases.has(prefix) || !parts.length || parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  const base = path.join(kit.directory, 'src/runtime', prefix.slice(1), ...parts);
  const target = [`${base}.js`, path.join(base, 'index.js')].find((filename) => fs.existsSync(filename));
  if (!target) return undefined;
  const qualification = specifier === '$app/manifest'
    ? ['src/core/sync/write_app_manifest.js', '5b49dcb5d72b35d0def55b923995a72b4b315fba7662a2d87ef91a536d20b222']
    : (/^\$app\/env\/(?:private|public)(?:\/|$)/.test(specifier) || specifier.startsWith('$env/'))
      ? ['src/core/env.js', '08bf71afa58e3d0a82ee5a19470e4636e97d17d4a64a6cefa43d9bd7601cc87a'] : undefined;
  const result = { owner: `SvelteKit ${kit.manifest.version} installed ${prefix} alias`, runtimeTarget: target, localRuntimeTargets: [] };
  if (qualification) {
    const owner = path.join(kit.directory, qualification[0]);
    const digest = fs.existsSync(owner) ? createHash('sha256').update(fs.readFileSync(owner)).digest('hex') : undefined;
    result.generatedOwner = { file: owner, sha256: digest, qualified: digest === qualification[1] };
    if (digest !== qualification[1]) result.unproved = `Generated virtual emitter requires qualification: ${qualification[0]}`;
    if (specifier !== '$app/manifest') {
      for (const [name, expected] of [
        ['src/utils/filesystem.js', 'b3fad859ae7a1c03385cfa9731589757561693935f741a7cb4832c7e1f9224a8'],
        ['src/core/config/options.js', '7433811a883b7991d1d45ec5ac9634ddbc696b99fbca7ea4b9555359d4764c85']
      ]) {
        const filename = path.join(kit.directory, name);
        if (!fs.existsSync(filename) || createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== expected) result.unproved = `Kit environment entry/default owner requires qualification: ${name}`;
      }
      const visited = new Set(), wrappers = [], generated = new Set();
      function wrapper(filename) {
        if (visited.has(filename)) return;
        visited.add(filename);
        if (visited.size > 32 || !inside(kit.directory, filename) || !fs.existsSync(filename)) { result.unproved = 'Kit environment wrapper dependency is unproved'; return; }
        wrappers.push(filename);
        const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
        for (const node of source.statements) if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const name = node.moduleSpecifier.text;
          if (/^<sveltekit:generated>\/env\/(?:config|(?:private|public)\/server|public\/client)\.js$/.test(name)) generated.add(name);
          else if (name.startsWith('<')) result.unproved = `Unqualified Kit generated wrapper target: ${name}`;
          else if (name.startsWith('.') && !name.includes('/messages/')) wrapper(path.resolve(path.dirname(filename), name));
          else if (name.startsWith('#app/')) {
            const targets = [];
            function conditions(value) {
              if (typeof value === 'string') targets.push(value);
              else if (value && typeof value === 'object') for (const [condition, target] of Object.entries(value)) if (condition !== 'types') conditions(target);
            }
            conditions(kit.manifest.imports?.[name]);
            if (!targets.length || targets.some((target) => !target.startsWith('./'))) result.unproved = `Kit conditional runtime alias is unproved: ${name}`;
            else for (const target of targets) wrapper(path.resolve(kit.directory, target));
          }
          else if (name.startsWith('#')) result.unproved = `Unqualified Kit wrapper alias: ${name}`;
          else if (name.startsWith('.') && !fs.existsSync(path.resolve(path.dirname(filename), name))) result.unproved = `Missing Kit wrapper boundary: ${name}`;
          else if (!name.startsWith('.')) {
            const pkg = packageRoot(name, filename);
            const targets = pkg && importExportTargets(pkg, name);
            if (!builtins.has(name) && (!targets?.length || targets.some((target) => !target.valid))) result.unproved = `Unqualified Kit wrapper package target: ${name}`;
          }
        }
        function dynamic(node) {
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) result.unproved = 'Kit environment wrapper has an unqualified dynamic dependency';
          ts.forEachChild(node, dynamic);
        }
        dynamic(source);
      }
      wrapper(target);
      result.wrapperTargets = wrappers;
      result.generatedTargets = [...generated];
      if (!generated.size) result.unproved = 'Kit environment wrapper no longer reaches the qualified generated environment';
      // Kit's default resolve_entry follows a directory index, then its sorted
      // directory entries with moduleExtensions ['.js', '.ts']. Legacy static
      // wrappers reach that same generated config/entry as the new namespace.
      const base = path.join(appRoot, 'src/env');
      function entryAt(base) {
        if (fs.existsSync(base)) {
          if (fs.statSync(base).isFile()) return base;
          if (['.js', '.ts'].some((extension) => fs.existsSync(path.join(base, `index${extension}`)))) return entryAt(path.join(base, 'index'));
        }
        const directory = path.dirname(base), name = path.basename(base);
        if (!fs.existsSync(directory)) return undefined;
        const match = fs.readdirSync(directory).find((file) => [name, `${name}.js`, `${name}.ts`].includes(file) && fs.statSync(path.join(directory, file)).isFile());
        return match && path.join(directory, match);
      }
      const entry = entryAt(base);
      if (entry && !codeExtension.test(entry)) result.unproved = 'Kit environment entry has an unqualified code extension';
      result.localRuntimeTargets = entry ? [entry] : [];
    }
  }
  return result;
}

const property = (object, name) => object?.properties?.find((node) => ts.isPropertyAssignment(node) && (node.name.text ?? node.name.getText()) === name)?.initializer;
function declarativeConfig(filename) {
  if (!fs.existsSync(filename)) return undefined;
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const exported = source.statements.find(ts.isExportAssignment)?.expression;
  function value(node, seen = new Set()) {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const bound = source.statements.filter(ts.isImportDeclaration).some((statement) => ['vitest/config', 'vite'].includes(statement.moduleSpecifier.text) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === 'defineConfig' && element.name.text === node.expression.text));
      if (bound) return value(node.arguments[0], seen);
    }
    if (ts.isIdentifier(node)) for (const statement of source.statements.filter(ts.isVariableStatement)) {
      const declaration = statement.declarationList.declarations.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.text);
      if (declaration) return value(declaration.initializer, seen);
    }
    return undefined;
  }
  return { source, object: value(exported) };
}
function safeConfigFields(object, fields) {
  if (!object || !ts.isObjectLiteralExpression(object)) return false;
  const found = new Set();
  function keys(node) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isConditionalExpression(node)) { const a = keys(node.whenTrue), b = keys(node.whenFalse); return a && b ? [...a, ...b] : undefined; }
    if (!ts.isObjectLiteralExpression(node) || node.properties.some((member) => ts.isSpreadAssignment(member) || (member.name && ts.isComputedPropertyName(member.name)))) return undefined;
    return node.properties.map((member) => member.name?.text);
  }
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) { const names = keys(member.expression); if (!names || names.some((name) => fields.includes(name))) return false; }
    else {
      if (member.name && ts.isComputedPropertyName(member.name)) return false;
      const name = member.name?.text;
      if (fields.includes(name)) { if (found.has(name) || !ts.isPropertyAssignment(member)) return false; found.add(name); }
    }
  }
  return true;
}

function applicationInputs(appRoot, sourceDirectory, config, problems) {
  const extensions = ['.ts', '.js', '.svelte', '.mts', '.cts', '.mjs', '.cjs'];
  const all = ts.sys.readDirectory(path.join(appRoot, sourceDirectory), extensions);
  const build = new Set(ts.sys.readDirectory(appRoot, extensions, config.exclude, config.include ?? [`${sourceDirectory}/**/*`]).map((name) => path.resolve(name)));
  const test = new Set(), helpers = new Set(), helperDirectories = new Set();
  const filename = path.join(appRoot, 'vitest.config.ts');
  const parsed = declarativeConfig(filename);
  function strings(node, label) {
    if (!node) return [];
    if (!ts.isArrayLiteralExpression(node) || node.elements.some((element) => !ts.isStringLiteralLike(element))) {
      problems.push({ reason: `Unsupported dynamic Vitest ${label}; test-only ownership cannot be inferred` });
      return [];
    }
    return node.elements.map((element) => element.text);
  }
  if (parsed) {
    const testOptions = property(parsed.object, 'test');
    if (!safeConfigFields(parsed.object, ['test']) || !safeConfigFields(testOptions, ['include', 'setupFiles', 'globalSetup'])) problems.push({ reason: 'Vitest configuration is not a proved declarative object' });
    else {
      const patterns = strings(property(testOptions, 'include'), 'include');
      if (patterns.length) for (const name of ts.sys.readDirectory(appRoot, extensions, undefined, patterns)) test.add(path.resolve(name));
      for (const name of [...strings(property(testOptions, 'setupFiles'), 'setupFiles'), ...strings(property(testOptions, 'globalSetup'), 'globalSetup')]) {
        const absolute = path.resolve(appRoot, name);
        helpers.add(absolute);
        // A dedicated helper directory is derived from registered setup owners;
        // production runtime imports always promote its files back into scope.
        if (['test-utils', '__tests__', 'tests'].includes(path.basename(path.dirname(absolute)))) helperDirectories.add(path.dirname(absolute));
      }
    }
  }
  const candidates = new Set();
  for (const filename of all) {
    const absolute = path.resolve(filename), relative = slash(path.relative(appRoot, absolute));
    const kitEntry = /^src\/(?:hooks(?:\.(?:server|client))?|service-worker)\.[cm]?[jt]s$/.test(relative) || /^src\/routes\/.*\+(?:page|layout|server)(?:\.(?:server|client))?\.(?:svelte|[jt]s)$/.test(relative);
    const testOnly = test.has(absolute) || helpers.has(absolute) || [...helperDirectories].some((directory) => inside(directory, absolute));
    if (kitEntry || (build.has(absolute) && !testOnly)) candidates.add(absolute);
  }
  return { all, candidates, test, helpers, helperDirectories, vitestConfig: parsed ? filename : undefined };
}

export async function evaluateDeclaredLoads({ appRoot = process.cwd(), madge, sourceDirectory = 'src', diagnosticWorkLimit } = {}) {
  const workLimit = selectedWorkLimit(diagnosticWorkLimit);
  appRoot = path.resolve(appRoot);
  const configPath = path.join(appRoot, 'tsconfig.json');
  const readConfig = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readConfig.error) throw new Error(ts.flattenDiagnosticMessageText(readConfig.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, appRoot);
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  // Madge must run in the actual app cwd: its config adapter resolves relative paths there.
  if (path.resolve(process.cwd()) !== appRoot) throw new Error('Run the import gate from its actual app directory.');
  if (!madge) {
    let location = process.env.BATSHIT_MADGE_MODULE;
    if (!location) {
      const cli = process.env.PATH.split(path.delimiter).map((directory) => path.join(directory, 'madge')).find(fs.existsSync);
      if (cli) location = path.dirname(path.dirname(fs.realpathSync(cli)));
    }
    if (!location) throw new Error('BATSHIT_MADGE_MODULE must name the installed Madge8 API (CI resolves its npx installation).');
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve(location)), '../package.json'), 'utf8'));
    if (!manifest.version.startsWith('8.')) throw new Error('The import evaluator requires Madge8.');
    madge = require(location);
  }
  const madgeResult = await madge(path.join(appRoot, sourceDirectory), {
    baseDir: appRoot, fileExtensions: ['ts'], tsConfig: configPath
  });
  const diagnosticGraph = madgeResult.obj();
  const diagnosticWarnings = madgeResult.warnings();
  console.log(`Complete Madge diagnostic: ${Object.keys(diagnosticGraph).length} files, ${diagnosticWarnings.skipped?.length ?? 0} warnings.`);
  const problems = [], edges = [], sources = new Map(), resolutions = new Map(), recordedModuleSites = new Set(), coordinateSpaces = new Map();
  const bufferProofs = [], bufferRedirects = [];
  const resourceBoundBytes = Math.min(4 * 1024 ** 3, Math.floor(getHeapStatistics().heap_size_limit * 0.75));
  const stages = [];
  let analysisComplete = true, operations = 0;
  let phase = 'input qualification', discoveryFinished = false, loaderInventoryFinished = false, syntaxFinished = false;
  const incompletePhases = new Set();
  function stage(name) {
    const heapBytes = process.memoryUsage().heapUsed;
    stages.push({ name, heapBytes, workOperations: operations, localCodeFiles: sources.size, edges: edges.length });
    console.log(`${name}: ${sources.size} local code files, ${edges.length} edges, heap ${Math.round(heapBytes / 1024 ** 2)} MiB (block bound ${Math.round(resourceBoundBytes / 1024 ** 2)} MiB).`);
    return withinResourceBound(name);
  }
  function withinResourceBound(name) {
    if (analysisComplete && process.memoryUsage().heapUsed > resourceBoundBytes) {
      analysisComplete = false;
      problems.push({ reason: `Evaluator resource bound reached during ${name}; declared-loads inventory/graph is incomplete, never a green result` });
    }
    return analysisComplete;
  }
  function work(node, nextPhase = phase) {
    if (!analysisComplete) return false;
    phase = nextPhase; operations++;
    if (operations >= workLimit) {
      analysisComplete = false; incompletePhases.add(phase);
      const source = node?.getSourceFile?.();
      problems.push({ ...(source ? {file:relative(source.fileName),line:source.getLineAndCharacterOfPosition(node.getStart()).line+1} : {}), reason:`Declared-loads total work bound (${workLimit}) reached; inventory/graph is incomplete`, phase });
      return false;
    }
    if (operations % 1024 === 0 && !withinResourceBound(phase)) { incompletePhases.add(phase); return false; }
    return true;
  }
  const relative = (name) => slash(path.relative(appRoot, name));
  const options = { ...parsed.options, noEmit: false, sourceMap: false, declaration: false, declarationMap: false };
  if (options.verbatimModuleSyntax !== true) throw new Error('This evaluator requires the actual verbatimModuleSyntax=true emission contract.');
  // Validate the installed compiler's shape rules once, instead of constructing
  // thousands of transient compiler programs. Every non-type static declaration
  // is preserved under this exact option, including an empty named import.
  for (const [statement, expected] of [
    ['import type { T } from "owner";', false],
    ['export type { T } from "owner";', false],
    ['import { type T } from "owner";', true],
    ['export { type T } from "owner";', true],
    ['import { value } from "owner";', true],
    ['import "owner";', true]
  ]) {
    const emitted = ts.transpileModule(statement, { compilerOptions: options, fileName: 'emission-contract.ts' }).outputText;
    const output = ts.createSourceFile('emission-contract.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const present = output.statements.some((node) => (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier);
    if (present !== expected) throw new Error(`Unsupported TypeScript emission contract: ${statement}`);
  }
  let compileSvelte;

  function resolve(specifier, from, mode = 'import') {
    const key = `${from}\0${specifier}\0${mode}`;
    if (resolutions.has(key)) return resolutions.get(key);
    let disposition;
    const plain = specifier.replace(/\?(?:url|raw|inline|worker)(?:&.*)?$/, '');
    const query = plain !== specifier;
    const resolved = ts.resolveModuleName(plain, from, parsed.options, ts.sys).resolvedModule;
    let target = resolved?.resolvedFileName;
    if (!target && (plain.startsWith('.') || plain.startsWith('$lib/'))) {
      const base = plain.startsWith('$lib/') ? path.join(appRoot, 'src/lib', plain.slice(5)) : path.resolve(path.dirname(from), plain);
      target = [base, `${base}.ts`, `${base}.js`, `${base}.svelte`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    }
    const virtual = virtualOwner(plain, appRoot);
    const configuredAlias = Object.keys(parsed.options.paths ?? {}).some((pattern) => {
      const [prefix, suffix] = pattern.split('*');
      return pattern.includes('*') ? plain.startsWith(prefix) && plain.endsWith(suffix) : plain === pattern;
    });
    const localRequest = plain.startsWith('.') || plain.startsWith('/') || configuredAlias;
    if (builtins.has(plain)) disposition = { kind: 'external', owner: `Node builtin ${plain}` };
    else if (target && inside(path.join(appRoot, 'src'), target)) {
      disposition = { kind: query || !codeExtension.test(target) ? 'asset' : 'local', target: path.resolve(target), owner: relative(target) };
    } else if (virtual) disposition = { kind: virtual.unproved ? 'unresolved' : 'virtual', ...virtual, owner: virtual.unproved ?? virtual.owner };
    else if (target && ((localRequest && !resolved?.isExternalLibraryImport) || inside(path.join(appRoot, 'node_modules', '$app'), target))) {
      disposition = { kind: query || !codeExtension.test(target) ? 'asset' : 'local', target: path.resolve(target), owner: relative(target) };
    } else if (!plain.startsWith('.') && !plain.startsWith('/') && !plain.startsWith('$') && !plain.startsWith('#')) {
      const pkg = packageRoot(plain, from);
      let runtime;
      try { runtime = createRequire(from).resolve(plain); } catch { /* Import-only exports may be resolved by TS below. */ }
      const exports = pkg ? importExportTargets(pkg, plain, mode) : [];
      if (pkg?.manifest.exports) runtime = exports.length && exports.every((entry) => entry.valid) ? exports[0].target : undefined;
      // A .d.ts resolution alone does not prove the runtime subpath exists.
      if (pkg && runtime && !/\.d\.[cm]?ts$/.test(runtime) && fs.existsSync(runtime)) {
        const real = fs.realpathSync(runtime);
        const localTargets = exports.map((entry) => fs.realpathSync(entry.target)).filter((target) => inside(path.join(appRoot, 'src'), target));
        if (localTargets.length && new Set(exports.map((entry) => fs.realpathSync(entry.target))).size > 1) disposition = { kind: 'unresolved', owner: `Conditional package targets can select local code: ${plain}`, runtimeTargets: exports };
        else if (inside(path.join(appRoot, 'src'), real)) disposition = { kind: 'local', target: real, owner: relative(real) };
        else disposition = { kind: query ? 'asset' : 'external', owner: `${pkg.manifest.name}@${pkg.manifest.version}`, target: runtime, runtimeTargets: exports.length ? exports : [{ target: runtime, conditions: ['Node package main resolution'], valid: true }] };
      } else if (pkg && target && /\.d\.[cm]?ts$/.test(target)) disposition = { kind: 'external-types', target, owner: `${pkg.manifest.name}@${pkg.manifest.version} erased declarations only` };
      else disposition = { kind: 'unresolved', owner: `Missing runtime resolution for ${plain}${target ? ` (types: ${relative(target)})` : ''}` };
    } else disposition = { kind: 'unresolved', owner: `Missing local/alias target ${specifier}` };
    resolutions.set(key, disposition);
    return disposition;
  }

  const inputPolicy = applicationInputs(appRoot, sourceDirectory, readConfig.config, problems);
  for (const filename of parsed.fileNames) if (inside(path.join(appRoot, sourceDirectory), filename) && !codeExtension.test(filename)) problems.push({file:relative(filename),reason:'Unsupported configured source extension; discovery cannot be complete'});
  const svelteOptions = declarativeConfig(path.join(appRoot, 'build-scripts/sveltekit-options.mjs'));
  if (svelteOptions) {
    const preprocess = property(svelteOptions.object, 'preprocess'), compilerOptions = property(svelteOptions.object, 'compilerOptions');
    const binding = svelteOptions.source.statements.filter(ts.isImportDeclaration).some((node) => node.moduleSpecifier.text === '@sveltejs/vite-plugin-svelte' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === 'vitePreprocess' && preprocess && ts.isCallExpression(preprocess) && ts.isIdentifier(preprocess.expression) && preprocess.expression.text === element.name.text));
    if (!safeConfigFields(svelteOptions.object, ['preprocess', 'compilerOptions', 'files', 'moduleExtensions', 'vitePlugin']) || !binding || preprocess.arguments.length || compilerOptions || property(svelteOptions.object, 'moduleExtensions') || property(svelteOptions.object, 'vitePlugin')) problems.push({ reason: 'Svelte script/compiler configuration requires explicit emitter qualification' });
    else if ((await import('@sveltejs/vite-plugin-svelte')).vitePreprocess().script) problems.push({ reason: 'Installed default vitePreprocess now transforms script; direct Svelte emission is unqualified' });
    if (property(svelteOptions.object, 'files')) problems.push({ reason: 'Custom Kit filesystem roots require explicit input qualification' });
  }
  const viteOptions = declarativeConfig(path.join(appRoot, 'vite.config.ts'));
  if (viteOptions && (!safeConfigFields(viteOptions.object, ['oxc', 'esbuild']) || property(viteOptions.object, 'oxc') || property(viteOptions.object, 'esbuild'))) problems.push({ reason: 'Vite Oxc emission overrides require explicit qualification' });
  const queue = [...new Set([...Object.keys(diagnosticGraph).map((name) => path.resolve(appRoot, name)), ...inputPolicy.all])];
  // Empty/misconfigured Madge output must never become a zero-cycle success.
  if (!queue.length) throw new Error('Madge discovered no files.');
  for (let index = 0; index < queue.length; index++) {
    if (!analysisComplete) break;
    if (index % 32 === 0 && !withinResourceBound('source discovery')) break;
    const filename = queue[index];
    if (sources.has(filename) || !codeExtension.test(filename)) continue;
    if (!fs.existsSync(filename)) { problems.push({ file: relative(filename), reason: 'Graph source is missing' }); continue; }
    const original = fs.readFileSync(filename, 'utf8');
    let text = original, originalSvelteScripts;
    const runeModule = /\.svelte\.[jt]s$/.test(filename);
    if (filename.endsWith('.svelte')) {
      const compiler = require('svelte/compiler');
      compileSvelte ??= compiler.compile;
      try {
        const parsedSvelte = compiler.parse(original, { modern: true });
        let scripts = original.replace(/[^\r\n]/g, ' ');
        for (const script of [parsedSvelte.instance, parsedSvelte.module].filter(Boolean)) scripts = scripts.slice(0, script.content.start) + original.slice(script.content.start, script.content.end) + scripts.slice(script.content.end);
        originalSvelteScripts = ts.createSourceFile(filename, scripts, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        text = compileSvelte(original, { filename, generate: 'client', dev: false }).js.code;
      }
      catch (error) { problems.push({ file: relative(filename), reason: `Svelte compilation: ${error.message}` }); continue; }
    } else if (runeModule) {
      try {
        originalSvelteScripts = ts.createSourceFile(filename, original, ts.ScriptTarget.Latest, true);
        const { transformWithOxc } = await import('vite');
        const javascript = filename.endsWith('.ts') ? (await transformWithOxc(original, filename)).code : original;
        text = require('svelte/compiler').compileModule(javascript, { filename, generate: 'client', dev: false }).js.code;
      } catch (error) { problems.push({ file: relative(filename), reason: `Svelte rune module Oxc/compiler emission: ${error.message}` }); continue; }
    }
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('.svelte') || runeModule ? ts.ScriptKind.JS : undefined);
    coordinateSpaces.set(filename, runeModule ? 'Vite Oxc → Svelte compileModule client output' : filename.endsWith('.svelte') ? 'Svelte client compiler output' : 'source');
    sources.set(filename, source);
    for (const diagnostic of source.parseDiagnostics) problems.push({ file: relative(filename), line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, reason: `Source syntax cannot be analyzed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}` });
    const declarationFile = source.isDeclarationFile;
    function record(node, specifier, kind, coordinates = source) {
      const point = coordinates.getLineAndCharacterOfPosition(node.getStart(coordinates));
      const resolution = resolve(specifier, filename, (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') || ts.isImportEqualsDeclaration(node) ? 'require' : 'import');
      const loaderCandidate = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const edge = { loaderCandidate, from: relative(filename), specifier, line: point.line + 1, coordinateSpace: coordinates === source ? coordinateSpaces.get(filename) : 'source', kind, resolution: { ...resolution, ...(resolution.target ? { target: relative(resolution.target) } : {}) }, node };
      edges.push(edge);
      if (ts.isCallExpression(node)) recordedModuleSites.add(node);
      if (!loaderCandidate && resolution.kind === 'unresolved') problems.push({ file: edge.from, line: edge.line, reason: resolution.owner, kind });
      if (!loaderCandidate && resolution.kind === 'external-types' && kind !== 'erased') problems.push({ file: edge.from, line: edge.line, reason: `Only declarations resolve for runtime edge ${specifier}`, kind });
      if (resolution.kind === 'local') {
        edge.to = relative(resolution.target);
        queue.push(resolution.target);
      }
      for (const target of resolution.localRuntimeTargets ?? []) { edge.to = relative(target); queue.push(target); }
    }
    function imports(node) {
      if (!work(node, 'source import inventory')) return;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const explicitlyErased = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
        const runtime = !declarationFile && !explicitlyErased;
        record(node, node.moduleSpecifier.text, runtime ? 'static' : 'erased');
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        record(node, node.moduleReference.expression.text, declarationFile || node.isTypeOnly ? 'erased' : 'static');
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        record(node, node.argument.literal.text, 'erased');
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) record(node, node.arguments[0].text, declarationFile ? 'erased' : 'dynamic');
        // Finite const/Node Buffer targets are resolved after local binding;
        // unknown targets remain explicit blockers, even inside delayed owners.
      }
      ts.forEachChild(node, imports);
    }
    imports(source);
    if (originalSvelteScripts) {
      function erasedSvelte(node) {
        if (!work(node, 'Svelte erased import inventory')) return;
        const erasedImport = ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly || (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)));
        const erasedExport = ts.isExportDeclaration(node) && (node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly)));
        if (erasedImport || erasedExport) {
          if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) record(node, node.moduleSpecifier.text, 'erased', originalSvelteScripts);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) record(node, node.argument.literal.text, 'erased', originalSvelteScripts);
        ts.forEachChild(node, erasedSvelte);
      }
      erasedSvelte(originalSvelteScripts);
    }
  }
  discoveryFinished = analysisComplete;
  console.log(`Resolved dependency inventory: ${sources.size} code files, ${edges.length} edges; binding loader identities.`);
  stage('Resolved local source');
  const accountedPairs = new Set(edges.filter((edge) => edge.resolution.target).map((edge) => `${edge.from}\0${edge.resolution.target}`));
  for (const [from, dependencies] of Object.entries(diagnosticGraph)) {
    for (const to of dependencies) if (!accountedPairs.has(`${from}\0${to}`)) problems.push({ file: from, reason: `Madge edge has no emitted/erased/resolution disposition: ${to}` });
  }

  // Retain the reviewed full local binder solely for finite loader identity.
  // It supplies no callback, property, native-storage or causal timing proof.
  const bindingOptions = { ...parsed.options, types: [], noResolve: true, allowNonTsExtensions: true };
  const host = ts.createCompilerHost(bindingOptions);
  const ordinarySource = host.getSourceFile.bind(host);
  host.getSourceFile = (filename, ...args) => sources.get(path.resolve(filename)) ?? ordinarySource(filename, ...args);
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    const resolution = resolve(name, containing);
    if (resolution.kind === 'local' && sources.has(resolution.target)) return { resolvedFileName: resolution.target, extension: resolution.target.endsWith('.svelte') ? ts.Extension.Js : (ts.resolveModuleName(name, containing, parsed.options, ts.sys).resolvedModule?.extension ?? ts.Extension.Ts) };
    return ts.resolveModuleName(name, containing, parsed.options, ts.sys).resolvedModule;
  });
  const program = ts.createProgram([...sources.keys()], bindingOptions, host);
  const checker = program.getTypeChecker();
  stage('Bound local source (external type programs disabled)');
  const unwrap = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  };
  const functionLike = (node) => ts.isFunctionLike(node) && !!node.body;
  function valueSymbol(expression) {
    const location=ts.isPropertyAccessExpression(expression)?expression.name:expression;
    // A shorthand name has separate property and value symbols. Resolve the
    // actual value binding, just as TypeScript's own identifier consumer does.
    return ts.isIdentifier(location)&&location.parent&&ts.isShorthandPropertyAssignment(location.parent)&&location.parent.name===location
      ?checker.getShorthandAssignmentValueSymbol(location.parent):checker.getSymbolAtLocation(location);
  }
  function declarations(expression) {
    expression = unwrap(expression);
    if (!expression) return [];
    let symbol = valueSymbol(expression);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  }
  function cjsModule(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression) || !ts.isIdentifier(expression)) return false;
    seen.add(expression);
    if (!work(expression, 'CommonJS module identity')) return false;
    // A JS property assignment can create an expando symbol declaration. It
    // does not lexically shadow the CommonJS wrapper's module binding.
    const local=declarations(expression).filter((node)=>sources.has(node.getSourceFile().fileName)&&!node.getSourceFile().isDeclarationFile&&
      (ts.isVariableDeclaration(node)||ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isParameter(node)||ts.isBindingElement(node)||ts.isImportClause(node)||ts.isImportSpecifier(node)||ts.isNamespaceImport(node)));
    if (expression.text==='module'&&expression.getSourceFile().fileName.endsWith('.cjs')&&!local.length) return true;
    return local.some((node)=>ts.isVariableDeclaration(node)&&node.initializer&&(node.parent.flags&ts.NodeFlags.Const)&&cjsModule(node.initializer,seen));
  }
  function cjsDangerousMember(expression) {
    const members=[]; let base=unwrap(expression);
    while (ts.isPropertyAccessExpression(base)||ts.isElementAccessExpression(base)) {
      members.push(ts.isPropertyAccessExpression(base)?base.name.text:ts.isStringLiteralLike(base.argumentExpression)?base.argumentExpression.text:'<computed>');
      base=unwrap(base.expression);
    }
    return cjsModule(base)&&members.some((name)=>['require','constructor','_compile','_load','register','registerHooks','<computed>'].includes(name));
  }
  function globalReflectGetter(expression, seen=new Set()) {
    expression=unwrap(expression);
    if (!expression||seen.has(expression)) return false;
    seen.add(expression);
    if (!work(expression,'reflective loader identity')) return false;
    if (ts.isPropertyAccessExpression(expression)&&expression.name.text==='get'&&ts.isIdentifier(expression.expression)&&expression.expression.text==='Reflect'&&!declarations(expression.expression).some((node)=>sources.has(node.getSourceFile().fileName)&&!node.getSourceFile().isDeclarationFile)) return true;
    return ts.isIdentifier(expression)&&declarations(expression).some((node)=>ts.isVariableDeclaration(node)&&node.initializer&&(node.parent.flags&ts.NodeFlags.Const)&&globalReflectGetter(node.initializer,seen));
  }
  // Finite property-key refinement, not callback/accessor timing analysis.
  // Recognition is provisional until every possible-runtime identity use has
  // been checked, including writes/escapes appearing after the operation.
  const nativeIdentities=new WeakMap(), symbolKeys=new WeakMap(), symbolRegistryProofs=new Map(), nativeIdentityDamage=[];
  function recordSymbolProof(node, owner) {
    symbolRegistryProofs.set(node,new Set(['Symbol','global',...(owner?[owner]:[])]));
  }
  function immutableInitializer(expression) {
    const owners=declarations(expression).filter((node)=>sources.has(node.getSourceFile().fileName)&&!node.getSourceFile().isDeclarationFile);
    return owners.length===1&&ts.isVariableDeclaration(owners[0])&&ts.isIdentifier(owners[0].name)&&(owners[0].parent.flags&ts.NodeFlags.Const)?owners[0].initializer:undefined;
  }
  function nativeIdentity(expression, seen=new Set()) {
    expression=unwrap(expression);
    if (!expression||seen.has(expression)||!(ts.isIdentifier(expression)||ts.isPropertyAccessExpression(expression)||ts.isElementAccessExpression(expression)||ts.isCallExpression(expression))) return undefined;
    if (!work(expression,'finite Symbol/Reflect identity')) return undefined;
    if (nativeIdentities.has(expression)) return nativeIdentities.get(expression);
    seen.add(expression);
    let identity;
    if (ts.isCallExpression(expression)) {
      // defineProperty returns its target, so its result must never become
      // ordinary registry data that could conceal a global namespace escape.
      if (nativeIdentity(expression.expression,new Set(seen))==='Object.defineProperty'&&symbolRegistryOperation(expression,new Set(seen))) identity='global';
    } else if (ts.isIdentifier(expression)) {
      const local=declarations(expression).some((node)=>sources.has(node.getSourceFile().fileName)&&!node.getSourceFile().isDeclarationFile);
      if (!local&&['Symbol','Reflect','Object','globalThis','global'].includes(expression.text)) identity=['globalThis','global'].includes(expression.text)?'global':expression.text;
      else {
        const initializer=immutableInitializer(expression);
        if (initializer) identity=nativeIdentity(initializer,seen);
      }
    } else {
      const base=nativeIdentity(expression.expression,seen);
      const members=ts.isPropertyAccessExpression(expression)?[expression.name.text]:finiteStrings(expression.argumentExpression,new Set(),false);
      const member=members?.length===1?members[0]:undefined;
      if (base==='global'&&['Symbol','Reflect','Object','globalThis','global'].includes(member)) identity=['globalThis','global'].includes(member)?'global':member;
      else if (base==='Symbol'&&member==='for') identity='Symbol.for';
      else if (base==='Reflect'&&['get','set'].includes(member)) identity=`Reflect.${member}`;
      else if (base==='Object'&&['getOwnPropertyDescriptor','defineProperty'].includes(member)) identity=`Object.${member}`;
    }
    nativeIdentities.set(expression,identity);
    return identity;
  }
  function symbolKey(expression, seen=new Set()) {
    expression=unwrap(expression);
    if (!expression||seen.has(expression)) return false;
    if (!work(expression,'finite Symbol property key')) return false;
    if (symbolKeys.has(expression)) return symbolKeys.get(expression);
    seen.add(expression);
    let known=ts.isCallExpression(expression)&&!expression.questionDotToken&&!expression.typeArguments?.length&&expression.arguments.length===1&&ts.isStringLiteralLike(unwrap(expression.arguments[0]))&&nativeIdentity(expression.expression)==='Symbol.for';
    if (!known&&ts.isIdentifier(expression)) {
      const initializer=immutableInitializer(expression);
      if (initializer) known=symbolKey(initializer,seen);
    }
    symbolKeys.set(expression,known);
    return known;
  }
  function registryDescriptor(expression) {
    const descriptor=literalValue(expression);
    return !!descriptor&&ts.isObjectLiteralExpression(descriptor)&&descriptor.properties.every((member)=>
      work(member,'finite native descriptor shape')&&(ts.isPropertyAssignment(member)||ts.isShorthandPropertyAssignment(member))&&!ts.isComputedPropertyName(member.name)&&
      ['value','get','set','writable','enumerable','configurable'].includes(member.name.text));
  }
  function symbolRegistryOperation(node, seen=new Set()) {
    if (!ts.isCallExpression(node)||node.questionDotToken||node.typeArguments?.length||node.arguments.some(ts.isSpreadElement)) return false;
    const operation=nativeIdentity(node.expression,new Set(seen));
    return ((['Reflect.get','Object.getOwnPropertyDescriptor'].includes(operation)&&node.arguments.length===2)||
      (operation==='Reflect.set'&&node.arguments.length===3)||
      (operation==='Object.defineProperty'&&node.arguments.length===3&&registryDescriptor(node.arguments[2])))&&
      nativeIdentity(node.arguments[0],new Set(seen))==='global'&&symbolKey(node.arguments[1]);
  }
  function consumingParent(node) {
    let value=node, parent=value.parent;
    while (parent&&(ts.isParenthesizedExpression(parent)||ts.isAsExpression(parent)||ts.isNonNullExpression(parent)||ts.isSatisfiesExpression(parent)||ts.isTypeAssertionExpression(parent))&&parent.expression===value) {value=parent;parent=value.parent;}
    return {value,parent};
  }
  function identityUseAllowed(node, identity) {
    let {value,parent}=consumingParent(node);
    if (!parent||ts.isTypeOfExpression(parent)) return true;
    if (identity==='global'&&ts.isCallExpression(unwrap(value))&&symbolRegistryOperation(unwrap(value))&&(ts.isExpressionStatement(parent)||ts.isVoidExpression(parent))) return true;
    if (ts.isVariableDeclaration(parent)&&parent.initializer===value&&ts.isIdentifier(parent.name)&&(parent.parent.flags&ts.NodeFlags.Const)&&!parent.parent.parent.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.ExportKeyword)) return true;
    if ((ts.isPropertyAccessExpression(parent)||ts.isElementAccessExpression(parent))&&parent.expression===value) {
      // Namespaces may be read normally. Native method objects may only be
      // called/aliased directly; .call/.apply/prototype paths do not qualify.
      if (identity.includes('.')) return false;
      if (identity==='global'&&ts.isElementAccessExpression(parent)&&symbolKey(parent.argumentExpression)) {
        recordSymbolProof(parent);return true;
      }
      const members=ts.isPropertyAccessExpression(parent)?[parent.name.text]:finiteStrings(parent.argumentExpression,new Set(),false);
      // These inherited native methods mutate the receiver despite ordinary
      // call syntax. Finite const/concat/conditional names retain that meaning;
      // unknown computed native members cannot default to harmless reads.
      if (!members||members.some((name)=>['__defineGetter__','__defineSetter__'].includes(name))) return false;
      if (identity==='global'&&members.length>1&&members.some((name)=>['Symbol','Reflect','Object','globalThis','global'].includes(name))) return false;
      let outer=consumingParent(parent);
      while ((ts.isPropertyAccessExpression(outer.parent)||ts.isElementAccessExpression(outer.parent))&&outer.parent.expression===outer.value) outer=consumingParent(outer.parent);
      const mutation=(ts.isBinaryExpression(outer.parent)&&outer.parent.left===outer.value&&outer.parent.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&outer.parent.operatorToken.kind<=ts.SyntaxKind.LastAssignment)||ts.isDeleteExpression(outer.parent)||((ts.isPrefixUnaryExpression(outer.parent)||ts.isPostfixUnaryExpression(outer.parent))&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(outer.parent.operator));
      return !mutation||(identity==='global'&&members.every((name)=>!['Symbol','Reflect','Object','Buffer','globalThis','global'].includes(name)));
    }
    if (ts.isCallExpression(parent)&&parent.expression===value) return identity!=='global';
    return identity==='global'&&ts.isCallExpression(parent)&&parent.arguments[0]===value&&symbolRegistryOperation(parent);
  }
  function scanNativeIdentity(node) {
    if (!work(node,'finite Symbol/Reflect integrity scan')||ts.isTypeNode(node)) return;
    if (valueReference(node)) {
      const identity=nativeIdentity(node);
      if (identity&&!identityUseAllowed(node,identity)) {
        const source=node.getSourceFile(), point=source.getLineAndCharacterOfPosition(node.getStart(source));
        const {value,parent}=consumingParent(node), context=parent??node, start=context.getStart(source);
        const reason=ts.isCallExpression(parent)&&parent.arguments.includes(value)?'native identity passed to an unqualified call argument':
          (ts.isPropertyAccessExpression(parent)||ts.isElementAccessExpression(parent))?'unqualified native member access or mutation':
          ts.isVariableDeclaration(parent)?'mutable or exported native identity alias':'native identity escapes its supported uses';
        nativeIdentityDamage.push({node,identity:identity.split('.')[0],witness:{identity,nativeUseReason:reason,file:relative(source.fileName),line:point.line+1,column:point.character+1,coordinateSpace:coordinateSpaces.get(source.fileName),context:source.text.slice(start,Math.min(context.end,start+240))}});
      }
    }
    ts.forEachChild(node,scanNativeIdentity);
  }
  for (const source of sources.values()) if (!source.isDeclarationFile) scanNativeIdentity(source);
  function externalImport(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return undefined;
    if (!work(expression, 'finite loader identity/target')) return undefined;
    seen.add(expression);
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      // Node require.resolve computes a path; its result is not the require
      // function or module namespace. The member itself still has capability.
      if (ts.isCallExpression(expression) && qualifiedResolver(expression.expression)) return undefined;
      if (symbolRegistryOperation(expression)) {recordSymbolProof(expression,nativeIdentity(expression.expression).split('.')[0]);return undefined;}
      if (ts.isCallExpression(expression)&&globalReflectGetter(expression.expression)&&expression.arguments.length>=2&&globalObject(expression.arguments[0])) {
        const key=expression.arguments[1];
        if (!ts.isStringLiteralLike(key)) return {specifier:'javascript:unproved-global-capability',name:'<computed global capability>',members:[],calls:0};
        if (['eval','Function','Buffer','process'].includes(key.text)) return {specifier:['eval','Function'].includes(key.text)?'javascript:codegen':key.text==='Buffer'?'node:buffer':'node:process',name:key.text,members:[],calls:0};
      }
      if (ts.isCallExpression(expression) && knownLoader(expression.expression, new Set(seen))) {
        const targets = finiteStrings(expression.arguments[0]);
        if (targets?.length === 1 && resolve(targets[0], expression.getSourceFile().fileName, 'require').kind === 'external') return { specifier: targets[0], name: '*', members: [], calls: 0 };
        return undefined;
      }
      const result = externalImport(expression.expression, seen);
      return result ? { ...result, calls: (result.calls ?? 0) + 1 } : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const result = externalImport(expression.expression, seen);
      const members=ts.isPropertyAccessExpression(expression)?[expression.name.text]:finiteStrings(expression.argumentExpression,new Set(),false);
      const member=members?.length===1?members[0]:undefined;
      if (!result&&globalObject(expression.expression)&&ts.isElementAccessExpression(expression)&&!symbolKey(expression.argumentExpression)&&(!members||members.some((name)=>['eval','Function','Buffer','process'].includes(name))&&members.length!==1)) return {specifier:'javascript:unproved-global-capability',name:'<computed global capability>',members:[],calls:0};
      if (!result && member && globalObject(expression.expression) && ['eval','Function','Buffer','process'].includes(member)) return {specifier:['eval','Function'].includes(member)?'javascript:codegen':member==='process'?'node:process':'node:buffer',name:member,members:[],calls:0};
      if (result) return { ...result, members: [...result.members, member ?? '<computed>'] };
    }
    const symbol = valueSymbol(expression);
    const local = symbol?.declarations?.some((declaration) => sources.has(declaration.getSourceFile().fileName) && !declaration.getSourceFile().isDeclarationFile);
    if (ts.isIdentifier(expression) && !local && ['process', 'Buffer', 'eval', 'Function'].includes(expression.text)) return { specifier: ['eval', 'Function'].includes(expression.text) ? 'javascript:codegen' : expression.text === 'process' ? 'node:process' : 'node:buffer', name: expression.text, members: [], calls: 0 };
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isImportEqualsDeclaration(declaration)&&ts.isExternalModuleReference(declaration.moduleReference)&&ts.isStringLiteralLike(declaration.moduleReference.expression)) {
        const name=declaration.moduleReference.expression.text;
        if (['external','virtual'].includes(resolve(name,expression.getSourceFile().fileName,'require').kind)) return {specifier:name,name:'*',members:[],calls:0};
      }
      let owner = declaration;
      while (owner && !ts.isImportDeclaration(owner)) owner = owner.parent;
      if (owner && ts.isStringLiteralLike(owner.moduleSpecifier)) {
        const resolution = resolve(owner.moduleSpecifier.text, expression.getSourceFile().fileName);
        if (['external', 'virtual'].includes(resolution.kind)) return { specifier: owner.moduleSpecifier.text, name: ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts.isNamespaceImport(declaration) ? '*' : 'default', members: [] };
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const)) {
        const result = externalImport(declaration.initializer, seen);
        if (result) return result;
      }
    }
    if (symbol?.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(symbol);
      for (const declaration of target?.declarations ?? []) if (ts.isVariableDeclaration(declaration) && declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const)) {
        const result = externalImport(declaration.initializer, seen);
        if (result) return result;
      }
    }
    return undefined;
  }
  function knownLoader(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return false;
    if (!work(expression, 'finite loader identity/target')) return false;
    seen.add(expression);
    if (ts.isCallExpression(expression)) {
      const owner = externalImport(expression.expression, new Set(seen));
      const name = owner?.name === '*' ? owner.members.at(-1) : owner?.name;
      return ['node:module', 'module'].includes(owner?.specifier) && name === 'createRequire' && !owner.calls && expression.arguments.length === 1 && expression.arguments[0].getText() === 'import.meta.url';
    }
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && (ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined) === 'require' && cjsModule(expression.expression)) return true;
    if (!ts.isIdentifier(expression)) return false;
    const symbol = valueSymbol(expression);
    const declarations = symbol?.declarations ?? [];
    if (expression.text === 'require' && expression.getSourceFile().fileName.endsWith('.cjs') && !declarations.some((declaration) => sources.has(declaration.getSourceFile().fileName) && !declaration.getSourceFile().isDeclarationFile)) return true;
    return declarations.some((declaration) => ts.isVariableDeclaration(declaration) && declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const) && knownLoader(declaration.initializer, seen));
  }
  function qualifiedResolver(expression) {
    expression=unwrap(expression);
    if (!(ts.isPropertyAccessExpression(expression)||ts.isElementAccessExpression(expression))) return false;
    const member=ts.isPropertyAccessExpression(expression)?expression.name.text:ts.isStringLiteralLike(expression.argumentExpression)?expression.argumentExpression.text:undefined;
    return member==='resolve' && knownLoader(expression.expression);
  }
  function nodeBuffer(expression) {
    const owner = externalImport(expression);
    return ['node:buffer', 'buffer'].includes(owner?.specifier) && !owner.calls && ((owner.name === 'Buffer' && owner.members.length === 0) || (owner.name === '*' && owner.members.length === 1 && owner.members[0] === 'Buffer'));
  }
  function globalObject(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression) || !(ts.isIdentifier(expression)||ts.isPropertyAccessExpression(expression)||ts.isElementAccessExpression(expression)||ts.isCallExpression(expression))) return false;
    if (!work(expression, 'finite loader identity/target')) return false;
    seen.add(expression);
    if (!ts.isIdentifier(expression)) return nativeIdentity(expression)==='global';
    const local = declarations(expression).filter((node) => sources.has(node.getSourceFile().fileName) && !node.getSourceFile().isDeclarationFile);
    if (['globalThis', 'global'].includes(expression.text) && !local.length) return true;
    return local.some((node) => ts.isVariableDeclaration(node) && node.initializer && (node.parent.flags & ts.NodeFlags.Const) && globalObject(node.initializer, seen));
  }
  function finiteStrings(expression, seen = new Set(), decodeBuffer = true) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return undefined;
    if (!work(expression, 'finite loader identity/target')) return undefined;
    seen.add(expression);
    if (ts.isStringLiteralLike(expression)) return expression.text.length <= 4096 ? [expression.text] : undefined;
    if (ts.isIdentifier(expression)) {
      let symbol = valueSymbol(expression);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.declarations?.find((node) => ts.isVariableDeclaration(node) && node.initializer && (node.parent.flags & ts.NodeFlags.Const));
      if (declaration) return finiteStrings(declaration.initializer, seen, decodeBuffer);
    }
    if (ts.isConditionalExpression(expression)) {
      const left = finiteStrings(expression.whenTrue, new Set(seen), decodeBuffer), right = finiteStrings(expression.whenFalse, new Set(seen), decodeBuffer);
      if (left && right && left.length + right.length <= 8) return [...new Set([...left, ...right])];
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = finiteStrings(expression.left, new Set(seen), decodeBuffer), right = finiteStrings(expression.right, new Set(seen), decodeBuffer);
      if (left && right && left.length * right.length <= 8) { const result = left.flatMap((a) => right.map((b) => a + b)); return result.every((name) => name.length <= 4096) ? result : undefined; }
    }
    if (decodeBuffer && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'toString' && expression.arguments.length === 1 && ts.isStringLiteralLike(expression.arguments[0]) && ['utf8', 'utf-8'].includes(expression.arguments[0].text)) {
      const from = expression.expression.expression;
      if (ts.isCallExpression(from) && ts.isPropertyAccessExpression(from.expression) && from.expression.name.text === 'from' && nodeBuffer(from.expression.expression) && from.arguments.length === 2 && ts.isStringLiteralLike(from.arguments[1]) && from.arguments[1].text === 'base64') {
        const values = finiteStrings(from.arguments[0], seen);
        if (values?.length === 1 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(values[0])) {
          try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(values[0], 'base64'));
            if (decoded.length <= 4096) { bufferProofs.push(expression); return [decoded]; }
          } catch { /* Invalid bytes cannot justify a module target. */ }
        }
      }
    }
    return undefined;
  }
  function literalValue(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return undefined;
    if (!work(expression, 'literal loader options')) return undefined;
    seen.add(expression);
    if (ts.isLiteralExpression(expression) || ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) return expression;
    if (ts.isIdentifier(expression)) {
      const symbol = valueSymbol(expression);
      const declaration = symbol?.declarations?.find((node) => ts.isVariableDeclaration(node) && node.initializer && (node.parent.flags & ts.NodeFlags.Const));
      if (declaration) return literalValue(declaration.initializer, seen);
    }
    return undefined;
  }
  function inert(expression, operation) {
    if (!work(expression, 'loader option qualification')) return false;
    const value = literalValue(expression);
    if (!value) return false;
    if (ts.isLiteralExpression(value)) return true;
    if (ts.isArrayLiteralExpression(value)) {
      if (value.elements.some(ts.isSpreadElement)) return false;
      return operation !== 'coercion' || value.elements.every((element) => inert(element, 'coercion'));
    }
    if (!ts.isObjectLiteralExpression(value)) return false;
    return value.properties.every((member) => {
      if (ts.isSpreadAssignment(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || (member.name && ts.isComputedPropertyName(member.name))) return false;
      const name = member.name?.text;
      if (name === '__proto__') return false;
      if (operation === 'thenable' && name === 'then') return false;
      return operation !== 'coercion' || !['toString', 'valueOf'].includes(name);
    });
  }
  function descriptorNamespaceEscape(expression, seen=new Set()) {
    expression=unwrap(expression);
    if (!expression||seen.has(expression)) return false;
    if (!work(expression,'finite descriptor namespace payload')) return false;
    seen.add(expression);
    if (nodeBuffer(expression)||globalObject(expression)) return true;
    const value=literalValue(expression);
    if (value&&ts.isObjectLiteralExpression(value)) return value.properties.some((member)=>work(member,'finite descriptor payload member')&&(
      ts.isPropertyAssignment(member)?descriptorNamespaceEscape(member.initializer,seen):
      ts.isShorthandPropertyAssignment(member)?descriptorNamespaceEscape(member.name,seen):
      ts.isSpreadAssignment(member)?descriptorNamespaceEscape(member.expression,seen):false));
    if (value&&ts.isArrayLiteralExpression(value)) return value.elements.some((element)=>descriptorNamespaceEscape(ts.isSpreadElement(element)?element.expression:element,seen));
    if (ts.isConditionalExpression(expression)) return descriptorNamespaceEscape(expression.whenTrue,seen)||descriptorNamespaceEscape(expression.whenFalse,seen);
    return false;
  }

  function lexicalOwner(node, coordinateSpace) {
    let owner = node;
    while (owner.parent && !functionLike(owner) && !ts.isClassLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
    const source = owner.getSourceFile();
    return { file:relative(source.fileName), line:source.getLineAndCharacterOfPosition(owner.getStart(source)).line+1,
      coordinateSpace:coordinateSpace ?? coordinateSpaces.get(source.fileName),
      kind:ts.SyntaxKind[owner.kind], name:ts.isSourceFile(owner)?'<module>':owner.name?.getText() ?? (ts.isVariableDeclaration(owner.parent)?owner.parent.name.getText():'<anonymous>') };
  }
  const loaderEdges = new Map();
  for (const edge of edges) if (edge.node && ts.isCallExpression(edge.node)) {
    if (!loaderEdges.has(edge.node)) loaderEdges.set(edge.node, []);
    loaderEdges.get(edge.node).push(edge);
  }
  function loaderProblem(node, reason) {
    const source = node.getSourceFile();
    problems.push({file:relative(source.fileName),line:source.getLineAndCharacterOfPosition(node.getStart()).line+1,lexicalOwner:lexicalOwner(node),reason});
  }
  function ordinaryLocalRequire(expression) {
    return declarations(expression).some((node) => sources.has(node.getSourceFile().fileName) && !node.getSourceFile().isDeclarationFile &&
      ((ts.isFunctionDeclaration(node) && !!node.body) || (ts.isVariableDeclaration(node) && node.initializer && functionLike(unwrap(node.initializer)))));
  }
  function recordLoader(node, form) {
    if (recordedModuleSites.has(node)) {
      for (const edge of loaderEdges.get(node) ?? []) {
        edge.loadForm = form;
        if (edge.loaderCandidate) {
          if (edge.resolution.kind === 'unresolved') loaderProblem(node, edge.resolution.owner);
          if (edge.resolution.kind === 'external-types') loaderProblem(node, 'Only declarations resolve for a runtime CommonJS load');
        }
      }
      return;
    }
    recordedModuleSites.add(node);
    const source=node.getSourceFile(), from=relative(source.fileName), line=source.getLineAndCharacterOfPosition(node.getStart()).line+1;
    const targets=finiteStrings(node.arguments[0]);
    if (!targets?.length) {
      const reason='Unresolved module-loader target could hide local runtime code';
      loaderProblem(node,reason);
      const edge={from,line,kind:'unresolved-module',loadForm:form,expression:node.arguments[0]?.getText().slice(0,300),coordinateSpace:coordinateSpaces.get(source.fileName),resolution:{kind:'unresolved',owner:reason},node};
      edges.push(edge);loaderEdges.set(node,[edge]);return;
    }
    const found=[];
    for (const specifier of targets) {
      if (!work(node,'bound loader inventory')) break;
      const resolution=resolve(specifier,source.fileName,form==='commonjs'?'require':'import');
      const edge={from,line,specifier,kind:'dynamic',loadForm:form,coordinateSpace:coordinateSpaces.get(source.fileName),resolution:{...resolution,...(resolution.target?{target:relative(resolution.target)}:{})},node};
      if (resolution.kind==='local') edge.to=relative(resolution.target);
      for (const target of resolution.localRuntimeTargets ?? []) edge.to=relative(target);
      if (resolution.kind==='unresolved' || resolution.kind==='external-types') loaderProblem(node,`Unresolved runtime module target: ${specifier}`);
      if (edge.to && !sources.has(path.resolve(appRoot,edge.to))) loaderProblem(node,`Resolved loader target is outside discovered source inputs: ${edge.to}`);
      edges.push(edge);found.push(edge);
    }
    loaderEdges.set(node,found);
  }
  function valueReference(node) {
    if (!(ts.isIdentifier(node)||ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)||ts.isCallExpression(node))) return false;
    const parent=node.parent;
    if (!parent) return false;
    if (ts.isImportClause(parent)||ts.isImportSpecifier(parent)||ts.isNamespaceImport(parent)||ts.isImportEqualsDeclaration(parent)) return false;
    if (parent.name===node && (ts.isVariableDeclaration(parent)||ts.isParameter(parent)||ts.isFunctionLike(parent)||ts.isClassLike(parent)||ts.isPropertyDeclaration(parent)||ts.isPropertyAssignment(parent))) return false;
    if (ts.isPropertyAccessExpression(parent)&&parent.name===node) return false;
    if (ts.isBindingElement(parent)&&parent.name===node) return false;
    return true;
  }
  function capability(node) {
    if (knownLoader(node)) return 'loader';
    if (cjsModule(node)||cjsDangerousMember(node)) return 'CommonJS module loader capability';
    const owner=externalImport(node);
    if (owner?.specifier==='javascript:codegen' || owner?.specifier==='javascript:unproved-global-capability') return 'codegen';
    if (['vm','node:vm','module','node:module'].includes(owner?.specifier)) return 'loader/codegen namespace';
    if (owner?.specifier==='node:process' && (owner.members.length===0 || ['getBuiltinModule','binding','_linkedBinding','dlopen'].some((name)=>owner.members.includes(name)||owner.name===name))) return 'native loader capability';
    return undefined;
  }
  function allowedCapabilityReference(node) {
    let value=node, parent=value.parent;
    while (parent && (ts.isParenthesizedExpression(parent)||ts.isAsExpression(parent)||ts.isNonNullExpression(parent)||ts.isSatisfiesExpression(parent)||ts.isTypeAssertionExpression(parent)) && parent.expression===value) {
      value=parent;parent=value.parent;
    }
    if (ts.isTypeOfExpression(parent)) return true;
    if ((ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.expression===value) return true;
    if ((ts.isPropertyAccessExpression(parent)||ts.isElementAccessExpression(parent))&&parent.expression===value) return true;
    if (ts.isVariableDeclaration(parent)&&parent.initializer===value&&ts.isIdentifier(parent.name)&&(parent.parent.flags&ts.NodeFlags.Const)) {
      const statement=parent.parent.parent;
      return !statement.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.ExportKeyword);
    }
    return false;
  }
  function factoryCall(node) {
    const owner=externalImport(node.expression), name=owner?.name==='*'?owner.members[0]:owner?.name;
    return ['module','node:module'].includes(owner?.specifier)&&name==='createRequire'&&!owner.calls&&owner.members.length===(owner.name==='*'?1:0);
  }
  function integrity(node) {
    if (!work(node,'loader identity and integrity') || ts.isTypeNode(node)) return;
    if (ts.isDecorator(node)) loaderProblem(node,'Unsupported decorator emission/execution syntax in declared-loads-v2');
    if (ts.isCallExpression(node)) {
      if (node.expression.kind===ts.SyntaxKind.ImportKeyword) {
        recordLoader(node,'import');
        // A dynamic namespace can be consumed by await/destructuring, aliases
        // or Promise callbacks without retaining a static import binding. Do
        // not certify loader accounting for these sensitive namespaces.
        if (finiteStrings(node.arguments[0])?.some((name)=>['module','node:module','vm','node:vm','process','node:process'].includes(name))) {
          loaderProblem(node,'Unsupported dynamic loader/code-generation namespace; use a bound static import');
        }
      }
      else if (knownLoader(node.expression)) recordLoader(node,'commonjs');
      else if (ts.isIdentifier(node.expression)&&node.expression.text==='require') {
        if (ordinaryLocalRequire(node.expression)) {
          for (const edge of loaderEdges.get(node) ?? []) { edge.kind='not-module-loader';edge.loadForm='not-loader';delete edge.to;edge.resolution={kind:'not-loader',owner:'Bound ordinary local function, not a CommonJS request'}; }
        } else loaderProblem(node,'Unproved CommonJS require identity');
      }
      if ((node.expression.kind===ts.SyntaxKind.ImportKeyword || knownLoader(node.expression)) && (node.arguments.length!==1 || node.typeArguments?.length)) loaderProblem(node,'Unsupported loader arity/options/type arguments');
      if (factoryCall(node) && !(node.arguments.length===1 && node.arguments[0].getText()==='import.meta.url')) loaderProblem(node,'Unproved createRequire origin; require import.meta.url');
    }
    if (ts.isCallExpression(node)||ts.isNewExpression(node)) {
      const owner=externalImport(node.expression), loader=ts.isCallExpression(node)&&knownLoader(node.expression);
      const isFactory=ts.isCallExpression(node)&&factoryCall(node);
      const resolver=['module','node:module'].includes(owner?.specifier)&&owner.calls>0&&owner.members.at(-1)==='resolve';
      const vmParseOnly=ts.isNewExpression(node)&&['vm','node:vm'].includes(owner?.specifier)&&owner.name==='Script'&&!owner.calls&&ts.isExpressionStatement(node.parent)&&node.arguments?.length<=2&&(!node.arguments[1]||inert(node.arguments[1],'accessor'));
      if (owner?.specifier==='javascript:codegen'||owner?.specifier==='javascript:unproved-global-capability'||(['vm','node:vm'].includes(owner?.specifier)&&!vmParseOnly)||(['module','node:module'].includes(owner?.specifier)&&!loader&&!isFactory&&!resolver)||
          (owner?.specifier==='node:process'&&['getBuiltinModule','binding','_linkedBinding','dlopen'].some((name)=>owner.members.includes(name)||owner.name===name))) loaderProblem(node,`Unproved code-generation/module-loader execution: ${node.expression.getText().slice(0,120)}`);
      if (cjsDangerousMember(node.expression)&&!loader) loaderProblem(node,'Unproved CommonJS module loader execution');
      const symbolRegistry=symbolRegistryOperation(node);
      if (symbolRegistry) {
        recordSymbolProof(node,nativeIdentity(node.expression).split('.')[0]);
        if (nativeIdentity(node.expression)==='Object.defineProperty'&&descriptorNamespaceEscape(node.arguments[2])) bufferRedirects.push(node);
      }
      for (const [index,argument] of (node.arguments ?? []).entries()) {
        if (nodeBuffer(argument)||(globalObject(argument)&&!(symbolRegistry&&index===0))) bufferRedirects.push(node);
        if (capability(argument)) loaderProblem(argument,'Unproved loader/code-generation capability escape through a call argument');
      }
      if (!symbolRegistry&&ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['defineProperty','defineProperties','assign','set'].includes(node.expression.name.text)&&['Object','Reflect'].includes(node.expression.expression.getText())&&node.arguments[0]&&globalObject(node.arguments[0])) bufferRedirects.push(node);
    }
    if (valueReference(node) && capability(node) && !allowedCapabilityReference(node)) loaderProblem(node,'Unproved loader/code-generation capability escape');
    if (ts.isExportDeclaration(node)&&!node.isTypeOnly&&(!node.exportClause||!ts.isNamedExports(node.exportClause)||node.exportClause.elements.some((element)=>!element.isTypeOnly))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)&&['module','node:module','vm','node:vm'].includes(node.moduleSpecifier.text)) loaderProblem(node,'Unproved loader/code-generation namespace value export');
    if (ts.isReturnStatement(node)&&node.expression&&(nodeBuffer(node.expression)||globalObject(node.expression))) bufferRedirects.push(node);
    if (ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken) {
      if (nodeBuffer(node.right)) bufferRedirects.push(node);
      let base=node.left, globalBuffer=false;
      while (ts.isPropertyAccessExpression(base)||ts.isElementAccessExpression(base)) {
        const name=ts.isPropertyAccessExpression(base)?base.name.text:ts.isStringLiteralLike(base.argumentExpression)?base.argumentExpression.text:undefined;
        if (name==='Buffer'&&globalObject(unwrap(base.expression))) globalBuffer=true;
        base=base.expression;
      }
      if (nodeBuffer(base)||globalBuffer) bufferRedirects.push(node);
    }
    if (ts.isVariableDeclaration(node)&&node.initializer&&!(node.parent.flags&ts.NodeFlags.Const)&&nodeBuffer(node.initializer)) bufferRedirects.push(node);
    ts.forEachChild(node,integrity);
  }
  for (const source of sources.values()) if (!source.isDeclarationFile) integrity(source);
  loaderInventoryFinished=analysisComplete;

  function possibleRuntimeFiles() {
    const runtime=new Set([...inputPolicy.candidates].filter((filename)=>sources.has(filename)&&!sources.get(filename).isDeclarationFile));
    const pending=[...runtime], modules=new Map();
    for (const edge of edges) if (edge.to&&edge.kind!=='erased'&&edge.kind!=='not-module-loader') {
      if (!modules.has(edge.from)) modules.set(edge.from,[]);
      modules.get(edge.from).push(path.resolve(appRoot,edge.to));
    }
    for (let index=0;index<pending.length;index++) for (const target of modules.get(relative(pending[index]))??[]) {
      if (!work(undefined,'possible runtime closure')) break;
      if (sources.has(target)&&!runtime.has(target)) {runtime.add(target);pending.push(target);}
    }
    return runtime;
  }
  const runtimeFiles=possibleRuntimeFiles(), declaredSyntax=new Map();
  const damagedNativeIdentities=new Set();
  const nativeDamageWitnessLimit=64, runtimeNativeDamageWitnesses=[];
  let runtimeNativeDamageCount=0, diagnosticNativeDamageCount=0;
  for (const {node,identity,witness} of nativeIdentityDamage) {
    if (!work(node,'finite Symbol/Reflect damage accounting')) break;
    if (runtimeFiles.has(node.getSourceFile().fileName)) {
      runtimeNativeDamageCount++;
      if (runtimeNativeDamageWitnesses.length<nativeDamageWitnessLimit) runtimeNativeDamageWitnesses.push(witness);
      damagedNativeIdentities.add(identity);
      if (identity==='global') bufferRedirects.push(node);
    } else diagnosticNativeDamageCount++;
  }
  if (damagedNativeIdentities.size) for (const [node,dependencies] of symbolRegistryProofs) {
    if (!work(node,'finite Symbol/Reflect proof validation')) break;
    const damaged=[...dependencies].filter((identity)=>damagedNativeIdentities.has(identity));
    if (damaged.length) {
      loaderProblem(node,`Symbol-key registry operation is unproved after native identity mutation/escape: ${damaged.sort().join(', ')}`);
      bufferRedirects.push(node);
    }
  }
  function unsupported(node,reason) { loaderProblem(node,`Unsupported declared-load syntax: ${reason}`); }
  function parameters(fn) {
    for (const parameter of fn.parameters) {
      if (parameter.initializer) syntax(parameter.initializer,'direct literal default');
      if (ts.isBindingPattern(parameter.name)) syntax(parameter.name,'direct literal binding default');
    }
  }
  function classDefinition(node,reason) {
    for (const heritage of node.heritageClauses??[]) if (heritage.token===ts.SyntaxKind.ExtendsKeyword) for (const type of heritage.types) syntax(type.expression,'class heritage expression');
    for (const member of node.members) {
      if (member.name&&ts.isComputedPropertyName(member.name)) syntax(member.name.expression,'class computed name');
      if (ts.isClassStaticBlockDeclaration(member)) syntax(member.body,'class static block');
      else if (ts.isPropertyDeclaration(member)&&member.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.StaticKeyword)&&member.initializer) syntax(member.initializer,'class static field');
    }
  }
  function directFunction(fn) {
    if (fn.asteriskToken) { unsupported(fn,'direct generator invocation is not qualified');return; }
    parameters(fn);syntax(fn.body,'direct literal IIFE body');
  }
  function syntax(node,reason='module expression') {
    if (!node||!work(node,'declared-load syntax')||ts.isTypeNode(node)) return;
    if (node.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.DeclareKeyword)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)) return;
    if (functionLike(node)) {
      if (node.name&&ts.isComputedPropertyName(node.name)) syntax(node.name.expression,reason);
      return;
    }
    if (ts.isClassLike(node)) {classDefinition(node,reason);return;}
    if (ts.isModuleDeclaration(node)) {unsupported(node,'runtime TypeScript namespace/module emission');return;}
    if (ts.isCallExpression(node)) {
      const callee=unwrap(node.expression);
      syntax(node.expression,reason);
      for (const argument of node.arguments) syntax(argument,reason);
      if (node.expression.kind===ts.SyntaxKind.ImportKeyword) declaredSyntax.set(node,reason);
      if (ts.isFunctionExpression(callee)||ts.isArrowFunction(callee)) directFunction(callee);
      return;
    }
    if (ts.isNewExpression(node)) {
      const callee=unwrap(node.expression);
      syntax(node.expression,reason);for(const argument of node.arguments??[]) syntax(argument,reason);
      if (ts.isFunctionExpression(callee)) {
        if (callee.asteriskToken||callee.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.AsyncKeyword)) unsupported(callee,'non-constructable direct function');
        else {parameters(callee);syntax(callee.body,'direct literal constructor body');}
      } else if (ts.isClassExpression(callee)) {
        for (const member of callee.members) {
          if (ts.isConstructorDeclaration(member)&&member.body) {parameters(member);syntax(member.body,'direct literal constructor body');}
          else if (ts.isPropertyDeclaration(member)&&!member.modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.StaticKeyword)&&member.initializer) syntax(member.initializer,'direct literal instance field');
        }
      } else if (ts.isArrowFunction(callee)) unsupported(callee,'non-constructable arrow');
      return;
    }
    if (ts.isTaggedTemplateExpression(node)&&(ts.isFunctionExpression(unwrap(node.tag))||ts.isArrowFunction(unwrap(node.tag)))) unsupported(node,'direct literal tagged invocation');
    ts.forEachChild(node,(child)=>syntax(child,reason));
  }
  for (const source of sources.values()) if (!source.isDeclarationFile) syntax(source);
  syntaxFinished=analysisComplete;
  if (bufferRedirects.some((node)=>runtimeFiles.has(node.getSourceFile().fileName))) for(const node of new Set(bufferProofs)) loaderProblem(node,'Node Buffer is redirected/escaped; folded module target is unproved');
  for (const edge of edges) {
    if (!work(edge.node,'inventory classification')) break;
    edge.moduleRole=runtimeFiles.has(path.resolve(appRoot,edge.from))?'possible application runtime':'diagnostic-only (unpromoted)';
    if (edge.node) edge.lexicalOwner=lexicalOwner(edge.node,edge.coordinateSpace);
    if (edge.kind==='dynamic') {
      if (edge.loadForm==='commonjs') {edge.kind='declared-commonjs-load';edge.declaredBy='conservative CommonJS load in any scope';}
      else if (declaredSyntax.has(edge.node)) {edge.kind='declared-dynamic-load';edge.declaredBy=declaredSyntax.get(edge.node);}
      else edge.kind='dynamic-timing-unproved';
    }
    delete edge.node;delete edge.loaderCandidate;
  }
  // A refusal can stop classification mid-inventory. Always release internal
  // AST references so even an incomplete BLOCK report remains serializable.
  for (const edge of edges) {
    if (edge.node&&!edge.lexicalOwner) edge.lexicalOwner=lexicalOwner(edge.node,edge.coordinateSpace);
    if (!analysisComplete) edge.moduleRole='unclassified (inventory incomplete)';
    if (edge.kind==='dynamic') {edge.kind='dynamic-timing-unproved';edge.accounting='INCOMPLETE';}
    delete edge.node;delete edge.loaderCandidate;
  }
  stage('Declared-load inventory and syntax');
  const warningDisposition=(diagnosticWarnings.skipped??[]).map((specifier)=>{
    const instances=edges.filter((edge)=>edge.specifier===specifier);
    if (!instances.length) problems.push({reason:`Madge warning has no accounted source edge: ${specifier}`});
    return {specifier,instances:instances.map(({from,line,kind,resolution,moduleRole})=>({from,line,kind,resolution,moduleRole}))};
  });
  for (const [kind,warnings] of Object.entries(diagnosticWarnings)) if(kind!=='skipped'&&warnings?.length) problems.push({reason:`Unaccounted Madge ${kind} warnings (${warnings.length})`});
  function graphFor(nodes,select) {
    const graph=Object.fromEntries([...nodes].map((filename)=>[relative(filename),[]]));
    for(const edge of edges) {
      if (!work(undefined,'dependency graph construction')) break;
      if (edge.to&&graph[edge.from]&&Object.hasOwn(graph,edge.to)&&select(edge)) graph[edge.from].push(edge.to);
    }
    for(const key of Object.keys(graph)) graph[key]=[...new Set(graph[key])].sort();
    return graph;
  }
  const declaredGraph=graphFor(runtimeFiles,(edge)=>['static','declared-commonjs-load','declared-dynamic-load'].includes(edge.kind));
  const fullGraph=graphFor(new Set(sources.keys()),(edge)=>edge.kind!=='not-module-loader');
  const declaredCycles=cyclicGroups(declaredGraph,()=>work(undefined,'declared graph SCC'));
  const fullCycles=cyclicGroups(fullGraph,()=>work(undefined,'full inventory SCC'));
  for(const problem of problems) problem.disposition=problem.file&&sources.has(path.resolve(appRoot,problem.file))&&!runtimeFiles.has(path.resolve(appRoot,problem.file))?'diagnostic-only: outside possible runtime closure':'blocking';
  const blockingProblems=problems.filter((problem)=>problem.disposition==='blocking');
  const inputsQualified=analysisComplete&&blockingProblems.length===0;
  const discoveryComplete=discoveryFinished&&analysisComplete&&!blockingProblems.some((problem)=>/source|compil|emit|config|discovery/i.test(problem.reason));
  const inventoryComplete=discoveryComplete&&loaderInventoryFinished&&analysisComplete;
  const declaredComplete=inputsQualified&&discoveryComplete&&loaderInventoryFinished&&syntaxFinished;
  const verdict=declaredComplete&&declaredCycles.length===0?'PASS':'BLOCK';
  return {
    contract,causalInitializationProof:'NOT_PERFORMED',verdict,
    completeness:{inputsQualified,discoveryComplete,loaderInventoryComplete:inventoryComplete,declaredGraphComplete:declaredComplete},
    scope:{appRoot,configPath,compilerVersion:ts.version,madge:'8',sourceFiles:sources.size,runtimeFiles:[...runtimeFiles].map(relative),testDiscovery:[...inputPolicy.test].map(relative),registeredTestHelpers:[...inputPolicy.helpers].map(relative),testHelperDirectories:[...inputPolicy.helperDirectories].map(relative),analysisComplete,workOperations:operations,workLimit,fullWorkLimit,workloadMode:diagnosticWorkLimit===undefined?'normal':'lower-diagnostic',resourceBoundBytes,stages,incompletePhases:[...incompletePhases]},
    declaredGraph:{complete:declaredComplete,zeroCycleResult:declaredComplete?(declaredCycles.length?'BLOCK':'PASS'):'NOT_PROVEN',graph:declaredGraph,cycles:declaredCycles},
    fullInventory:{complete:inventoryComplete,meaning:'Every discovered loader/type/value request and its disposition; timing is not complete or certified',edges,graph:fullGraph,cycles:fullCycles,madge:{graph:diagnosticGraph,cycles:madgeResult.circular(),warnings:diagnosticWarnings,warningDisposition}},
    nativeIdentityIntegrity:{complete:analysisComplete&&loaderInventoryFinished,runtimeDamageCount:runtimeNativeDamageCount,diagnosticDamageCount:diagnosticNativeDamageCount,witnessLimit:nativeDamageWitnessLimit,runtimeDamageWitnesses:runtimeNativeDamageWitnesses,omittedRuntimeDamageWitnesses:Math.max(0,runtimeNativeDamageCount-runtimeNativeDamageWitnesses.length)},
    limitations:['Indirect/named/aliased invocation and prior-writer callback cycles, including B-to-B, are not causally proved.','Native/SDK callback storage, event timing, getters, proxies and opaque consumers are not certified safe.'],
    counts:{madgeFiles:Object.keys(diagnosticGraph).length,madgeWarnings:warningDisposition.length,madgeCycles:madgeResult.circular().length,edges:edges.length,byKind:edges.reduce((result,edge)=>{result[edge.kind]=(result[edge.kind]??0)+1;return result;},{}),declaredLoadCycleGroups:declaredComplete?declaredCycles.length:null,problems:problems.length,blockingProblems:blockingProblems.length},
    problems
  };
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {reportPath,diagnosticWorkLimit}=parseImportGateArguments(process.argv.slice(2));
  const result=await evaluateDeclaredLoads({diagnosticWorkLimit});
  fs.writeFileSync(path.resolve(reportPath),`${JSON.stringify(result,null,2)}\n`);
  console.log(JSON.stringify({contract,verdict:result.verdict,causalInitializationProof:result.causalInitializationProof,completeness:result.completeness,...result.counts},null,2));
  for(const group of result.declaredGraph.cycles) console.error(`Declared-load cycle: ${group.join(' -> ')}`);
  const blocking=result.problems.filter((problem)=>problem.disposition==='blocking');
  for(const problem of blocking.slice(0,30)) console.error(`${problem.file??'<graph>'}:${problem.line??0}: ${problem.reason}`);
  if(blocking.length>30) console.error(`${blocking.length-30} additional blocking diagnostics in the required report.`);
  process.exitCode=result.verdict==='PASS'?0:1;
}
