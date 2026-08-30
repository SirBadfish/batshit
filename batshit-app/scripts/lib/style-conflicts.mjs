/**
 * Style conflict analysis: two owners on one CSS property.
 *
 * Batshit's own classes live in `@layer components` in src/app.css. Tailwind's
 * utilities land in `@layer utilities`, which the cascade resolves LATER --
 * regardless of specificity. So when one element carries both a Batshit class
 * and a Tailwind utility that sets the same property, the utility silently
 * wins and the Batshit rule looks broken for no visible reason.
 *
 * That is not a Tailwind bug, it is an ownership bug: the property has two
 * owners. This module finds those elements so each property can be given back
 * to exactly one owner.
 *
 * Tailwind is NOT banned. A utility that sets a property no Batshit class
 * claims is layout mechanics and passes clean.
 *
 * What each side declares is read from the real stylesheet rather than a
 * hand-written table: Tailwind compiles the app's own theme to say what each
 * utility does, and app.css is compiled (so nesting is flat) to say what each
 * Batshit class claims. Neither list can rot.
 *
 * Scoped rules are resolved two ways. A child (`>`) requirement is checked
 * strictly against the real parent when that parent is in the same file. A
 * descendant requirement (`.sheet .field`) usually has its wrapper in another
 * component, so it is checked against a static-import render graph: the rule
 * applies only if some component carrying that wrapper class can reach this
 * file. Static imports under-approximate the real tree, so anything unknown
 * stays permissive rather than inventing a finding.
 *
 * The CLI lives in scripts/check-style-conflicts.mjs.
 */

import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import postcss from 'postcss'
import { compile } from 'tailwindcss'
import { parse as parseSvelte } from 'svelte/compiler'

export const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const srcRoot = path.join(appRoot, 'src')
const appCssPath = path.join(srcRoot, 'app.css')
const appRequire = createRequire(path.join(appRoot, 'package.json'))

/* ------------------------------------------------------------------ *
 * Shorthand expansion
 *
 * `px-3` sets `padding-inline` and a Batshit rule may set `padding`.
 * Different property names, same pixels. Everything is normalized down to
 * longhands so those still compare equal.
 * ------------------------------------------------------------------ */

const SHORTHANDS = {
  'padding': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'padding-inline': ['padding-left', 'padding-right'],
  'padding-block': ['padding-top', 'padding-bottom'],
  'padding-inline-start': ['padding-left'],
  'padding-inline-end': ['padding-right'],
  'padding-block-start': ['padding-top'],
  'padding-block-end': ['padding-bottom'],
  'margin': ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  'margin-inline': ['margin-left', 'margin-right'],
  'margin-block': ['margin-top', 'margin-bottom'],
  'margin-inline-start': ['margin-left'],
  'margin-inline-end': ['margin-right'],
  'margin-block-start': ['margin-top'],
  'margin-block-end': ['margin-bottom'],
  'inset': ['top', 'right', 'bottom', 'left'],
  'inset-inline': ['left', 'right'],
  'inset-block': ['top', 'bottom'],
  'inset-inline-start': ['left'],
  'inset-inline-end': ['right'],
  'inset-block-start': ['top'],
  'inset-block-end': ['bottom'],
  'inline-size': ['width'],
  'block-size': ['height'],
  'min-inline-size': ['min-width'],
  'min-block-size': ['min-height'],
  'max-inline-size': ['max-width'],
  'max-block-size': ['max-height'],
  'flex': ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  'gap': ['row-gap', 'column-gap'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'overflow': ['overflow-x', 'overflow-y'],
  'overscroll-behavior': ['overscroll-behavior-x', 'overscroll-behavior-y'],
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius'
  ],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width'
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style'
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color'
  ],
  'border-inline-width': ['border-left-width', 'border-right-width'],
  'border-block-width': ['border-top-width', 'border-bottom-width'],
  'border-inline-color': ['border-left-color', 'border-right-color'],
  'border-block-color': ['border-top-color', 'border-bottom-color'],
  'background': [
    'background-color',
    'background-image',
    'background-position',
    'background-size',
    'background-repeat',
    'background-attachment',
    'background-origin',
    'background-clip'
  ],
  'font': ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height'],
  'text-decoration': [
    'text-decoration-line',
    'text-decoration-color',
    'text-decoration-style',
    'text-decoration-thickness'
  ],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'transition': [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay'
  ],
  'animation': [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode'
  ]
}

