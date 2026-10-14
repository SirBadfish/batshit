/**
 * BL-341: the lines a Portable Skill reads from its private env file (`portable-skills.env`).
 * Their address is the Batshit the user is on, never a fixed port: the Settings snippet passes the
 * page's own origin, and the server's placeholder file the origin its request came in on (each
 * shipped lane sets `ORIGIN`). Browser-safe; the server's `portableSkillTokens.ts` uses it too.
 */

/**
 * The address an outside agent on this computer uses for this Batshit. `localhost` becomes
 * `127.0.0.1`, the rule the wake-up webhook address follows (`AdminWakeHooksSection.svelte`): Node
 * resolves `localhost` to IPv6 `::1` first, and Batshit listens on IPv4. An empty origin is
 * refused: there is no default Batshit to point at.
 */
export function portableSkillBaseUrl(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('The Batshit address for the Portable Skill env file is unknown.')
  }
  return trimmed.replace(/\/\/localhost(?=[:/]|$)/, '//127.0.0.1')
}

/** `BATSHIT_BASE_URL` and `BATSHIT_PORTABLE_TOKEN`, one per line, ending with a newline. */
export function buildPortableSkillEnvLines(origin: string, token: string): string {
  return ['BATSHIT_BASE_URL=' + portableSkillBaseUrl(origin), 'BATSHIT_PORTABLE_TOKEN=' + token, ''].join('\n')
}
