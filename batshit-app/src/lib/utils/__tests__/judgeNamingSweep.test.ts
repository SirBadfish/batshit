import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SA-120 P10b (DL-120-18) — source pins for the judge-naming sweep.
 *
 * Every sentence that names the judge names the one that judged ("Flagged by Clef Flash"), or says "the judge"
 * when Batshit cannot know which, or, in settings and help copy built before any judgment, points at the real
 * answer: "the judge chosen in Settings → Admin → Judge Juice (Jev at TypeSafe unless you changed it)". These
 * tests read the copy straight from the components, which have no judge to look up, and fail the moment a
 * sentence goes back to hard-coding TypeSafe or Jev for a lane that may run on another judge.
 *
 * Kept on purpose: the TypeSafe Model row, the TypeSafe key rows and the API Keys Test, the Admin card's
 * built-in-judge sentence and missing-key note, and an Execution Viewer row with no judge (written before P10a).
 */

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8').replace(/\s+/g, ' ')

const NEUTRAL_WHERE = 'the judge chosen in Settings → Admin → Judge Juice (Jev at TypeSafe unless you changed it)'

/** Components whose copy cannot know the judge. None may name TypeSafe as the place the text goes. */
const SETTINGS_COPY = [
  'src/lib/components/settings/agent/AgentJevJuiceSettingsCard.svelte',
  'src/lib/components/mcps/GlobalZipControlStrip.svelte',
  'src/lib/components/settings/panels/GroupSettingsPanel.svelte',
  'src/lib/components/settings/panels/VoiceSettingsPanel.svelte'
]

const FORBIDDEN_IN_SETTINGS_COPY = [
  "go to TypeSafe's servers",
  "goes to TypeSafe's servers",
  "TypeSafe's Jev model",
  'a model made by TypeSafe',
  'to TypeSafe. Needs',
  'a TypeSafe key.',
  'Jev still only acts',
  'Jev can be wrong',
  "Jev's confidence"
]

describe('SA-120 P10b: settings and help copy points at the chosen judge', () => {
  it.each(SETTINGS_COPY)('%s never says the text goes to TypeSafe or that Jev judges', (file) => {
    const source = read(file)
    for (const phrase of FORBIDDEN_IN_SETTINGS_COPY) expect(source, `${file} still says: ${phrase}`).not.toContain(phrase)
  })

  it('the Agent card says where each feature sends text with the one neutral sentence, six times (six features)', () => {
    const source = read('src/lib/components/settings/agent/AgentJevJuiceSettingsCard.svelte')
    expect(source.split(NEUTRAL_WHERE).length - 1).toBe(6)
    expect(source).toContain('asks your judge')
    expect(source).toContain('the card there says where each judge runs')
  })

  it('the Global Tool Grid strip, the Groups preset note, and the Voice panel use the same sentence', () => {
    expect(read('src/lib/components/mcps/GlobalZipControlStrip.svelte')).toContain(
      'sent to the judge chosen in Settings → Admin → Judge Juice (Jev at TypeSafe unless you changed it)'
    )
    expect(read('src/lib/components/settings/panels/GroupSettingsPanel.svelte')).toContain(
      "to the judge chosen in Settings → Admin → Judge Juice (Jev at TypeSafe unless you changed it)"
    )
    const voice = read('src/lib/components/settings/panels/VoiceSettingsPanel.svelte')
    expect(voice).toContain('The judge chosen in Settings → Admin → Judge Juice (Jev at TypeSafe unless you changed it) judges each spoken turn')
    expect(voice).toContain('What is sent to the judge when it is on')
    expect(voice).toContain('a TypeSafe key for Jev')
    // The wake-word help keeps its warning about the actual word "Jev" (TypeSafe's model name, often misheard).
    expect(voice).toContain('"system prompt", and "Jev" is often misheard.')
  })

  it('the Admin card keeps its TypeSafe-specific sentences and neutralizes the Screen Incoming Text help', () => {
    const source = read('src/lib/components/settings/admin/AdminJevJuiceCard.svelte')
    expect(source).toContain('The built-in judge is Jev, made by')
    expect(source).toContain('No {TYPESAFE_VENDOR_NAME} key yet')
    expect(source).toContain('This feature allows your judge to screen text')
    expect(source).toContain('the judge can be wrong')
    expect(source).toContain('What is sent to the judge chosen for this feature under Which Judge when it is on')
    expect(source).not.toContain('Jev can be wrong')
    expect(source).not.toContain('shows each one to Jev')
  })

  it('the recall chip row says the judge brought a memory in (the stored row keeps no judge)', () => {
    const chatMessage = read('src/lib/components/chat/ChatMessage.svelte')
    expect(chatMessage).toContain("'brought in by the judge'")
    expect(chatMessage).not.toContain("'brought in by Jev'")
  })

  it('the page toast about an unsaved no-reply decision does not name Jev', () => {
    const page = read('src/routes/+page.svelte')
    expect(page).toContain("could not confirm that it saved the judge\\'s decision")
    expect(page).not.toContain("saved Jev\\'s decision")
  })
})