/**
 * Per-side shorthands still overlap their four-sided parent, so expand
 * recursively (`border` -> `border-width` -> four widths).
 */
const NESTED_SHORTHANDS = {
  'border': ['border-width', 'border-style', 'border-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-inline': ['border-inline-width', 'border-inline-color'],
  'border-block': ['border-block-width', 'border-block-color']
}

function expandProperty(property) {
  const name = property.toLowerCase()
  if (name.startsWith('--')) return [name]

  const nested = NESTED_SHORTHANDS[name]
  if (nested) return nested.flatMap((child) => expandProperty(child))

  const direct = SHORTHANDS[name]
  if (direct) return direct

  return [name]
}

function expandProperties(properties) {
  const out = new Set()
  for (const property of properties) {
    for (const longhand of expandProperty(property)) out.add(longhand)
  }
  return out
}

/**
 * Tailwind writes zero as `calc(var(--spacing) * 0)`. Written differently,
 * same pixels -- so normalize before calling two declarations identical.
 */
function normalizeValue(value) {
  const collapsed = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (/^calc\(\s*var\(--spacing\)\s*\*\s*0\s*\)$/.test(collapsed)) return '0'
  if (/^0(px|rem|em|%)$/.test(collapsed)) return '0'
  return collapsed
}

/* ------------------------------------------------------------------ *
 * Selector reading
 *
 * Only the rightmost compound decides which element a rule styles, and only
 * rules made of plain classes (optionally with a tag) are considered. Anything
 * with a pseudo-class, attribute test, or `:where()` is skipped rather than
 * guessed at, so a finding is never a false alarm.
 * ------------------------------------------------------------------ */

function unescapeSelector(value) {
  return value.replace(/\\(.)/g, '$1')
}

/**
 * Splits a selector into its compounds plus the combinator that joined each to
 * the one on its right, e.g. `.a > .b .c` -> [{.a,'>'}, {.b,' '}, {.c,null}].
 */
function splitSelector(selector) {
  const parts = []
  let depth = 0
  let quote = null
  let buffer = ''
  let combinator = null

  const push = (nextCombinator) => {
    const compound = buffer.trim()
    buffer = ''
    if (compound) parts.push({ compound, combinatorBefore: combinator })
    combinator = nextCombinator
  }

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]

    if (quote) {
      buffer += character
      if (character === quote && selector[index - 1] !== '\\') quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      buffer += character
      continue
    }
    if (character === '\\') {
      buffer += character + (selector[index + 1] ?? '')
      index += 1
      continue
    }
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1

    if (depth === 0 && (character === '>' || character === '+' || character === '~')) {
      push(character)
      continue
    }
    if (depth === 0 && /\s/.test(character)) {
      if (buffer.trim()) push(' ')
      continue
    }

    buffer += character
  }
  push(null)

  return parts
}

function rightmostCompound(selector) {
  const parts = splitSelector(selector)
  return parts.length > 0 ? parts[parts.length - 1].compound : ''
}

/**
 * Returns the class names a compound requires, or null when the compound is
 * anything more complicated than classes plus an optional tag name.
 */
