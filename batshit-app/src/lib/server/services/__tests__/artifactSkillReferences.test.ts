import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BL-77: an Artifact Creator build cost 330-700k input tokens on Sonnet 5. Half of that was the
 * skill's own text, re-sent on every step of the tool loop, and some of it was paid twice: a
 * reference longer than the `native_skill` read limit comes back cut with a bare `[truncated]`,
 * so the agent read it again with a bigger `maxChars` (a whole extra step carrying the whole file).
 *
 * The skill is now a lean SKILL.md plus references that each fit one default read and open with a
 * "Load when" line, so an agent loads only what the current step needs, once.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../../..')
const SKILL_ROOT = path.join(REPO_ROOT, 'batshit-app/src/lib/server/system-skills/artifacts')
const REFERENCE_DIR = path.join(SKILL_ROOT, 'references')
const PORTABLE_SKILL = path.join(REPO_ROOT, 'batshit-portable-skills/artifact-creator/SKILL.md')
const MANIFEST = path.join(REPO_ROOT, 'batshit-portable-skills/portable-skills.manifest.json')

const read = (file: string) => fs.readFileSync(file, 'utf8')
const skill = () => read(path.join(SKILL_ROOT, 'SKILL.md'))
const referenceNames = () =>
  fs
    .readdirSync(REFERENCE_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()

/** The characters a `native_skill` read returns when the agent passes no `maxChars`. */
function defaultReadLimit(): number {
  const source = read(path.join(REPO_ROOT, 'batshit-app/src/lib/server/services/skillRuntimeToolService.ts'))
  const match = /const DEFAULT_SKILL_REFERENCE_CHARS = ([\d_]+)/.exec(source)
  if (!match) throw new Error('DEFAULT_SKILL_REFERENCE_CHARS not found in skillRuntimeToolService.ts')
  return Number(match[1].replace(/_/g, ''))
}

describe('Artifact Creator skill fits the read limit (BL-77)', () => {
  it('reads the limit from the skill runtime', () => {
    expect(defaultReadLimit()).toBeGreaterThanOrEqual(8_000)
  })

  it.each(referenceNames())('references/%s fits one default read', (name) => {
    const text = read(path.join(REFERENCE_DIR, name))
    expect(text.length, `${name} is ${text.length} characters`).toBeLessThanOrEqual(defaultReadLimit())
  })

  it('SKILL.md stays within one read too', () => {
    expect(skill().length).toBeLessThanOrEqual(defaultReadLimit())
  })

  it.each(referenceNames())('references/%s says when to load it', (name) => {
    const opening = read(path.join(REFERENCE_DIR, name)).split('\n').slice(0, 5).join('\n')
    expect(opening).toMatch(/^\*\*Load when:\*\* \S/m)
  })

  it('SKILL.md lists every reference, and every reference it names exists', () => {
    const text = skill()
    for (const name of referenceNames()) {
      expect(text, `SKILL.md does not list ${name}`).toMatch(new RegExp('\\| `' + name.replace('.', '\\.') + '` \\|'))
    }
    const named = new Set(Array.from(text.matchAll(/`([a-z0-9-]+\.md)`/g), (match) => match[1]))
    named.delete('SKILL.md')
    for (const name of named) {
      expect(referenceNames(), `SKILL.md names missing reference ${name}`).toContain(name)
    }
  })

  it('the portable manifest ships exactly the references folder', () => {
    const manifest = JSON.parse(read(MANIFEST)) as {
      bundles: Array<{ id: string; sharedReferences: string[] }>
    }
    const bundle = manifest.bundles.find((entry) => entry.id === 'artifact-creator')
    expect(bundle).toBeDefined()
    expect([...bundle!.sharedReferences].sort()).toEqual(referenceNames().map((name) => `references/${name}`))
  })
})

describe('Artifact Creator guidance matches what saves do (BL-77)', () => {
  // create, update, apply_patch, and publish already run the same checks and refuse with a list,
  // so "validate before every save" only added a step (and its whole-page input) to every build.
  const RETIRED = [
    /before every (save|create|update|apply_patch|publish)/i,
    /before (the first|each|any) save/i,
    /validate(_structure)?`?\s+before\s+(the\s+)?(first\s+)?(save|saving|create|publish)/i,
    /validate structure before save/i
  ]

  const shippedTexts = () => [
    ['SKILL.md', skill()] as const,
    ['portable SKILL.md', read(PORTABLE_SKILL)] as const,
    ...referenceNames().map((name) => [`references/${name}`, read(path.join(REFERENCE_DIR, name))] as const)
  ]

  it('no shipped text asks for a separate validation before saving', () => {
    for (const [label, text] of shippedTexts()) {
      for (const pattern of RETIRED) {
        expect(text, `${label} still says ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('SKILL.md keeps validate_structure as the check without saving', () => {
    expect(skill()).toMatch(/`sys\.artifact\.validate_structure` gives the same verdict without saving/)
  })

  it('SKILL.md gives the exact refs and their inputs, so no search is needed to build', () => {
    const text = skill()
    for (const ref of [
      'fabric:sys.artifact.create',
      'fabric:sys.artifact.update',
      'fabric:sys.artifact.publish',
      'fabric:sys.artifact.get',
      'fabric:sys.artifact.apply_patch',
      'fabric:sys.artifact.validate_structure',
      'fabric:sys.model_catalog.search'
    ]) {
      expect(text, ref).toMatch(new RegExp('\\| `' + ref.replace(/\./g, '\\.') + '` \\| \\S'))
    }
  })

  it('SKILL.md asks for get only when the write summary does not show the change', () => {
    expect(skill()).toMatch(/call `sys\.artifact\.get` only when you need the current HTML to edit, or after an update whose summary does not show the change you made/)
  })

  // BL-818: `expectedVersion` comes from a result that loaded the WHOLE page or wrote the agent's
  // OWN whole content: a `get` with content, `create`, a `content` update, or `add_version`. An
  // `apply_patch` result (a patch applies to the stored text, so a user's save elsewhere can sit in
  // it) and a publish, zone, webhook, metadata, field, or rollback result show the STORED version of
  // a page the agent has not read in full; an agent that took it would send its older copy over a
  // user's newer save and have it accepted. Every shipped text that says where the version comes
  // from says so.
  it.each([
    ['SKILL.md', () => skill()],
    ['references/editing.md', () => read(path.join(REFERENCE_DIR, 'editing.md'))],
    ['portable SKILL.md', () => read(PORTABLE_SKILL)],
    ['portable references/editing.md', () => read(path.join(path.dirname(PORTABLE_SKILL), 'references/editing.md'))]
  ])('%s says which results the version may come from, and never apply_patch or a write that read no page (BL-818)', (_name, text) => {
    const body = text()
    expect(body).toContain('`add_version`')
    // A `get` without content also returns the stored version: the text says `get` means with content.
    expect(body).toMatch(/\bget\b[^.;]{0,30}with content/i)
    expect(body).toMatch(/never (?:take it from )?(?:an )?apply_patch, publish, zone, webhook, metadata, field, or rollback/i)
    // apply_patch is in the "never" list, not in the list that counts.
    expect(body).not.toMatch(/`apply_patch`, or `add_version`/)
    expect(body).not.toMatch(/`content` update, `apply_patch`/)
  })

  it('zone-patterns says it is not for Builder Kit forms', () => {
    const opening = read(path.join(REFERENCE_DIR, 'zone-patterns.md')).split('\n').slice(0, 5).join('\n')
    expect(opening).toContain('**Not for Builder Kit forms:**')
  })

  it('static tools are user-run, never agent tools', () => {
    expect(skill()).toMatch(/Static \/ No AI[^\n]*never an agent tool/)
  })
})

describe('runtime texts agree: saves check themselves (BL-77)', () => {
  it('a script-syntax refusal says to save again, not to validate first', async () => {
    const { buildArtifactHtmlPreflightMessage } = await import('$lib/server/artifacts/artifactHtmlPreflight')
    const message = buildArtifactHtmlPreflightMessage({
      ok: false,
      checkedScripts: 1,
      skippedScripts: 0,
      issues: [{ code: 'INLINE_SCRIPT_SYNTAX_ERROR', message: 'Inline script 1 does not parse.' }],
      advisories: []
    } as any)
    expect(message).toContain('Fix the artifact HTML and save it again.')
    expect(message).not.toMatch(/validate_structure/)
  })

  it('the validate_structure control describes itself as the dry run', () => {
    const source = read(path.join(REPO_ROOT, 'batshit-app/src/lib/server/services/fabricRegistry.ts'))
    const block = source.slice(source.indexOf("controlId: 'sys.artifact.validate_structure'"))
    const description = /description: '([^']+)'/.exec(block)?.[1] ?? ''
    expect(description).toMatch(/^Dry-run the save checks/)
    expect(description).not.toMatch(/before save/i)
  })
})
