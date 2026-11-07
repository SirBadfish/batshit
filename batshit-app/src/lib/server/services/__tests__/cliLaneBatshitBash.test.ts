import { describe, expect, it } from 'vitest'
import {
  MODE4_INTERNAL_BASH_TOOL_NAMES,
  MODE4_INTERNAL_HELPER_TOOL_NAMES
} from '../mode4InternalTools'

/**
 * BL-878, step 1 — Josh's rule (2026-09-28, 19:50 EDT): CLI agents have their own Bash, so
 * Batshit does not give them its own as well.
 *
 * The rule is ONE named constant. SA-139 R5 removed the managed CLI helper and its helper list,
 * so what reads it now is the dispatch refusal on the agent lane (`nativeCliLaneBashRefusal.test.ts`),
 * which stays with that lane until it is removed (nothing mints an agent-lane credential since R5).
 */
const BASH_HELPER = MODE4_INTERNAL_BASH_TOOL_NAMES[0]

describe('BL-878: the managed CLI lane gets no Batshit Bash helper', () => {
  it('keeps the helper in the full helper set, which old saved cards and the hidden helper names still read', () => {
    expect(MODE4_INTERNAL_HELPER_TOOL_NAMES).toContain(BASH_HELPER)
  })
})