function readSimpleCompound(compound) {
  if (!compound || compound.includes('(') || compound.includes('[') || compound.includes(':')) return null
  if (compound.includes('*') || compound.includes('&') || compound.includes('#')) return null

  const classes = []
  let tag = null
  let buffer = ''
  let mode = 'tag'

  const flush = () => {
    if (!buffer) return
    if (mode === 'class') classes.push(unescapeSelector(buffer))
    else tag = unescapeSelector(buffer).toLowerCase()
    buffer = ''
  }

  for (let index = 0; index < compound.length; index += 1) {
    const character = compound[index]
    if (character === '\\') {
      buffer += character + (compound[index + 1] ?? '')
      index += 1
      continue
    }
    if (character === '.') {
      flush()
      mode = 'class'
      continue
    }
    buffer += character
  }
  flush()

  if (classes.length === 0) return null
  return { classes, tag }
}

/** True when a rule sits inside a conditional at-rule (media, supports, ...). */
function insideConditional(rule) {
  let parent = rule.parent
  while (parent) {
    if (parent.type === 'atrule' && parent.name !== 'layer') return true
    parent = parent.parent
  }
  return false
}

function layerOf(rule) {
  let parent = rule.parent
  while (parent) {
    if (parent.type === 'atrule' && parent.name === 'layer') return parent.params.trim()
    parent = parent.parent
  }
  return null
}

function declarationsOf(rule) {
  const declarations = []
  for (const node of rule.nodes ?? []) {
    if (node.type !== 'decl') continue
    const property = node.prop.toLowerCase()
    declarations.push({
      property,
      value: node.value.trim(),
      important: Boolean(node.important),
      // Expanded once here; the matching loop compares these millions of times.
      longhands: expandProperties([property])
    })
  }
  return declarations
}

/* ------------------------------------------------------------------ *
 * Tailwind
 * ------------------------------------------------------------------ */

async function loadStylesheet(id, base) {
  if (id === 'tailwindcss' || id.startsWith('tailwindcss/')) {
    const suffix = id === 'tailwindcss' ? 'index.css' : id.slice('tailwindcss/'.length)
    const filePath = path.join(path.dirname(appRequire.resolve('tailwindcss/package.json')), suffix)
    return { path: filePath, base: path.dirname(filePath), content: await readFile(filePath, 'utf8') }
  }

  // app.css imports sibling stylesheets through SvelteKit's `$lib` alias.
  const filePath = id.startsWith('$lib/')
    ? path.join(srcRoot, 'lib', id.slice('$lib/'.length))
    : path.resolve(base, id)

  return { path: filePath, base: path.dirname(filePath), content: await readFile(filePath, 'utf8') }
}

/**
 * Tailwind's theme lives in app.css itself, so a stylesheet that keeps only the
 * Tailwind configuration at-rules generates utilities with the exact values
 * this app ships -- without any of Batshit's authored rules mixed in.
 */
function extractTailwindConfig(root) {
  const kept = []
  for (const node of root.nodes ?? []) {
    if (node.type !== 'atrule') continue
    if (node.name === 'import' && /tailwindcss/.test(node.params)) kept.push(node.toString() + ';')
    else if (['theme', 'custom-variant', 'plugin', 'utility', 'variant', 'source'].includes(node.name)) {
      kept.push(node.toString() + (node.nodes ? '' : ';'))
    }
  }
  return kept.join('\n')
}

/* ------------------------------------------------------------------ *
 * Svelte scanning
 * ------------------------------------------------------------------ */

async function collectSvelteFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await collectSvelteFiles(absolute)))
    else if (entry.name.endsWith('.svelte')) found.push(absolute)
  }
  return found
}

/**
 * Classes written into the two arms of a ternary are never on the element at
 * the same time, so each class carries the branch path it was found under.
 * Two classes only count as co-present when every shared branch agrees.
 */
function branchesAgree(a, b) {
  for (const [id, arm] of a) {
    const other = b.get(id)
    if (other !== undefined && other !== arm) return false
  }
  return true
}

function mergeBranches(entries) {
  const merged = new Map()
  for (const entry of entries) {
    if (!branchesAgree(merged, entry.branch)) return null
    for (const [id, arm] of entry.branch) merged.set(id, arm)
  }
  return merged
}

