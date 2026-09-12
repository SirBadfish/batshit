import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SA-116 P4 (DL-116-13) — every shipped text that teaches the risk gate says the same thing.
 *
 * The P2/P5 lesson from SA-113, and F-P1-3's repeat of it: guidance and runtime are ONE
 * contract. Before this packet these pages told a model to "retry with `allowRisky: true`"
 * for a flag `useControl` now ignores on every chat lane, so a model that followed them
 * looped against a wall, minting a fresh pending approval record on every retry.
 *
 * There are three copies of most of this — the in-app system skill, the packaged prompt
 * default, and the generated portable mirror — which is exactly why the file list is
 * written out here rather than globbed: a page that quietly stops being synced would
 * otherwise stop being checked at the same moment.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../../..')

/** The seven texts from SA-116 Part 2.3, plus the two mirrors DL-116-13 names. */
const GUIDANCE_PAGES = [
  'batshit-app/src/lib/server/system-skills/cli-tools/SKILL.md',
  'batshit-app/src/lib/server/system-skills/speech-setup/SKILL.md',
  'batshit-app/src/lib/server/system-skills/speech-setup/references/registration-patterns.md',
  'batshit-app/src/lib/server/system-skills/speech-setup/references/local-self-hosted-engines.md',
  'batshit-app/src/lib/server/system-skills/speech-setup/references/mlx-audio-apple-silicon.md',
  'batshit-app/src/lib/server/system-skills/artifacts/references/fabric-and-agent-use.md',
  'batshit-portable-skills/voice-engine-installer/references/registration-patterns.md',
  'batshit-portable-skills/voice-engine-installer/references/local-self-hosted-engines.md',
  'batshit-portable-skills/voice-engine-installer/references/mlx-audio-apple-silicon.md',
  'batshit-portable-skills/artifact-creator/references/fabric-and-agent-use.md'
]

const read = (relative: string) =>
  fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')

describe('SA-116 DL-116-13: no shipped text still teaches the retired flag', () => {
  it.each(GUIDANCE_PAGES)('%s never tells the model to set the flag', (relative) => {
    const text = read(relative)
    expect(text).not.toContain('allowRisky: true')
    expect(text).not.toContain('"allowRisky": true')
    expect(text).not.toContain('allowRisky=true')
    expect(text).not.toMatch(/retry (immediately )?with `?allowRisky/i)
  })

  it.each(GUIDANCE_PAGES)('%s says the click is what unlocks it', (relative) => {
    const text = read(relative)
    expect(text).toContain('Approve')
    // Every page must name the flag as ignored, because a model that has read the OLD
    // wording somewhere else (a cached skill copy, its own training) needs the correction
    // stated, not merely omitted.
    expect(text.toLowerCase()).toMatch(/allowrisky[^\n]*ignored|ignored[^\n]*allowrisky/)
  })

  it('the Portable Skill Token is still the one lane where the flag means something', () => {
    // DL-116-09: the person who minted the token chose its families, and there is no chat
    // to click in. The exception has to stay stated, or a future sweep deletes it.
    const skill = read('batshit-portable-skills/voice-engine-installer/SKILL.md')
    expect(skill).toContain('Portable Skill Tokens are the standing approval')
    expect(skill).toContain('the ONE lane where that flag still means anything')
  })

  it('the MCP proxy no longer advertises the flag as the way past the gate', () => {
    const proxy = read('batshit-server/server/src/mcp/enhanced-tools.js')
    expect(proxy).not.toContain('confirm/restricted controls require allowRisky=true')
    expect(proxy).toContain("PAUSE for the user's Approve click")
    expect(proxy).toContain('allowRisky is accepted and IGNORED')
  })

  it('the managed CLI helper marks the flag ignored where the model reads its schema', () => {
    // The helper still ACCEPTS the flag (P1 kept it deliberately, so a stale caller gets
    // the pause rather than a type error), but a bare boolean in a schema is itself an
    // invitation to try it.
    const helper = read('batshit-app/scripts/mode4-controls-mcp.cjs')
    const bareFlagDeclarations = helper.match(/allowRisky: \{ type: 'boolean' \}/g) ?? []
    expect(bareFlagDeclarations).toHaveLength(0)
    expect(helper).toContain('Ignored (SA-116)')
  })
})