describe('SA-120 P10b: the flag surfaces take the judge from the screen they draw', () => {
  it('the skill import box names the judge in its badge, its lines, and its "raised no flag" line', () => {
    const panel = read('src/lib/components/settings/panels/SlashCommandSettingsPanel.svelte')
    expect(panel).toContain('untrustedTextBadgeText(importScreenView.judge)')
    expect(panel).toContain('untrustedTextSkillNoFlagText(untrustedTextScreenJudgeName(importScreen))')
    expect(panel).not.toContain('UNTRUSTED_TEXT_BADGE_TEXT')
    expect(panel).not.toContain('UNTRUSTED_TEXT_SKILL_NO_FLAG_TEXT')
  })

  it('the voice quick action toast uses the one shared wording, not a name of its own', () => {
    const input = read('src/lib/components/chat/ChatInput.svelte')
    expect(input).toContain('toast.info(quickActionToastText(mark))')
    expect(input).not.toContain('Quick action by Jev')
  })

  it('no source file builds a sentence from a fixed Jev name constant any more', () => {
    const constants = read('src/lib/utils/jevJuice.ts')
    expect(constants).not.toContain('JEV_MODEL_NAME')
    expect(read('src/lib/utils/jevJuiceQuickActions.ts')).not.toContain('JEV_MODEL_NAME')
  })
})

describe('SA-120 P10b: agent-facing judgment text says "the judge" and states the limits as the most a call may carry', () => {
  const packaged = read('../docs/batshit_System_Prompts/batshit_jev_juice_guidance.md')
  const fabric = read('src/lib/server/services/fabricRegistry.ts')
  const registry = read('src/lib/server/services/systemPromptRegistry.ts')

  it('the packaged guidance names the chosen judge, Jev only as the default, and promises no limit a smaller judge cannot meet', () => {
    expect(packaged).toContain("the judge your user chose for this tool (TypeSafe's Jev unless they picked another)")
    expect(packaged).toContain('## What the judge cannot do')
    expect(packaged).toContain('a smaller judge takes fewer Choice options and less state')
    expect(packaged).toContain('refused as too large for this judge, with the limit named')
    expect(packaged).not.toContain('provider_limit')
    expect(packaged).not.toContain('Jev cannot')
    expect(packaged).not.toContain('Jev sees')
    expect(packaged).not.toContain('Jev returns')
    expect(packaged).not.toContain('leaves this computer and goes to TypeSafe')
  })

  it('the sys.judge.ask control text and the registry description say the judge, not Jev', () => {
    expect(fabric).toContain("the judge your user chose for this tool (TypeSafe\\'s Jev unless they picked another)")
    expect(fabric).toContain('The judge cannot write text, run tools, or approve anything')
    expect(fabric).toContain('fewer for a smaller judge')
    expect(fabric).not.toContain('Jev cannot write text')
    expect(registry).toContain('what the judge cannot do')
    expect(registry).not.toContain('what Jev cannot do')
  })

  it("the guidance prompt's registry version moved with its wording, so an uncustomized copy refreshes", () => {
    // Anchored to this entry: no other `defaultVersion` may sit between its id and the date.
    expect(registry).toMatch(/id: 'jev_juice_guidance',(?:(?!defaultVersion)[\s\S])*defaultVersion: '2026-10-12'/)
  })
})