/** Picks one entry per class such that all of them can be on the element together. */
function resolveCoPresent(entryLists) {
  const chosen = []
  const walk = (index) => {
    if (index === entryLists.length) return mergeBranches(chosen)
    for (const entry of entryLists[index]) {
      chosen.push(entry)
      const result = walk(index + 1)
      if (result) return result
      chosen.pop()
    }
    return null
  }
  return walk(0)
}

function collectClassesFromExpression(node, branch, counter, out) {
  if (!node || typeof node !== 'object') return

  const pushLiteral = (text) => {
    for (const token of String(text ?? '').split(/\s+/)) {
      if (token) out.push({ name: token, branch: new Map(branch) })
    }
  }

  if (node.type === 'Literal') {
    if (typeof node.value === 'string') pushLiteral(node.value)
    return
  }

  if (node.type === 'TemplateLiteral') {
    for (const quasi of node.quasis) pushLiteral(quasi.value?.cooked ?? quasi.value?.raw)
    for (const expression of node.expressions) collectClassesFromExpression(expression, branch, counter, out)
    return
  }

  if (node.type === 'ConditionalExpression') {
    const id = counter.next += 1
    collectClassesFromExpression(node.test, branch, counter, out)
    collectClassesFromExpression(node.consequent, new Map(branch).set(id, 0), counter, out)
    collectClassesFromExpression(node.alternate, new Map(branch).set(id, 1), counter, out)
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'parent') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) collectClassesFromExpression(item, branch, counter, out)
    } else if (child && typeof child === 'object') {
      collectClassesFromExpression(child, branch, counter, out)
    }
  }
}

