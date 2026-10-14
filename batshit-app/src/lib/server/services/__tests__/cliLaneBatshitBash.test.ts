import { describe, expect, it } from 'vitest'
import {
  CLI_LANE_GETS_BATSHIT_BASH,
  MODE4_INTERNAL_BASH_TOOL_NAMES,
  MODE4_INTERNAL_HELPER_TOOL_NAMES,
  resolveEnabledMode4InternalHelperTools
} from '../mode4InternalTools'
import { resolveNativeToolSettings } from '../nativeTools'

/**
 * BL-878, step 1 — Josh's rule (2026-09-28, 19:50 EDT): Codex and Claude agents have their own
 * Bash, so Batshit does not give them its own as well.
 *
 * The rule is ONE named constant; the helper list and the dispatch refusal both read it. These
 * pins are the list half. The three callers (both profile managers and `ClaudeBridge`) take the
 * list as it comes, so their own suites prove a Primary, a CLI Subagent and a Worker end up with
 * no helper on each CLI: `codexProfileManager.test.ts`, `claudeBridge.test.ts`,
 * `cliHelperServerParity.test.ts`. The refusal half is `nativeCliLaneBashRefusal.test.ts`.
 */
const BASH_HELPER = MODE4_INTERNAL_BASH_TOOL_NAMES[0]

describe('BL-878: the managed CLI lane gets no Batshit Bash helper', () => {
  it('has one named rule, and it is off', () => {
    expect(CLI_LANE_GETS_BATSHIT_BASH).toBe(false)
    expect(BASH_HELPER).toBe('batshit_server_bash_execute')
  })

  it('never lists the helper, whether Bash is saved on, off, or absent (what the callers pass)', () => {
    for (const bashEnabled of [true, false, undefined]) {
      expect(
        resolveEnabledMode4InternalHelperTools({ bashEnabled }),
        `bashEnabled ${bashEnabled}`
      ).not.toContain(BASH_HELPER)
    }
    // The shared resolver still turns Bash on when nothing is saved (API agents depend on it),
    // so this is exactly the value that used to put the helper on every managed CLI run.
    const resolvedFromNothing = resolveNativeToolSettings(null)
    const resolvedSavedOn = resolveNativeToolSettings({ nativeTools: { bashEnabled: true } })
    expect(resolvedFromNothing.bashEnabled).toBe(true)
    expect(resolvedSavedOn.bashEnabled).toBe(true)
    expect(resolveEnabledMode4InternalHelperTools(resolvedFromNothing)).not.toContain(BASH_HELPER)
    expect(resolveEnabledMode4InternalHelperTools(resolvedSavedOn)).not.toContain(BASH_HELPER)
  })

  it('still lists every other helper the settings allow', () => {
    const listed = resolveEnabledMode4InternalHelperTools(
      {
        fetchZipEnabled: true,
        dynamicMcpEnabled: true,
        cliToolsEnabled: true,
        agentBrowserEnabled: true,
        artifactRuntimeEnabled: true,
        batshitToolsEnabled: true,
        bashEnabled: true
      },
      { hasCliTools: true }
    )
    expect(listed).toEqual(
      expect.arrayContaining(['native_skill', 'batshit_server_fetch_zip', 'batshit_tool_search', 'batshit_tool_use'])
    )
    expect(listed).not.toContain(BASH_HELPER)
  })

  it('keeps the helper in the full helper set, so every deny list still names it', () => {
    // The Codex `disabled_tools` and Claude's `--disallowedTools` are the full set minus what
    // is listed; the helper's definition and its saved cards (old chats) stay as they are.
    expect(MODE4_INTERNAL_HELPER_TOOL_NAMES).toContain(BASH_HELPER)
  })
})