function lineOf(source, offset) {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/**
 * Every element (and component) in a file, with the classes it can carry and
 * the static attributes that let an attribute-scoped rule be matched.
 */
function collectElements(source, filename) {
  const ast = parseSvelte(source, { modern: true, filename })
  const elements = []
  const counter = { next: 0 }

  const visit = (node, ancestors) => {
    if (!node || typeof node !== 'object') return
    let nextAncestors = ancestors

    if (node.type === 'RegularElement' || node.type === 'Component' || node.type === 'SvelteElement') {
      const classEntries = []

      for (const attribute of node.attributes ?? []) {
        if (attribute.type === 'ClassDirective') {
          classEntries.push({ name: attribute.name, branch: new Map() })
          continue
        }
        if (attribute.type !== 'Attribute') continue
        if (attribute.name.toLowerCase() !== 'class') continue

        const value = attribute.value
        if (value === true) continue

        for (const part of Array.isArray(value) ? value : [value]) {
          if (part.type === 'Text') {
            for (const token of part.data.split(/\s+/)) {
              if (token) classEntries.push({ name: token, branch: new Map() })
            }
            continue
          }
          if (part.expression) collectClassesFromExpression(part.expression, new Map(), counter, classEntries)
        }
      }

      const element = {
        tag: (node.name ?? '').toLowerCase(),
        isComponent: node.type === 'Component',
        classEntries,
        classNames: new Set(classEntries.map((entry) => entry.name)),
        ancestors,
        line: lineOf(source, node.start)
      }

      if (classEntries.length > 0) elements.push(element)
      nextAncestors = [...ancestors, element]
    }

    for (const key of ['nodes', 'fragment', 'children', 'body', 'consequent', 'alternate', 'pending', 'then', 'catch']) {
      const child = node[key]
      if (!child) continue
      if (Array.isArray(child)) child.forEach((item) => visit(item, nextAncestors))
      else visit(child, nextAncestors)
    }
  }

  visit(ast.fragment, [])
  return elements
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

export async function collectAppSvelteFiles() {
  return (await collectSvelteFiles(srcRoot)).sort()
}

/**
 * Reads what both sides actually declare. `candidates` is every class name the
 * scanned files can carry -- Tailwind only generates a utility when something
 * asks for it, so the list has to come from the source being checked.
 */
export async function buildContext(candidates) {
  const appCssSource = await readFile(appCssPath, 'utf8')
  const appCssRoot = postcss.parse(appCssSource, { from: appCssPath })

  // What does Tailwind itself think each of these class names does?
  const utilityCompiler = await compile(extractTailwindConfig(appCssRoot), {
    base: srcRoot,
    onDependency() {},
    loadStylesheet
  })
  const utilityRoot = postcss.parse(utilityCompiler.build([...candidates]), { from: undefined })

  /** class name -> { props: Set<longhand>, declarations } */
  const tailwindOwners = new Map()

  utilityRoot.walkRules((rule) => {
    if (insideConditional(rule)) return
    for (const selector of rule.selectors) {
      if (selector !== rightmostCompound(selector)) continue
      const compound = readSimpleCompound(selector)
      if (!compound || compound.tag || compound.classes.length !== 1) continue

      const declarations = declarationsOf(rule)
      if (declarations.length === 0) return

      const className = compound.classes[0]
      const existing = tailwindOwners.get(className) ?? { props: new Set(), declarations: [] }
      for (const longhand of expandProperties(declarations.map((d) => d.property))) existing.props.add(longhand)
      existing.declarations.push(...declarations)
      tailwindOwners.set(className, existing)
    }
  })

  // What do Batshit's own authored classes claim? Compiled so nesting is flat.
  const authoredCompiler = await compile(appCssSource, {
    base: srcRoot,
    onDependency() {},
    loadStylesheet
  })
  const authoredRoot = postcss.parse(authoredCompiler.build([]), { from: undefined })

  const authoredRules = []

  authoredRoot.walkRules((rule) => {
    if (insideConditional(rule)) return
    for (const selector of rule.selectors) {
      const parts = splitSelector(selector)
      if (parts.length === 0) continue

      const subject = parts[parts.length - 1]
      const compound = readSimpleCompound(subject.compound)
      if (!compound) continue
      // A single-class rule that Tailwind already generates is a utility, not ours.
      if (compound.classes.length === 1 && !compound.tag && tailwindOwners.has(compound.classes[0])) continue

      const declarations = declarationsOf(rule)
      if (declarations.length === 0) continue

      authoredRules.push({
        selector,
        requires: compound.classes,
        tag: compound.tag,
        // Everything the selector requires above the subject. The nearest link's
        // combinator decides how strictly the real parent is checked; every link
        // is also tested against the render graph, because a rule scoped to one
        // feature's container must not match elsewhere.
        parent:
          parts.length > 1
            ? { combinator: subject.combinatorBefore, compound: readSimpleCompound(parts[parts.length - 2].compound) }
            : null,
        ancestorChain: parts
          .slice(0, -1)
          .map((part) => readSimpleCompound(part.compound))
          .filter(Boolean),
        layer: layerOf(rule),
        declarations
      })
    }
  })

  // Every required class must be present, so indexing each rule under just one
  // of them is enough to find every rule an element could possibly match.
  const rulesByClass = new Map()
  for (const rule of authoredRules) {
    const key = rule.requires[0]
    if (!rulesByClass.has(key)) rulesByClass.set(key, [])
    rulesByClass.get(key).push(rule)
  }

  return { tailwindOwners, authoredRules, rulesByClass }
}

/**
 * Ancestors outside the current file are invisible, so an unmatched requirement
 * that runs off the top of the file is treated as unknown rather than failed.
 * A requirement that is contradicted by a parent we CAN see is a real mismatch.
 */
function ancestorAllows(rule, element, filename, canBeAncestor) {
  if (!rule.parent) return true
  const requirement = rule.parent.compound
  if (!requirement) return true

  const matches = (candidate) => {
    if (requirement.tag && !candidate.isComponent && requirement.tag !== candidate.tag) return false
    if (requirement.tag && candidate.isComponent) return false
    return requirement.classes.every((className) => candidate.classNames.has(className))
  }

  if (rule.parent.combinator === '>') {
    const parent = element.ancestors[element.ancestors.length - 1]
    return parent ? matches(parent) : true
  }

  return true
}

/**
 * Every scope the selector requires above the element must be reachable. The
 * wrapper is usually in a different component (`.batshit-settings-sheet` wraps
 * every panel), so an in-file miss proves nothing on its own -- ask the render
 * graph instead. Without this, a rule scoped to one feature's container looks
 * like it applies to any panel that happens to use the inner class.
 */
function scopeAllows(rule, element, filename, canBeAncestor) {
  if (!canBeAncestor) return true
  for (const link of rule.ancestorChain ?? []) {
    if (element.ancestors.some((candidate) => link.classes.every((c) => candidate.classNames.has(c)))) continue
    if (!link.classes.every((className) => canBeAncestor(className, filename))) return false
  }
  return true
}

const LAYER_ORDER = ['theme', 'base', 'components', 'utilities']

/** Which declaration actually wins: the authored rule or the utility? */
function winnerOf(authored, utilityDeclaration) {
  if (authored.important && !utilityDeclaration.important) return 'batshit'
  if (utilityDeclaration.important && !authored.important) return 'tailwind'
  if (authored.layer === null) return 'batshit' // unlayered beats every layer
  const authoredRank = LAYER_ORDER.indexOf(authored.layer)
  const utilityRank = LAYER_ORDER.indexOf('utilities')
  if (authoredRank === -1) return 'tailwind'
  return authoredRank > utilityRank ? 'batshit' : 'tailwind'
}

/** Every conflict in one file's markup, given the compiled stylesheet context. */
export function findConflicts(source, filename, context) {
  return conflictsForElements(collectElements(source, filename), filename, context)
}

function conflictsForElements(elements, filename, context) {
  const { tailwindOwners, rulesByClass } = context
  const findings = []

  for (const element of elements) {
    const entriesByName = new Map()
    for (const entry of element.classEntries) {
      if (!entriesByName.has(entry.name)) entriesByName.set(entry.name, [])
      entriesByName.get(entry.name).push(entry)
    }

    const nearby = []
    for (const className of entriesByName.keys()) {
      const rules = rulesByClass.get(className)
      if (rules) nearby.push(...rules)
    }

    const authoredOnElement = nearby.filter((rule) => {
      if (rule.tag && !element.isComponent && rule.tag !== element.tag) return false
      if (rule.tag && element.isComponent) return false
      if (!rule.requires.every((required) => entriesByName.has(required))) return false
      if (!resolveCoPresent(rule.requires.map((required) => entriesByName.get(required)))) return false
      if (!ancestorAllows(rule, element, filename, context.canBeAncestor)) return false
      return scopeAllows(rule, element, filename, context.canBeAncestor)
    })
    if (authoredOnElement.length === 0) continue

    const utilitiesOnElement = [...entriesByName.keys()].filter((className) => tailwindOwners.has(className))
    if (utilitiesOnElement.length === 0) continue

    for (const utilityClass of utilitiesOnElement) {
      const utility = tailwindOwners.get(utilityClass)

      for (const rule of authoredOnElement) {
        if (rule.requires.includes(utilityClass)) continue
        // The utility and the class must be able to land on the element together.
        const together = [...rule.requires, utilityClass].map((name) => entriesByName.get(name))
        if (!resolveCoPresent(together)) continue

        for (const declaration of rule.declarations) {
          const overlap = [...declaration.longhands].filter((property) => utility.props.has(property))
          if (overlap.length === 0) continue

          const utilityDeclaration =
            utility.declarations.find((candidate) =>
              overlap.some((property) => candidate.longhands.has(property))
            ) ?? utility.declarations[0]

          const winner = winnerOf(
            { important: declaration.important, layer: rule.layer },
            utilityDeclaration
          )

          findings.push({
            file: path.relative(appRoot, filename),
            line: element.line,
            element: element.tag,
            batshitClass: rule.requires.join('.'),
            batshitSelector: rule.selector,
            batshitDeclaration: `${declaration.property}: ${declaration.value}`,
            utilityClass,
            utilityDeclaration: `${utilityDeclaration.property}: ${utilityDeclaration.value}`,
            property: overlap.sort()[0],
            winner,
            identical:
              declaration.property === utilityDeclaration.property &&
              normalizeValue(declaration.value) === normalizeValue(utilityDeclaration.value)
          })
        }
      }
    }
  }

  // Collapse to one finding per element + utility + property.
  const deduped = new Map()
  for (const finding of findings) {
    const key = [finding.file, finding.line, finding.utilityClass, finding.property].join('|')
    const existing = deduped.get(key)
    if (!existing || (existing.identical && !finding.identical)) deduped.set(key, finding)
  }

  return [...deduped.values()]
}

/** Scans a set of Svelte files end to end and returns every conflict, sorted. */
const IMPORT_SPECIFIER = /(?:from\s*|import\s*\()\s*['"]([^'"]+\.svelte)['"]/g

/** Which .svelte files this one renders, as far as static imports can tell. */
function importedComponents(source, filename) {
  const found = []
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]
    if (specifier.startsWith('$lib/')) found.push(path.join(srcRoot, 'lib', specifier.slice('$lib/'.length)))
    else if (specifier.startsWith('.')) found.push(path.resolve(path.dirname(filename), specifier))
  }
  return found
}

/**
 * A wrapper class can only scope a rule onto this file if some component that
 * actually carries that class ends up rendering this file. Without this, a rule
 * scoped to one feature's container looks like it applies everywhere the inner
 * class appears -- e.g. a goon-cue-scoped label rule "matching" an Admin panel.
 *
 * Static imports under-approximate the real render tree (slots, dynamic
 * components), so an unknown class resolves to "possible" and stays permissive.
 */
function buildAncestorScope(sources) {
  // Matched against raw source, not parsed attributes: a wrapper class is often
  // assembled in a script constant rather than written in a class attribute.
  // Over-matching here only makes the check more permissive, which is the safe
  // direction for a gate.
  const mentionCache = new Map()
  const filesMentioning = (className) => {
    const cached = mentionCache.get(className)
    if (cached) return cached

    const pattern = new RegExp(`(?<![\\w-])${className.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}(?![\\w-])`)
    const found = new Set()
    for (const [file, source] of sources) {
      if (pattern.test(source)) found.add(file)
    }
    mentionCache.set(className, found)
    return found
  }

  const renders = new Map()
  for (const [file, source] of sources) {
    renders.set(file, importedComponents(source, file).filter((target) => sources.has(target)))
  }

  const reachableCache = new Map()
  const reaches = (from) => {
    const cached = reachableCache.get(from)
    if (cached) return cached

    const seen = new Set([from])
    const stack = [from]
    reachableCache.set(from, seen) // set first so cycles terminate
    while (stack.length > 0) {
      for (const next of renders.get(stack.pop()) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    return seen
  }

  return (className, filename) => {
    const owners = filesMentioning(className)
    if (owners.size === 0) return true // applied from outside the scanned markup
    if (owners.has(filename)) return true
    for (const owner of owners) {
      if (reaches(owner).has(filename)) return true
    }
    return false
  }
}

export async function analyzeFiles(files) {
  const parsed = new Map()
  const sources = new Map()
  const candidates = new Set()

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const elements = collectElements(source, file)
    sources.set(file, source)
    parsed.set(file, elements)
    for (const element of elements) {
      for (const className of element.classNames) candidates.add(className)
    }
  }

  const context = await buildContext(candidates)
  context.canBeAncestor = buildAncestorScope(sources)

  const findings = []
  for (const [file, elements] of parsed) findings.push(...conflictsForElements(elements, file, context))

  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.utilityClass.localeCompare(b.utilityClass)
  )
}

/** The stable identity of a finding, independent of the line it sits on. */
export function findingKey(finding) {
  return [finding.file, finding.batshitClass, finding.utilityClass, finding.property].join('|')
}
