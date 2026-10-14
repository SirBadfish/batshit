/**
 * SA-117 P2 (DL-117-07) — what leaves a managed CLI child's environment, and what does not.
 *
 * Both bridges spread the app's whole `process.env` into the child. This applies the
 * token rules on top of that spread, in ONE place, because the Codex and Claude lanes build
 * their child environments in different files and a rule written twice is a rule that drifts.
 *
 * 1. **`BATSHIT_TOKEN` is deleted.** The helpers no longer need it: they authenticate with the
 *    run credential. Deleting it is the only way it actually leaves — the two
 *    `options.batshitToken` re-sets the bridges used to do were redundant, because the child
 *    inherited the variable from the spread regardless (Part 2.4 of the story).
 * 2. **`BATSHIT_AGENT_TOKEN` is set** to this run's credential, when there is one.
 * 3. **`MCP_GATEWAY_AUTH_TOKEN` survives only for a run that resolved a Docker gateway token.**
 *    It unlocks the user's Docker MCP gateway, which is a separate boundary with its own
 *    secret; it is not an alternative spelling of the app's service lane (the app boot-fails
 *    without a real `BATSHIT_TOKEN`, so it can never match there). A run with no gateway does
 *    not need it, so it does not get it.
 * 4. Host operator bearer tokens and the voice recipe signing key/path are removed. An
 *    agent-controlled child must not gain authority to start host voice programs.
 *
 * **What this deliberately does NOT do, and the story says so out loud (Scope).** `REDIS_URL`,
 * `REDIS_PASSWORD`, `REDIS_CONNECTION_STRING`, `ENCRYPTION_KEY` and every provider API key
 * stay. The Claude permission bridge and the Codex subagent bridge read Redis directly, the
 * CLI needs its own provider auth, and the root `.env` holds the same secrets on disk for any
 * same-user process to read. A deny-list here would break those two bridges and fence nothing:
 * the CLI's shell IS the user's shell on this host. Converting both bridges to HTTP on the run
 * credential, and only then allow-listing the child environment, is its own story.
 */

import { AGENT_RUN_CREDENTIAL_ENV_VAR } from '$lib/server/services/agentRunCredentials'

export const BATSHIT_INSTANCE_TOKEN_ENV_VAR = 'BATSHIT_TOKEN'
export const DOCKER_GATEWAY_TOKEN_ENV_VAR = 'MCP_GATEWAY_AUTH_TOKEN'

/** Host-operator authority never belongs in an agent-controlled child process. */
export function stripHostOperatorAuthorityFromChildEnv(childEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete childEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN
  delete childEnv.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN
  delete childEnv.BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY
  delete childEnv.BATSHIT_HOST_VOICE_RECIPE_KEY_FILE
  return childEnv
}

/**
 * Local native commands already act through the in-process broker. They receive no helper
 * credential or inherited transport bearer. Apply this to the final environment, after tool
 * overrides, so an override cannot restore app authority. Ordinary user/tool values remain.
 * This is credential cleanup, not isolation from files readable by the same host user.
 */
export function stripNativeCommandAuthorityFromChildEnv(childEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  stripHostOperatorAuthorityFromChildEnv(childEnv)
  delete childEnv[BATSHIT_INSTANCE_TOKEN_ENV_VAR]
  delete childEnv[AGENT_RUN_CREDENTIAL_ENV_VAR]
  delete childEnv[DOCKER_GATEWAY_TOKEN_ENV_VAR]
  delete childEnv.DOCKER_MCP_AUTH_TOKEN
  delete childEnv.DOCKER_MCP_GATEWAY_TOKEN
  delete childEnv.BATSHIT_DOCKER_MCP_TOKEN
  // The parent authenticates sidecar requests; a local Agent Browser process does not.
  delete childEnv.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN
  delete childEnv.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN
  delete childEnv.BATSHIT_N8N_INSTANCE_MCP_TOKEN
  return childEnv
}

/**
 * Mutates and returns `childEnv`. Both bridges call this after their own spread. They strip
 * host operator authority again after their extra variables so later assignments cannot
 * restore that authority.
 */
export function applyCliRunCredentialToChildEnv(
  childEnv: NodeJS.ProcessEnv,
  options: {
    /** `<credentialId>.<secret>` for this run, or nothing when no credential was minted. */
    agentRunToken?: string | null
    /** The Docker MCP gateway token this run resolved, if any. */
    dockerAuthToken?: string | null
  }
): NodeJS.ProcessEnv {
  delete childEnv[BATSHIT_INSTANCE_TOKEN_ENV_VAR]
  delete childEnv[DOCKER_GATEWAY_TOKEN_ENV_VAR]
  stripHostOperatorAuthorityFromChildEnv(childEnv)

  const gatewayToken =
    typeof options.dockerAuthToken === 'string' ? options.dockerAuthToken.trim() : ''
  if (gatewayToken) {
    childEnv[DOCKER_GATEWAY_TOKEN_ENV_VAR] = gatewayToken
  }

  const agentRunToken =
    typeof options.agentRunToken === 'string' ? options.agentRunToken.trim() : ''
  if (agentRunToken) {
    childEnv[AGENT_RUN_CREDENTIAL_ENV_VAR] = agentRunToken
  } else {
    // A run that minted nothing must not inherit a stale credential from the app's own
    // environment: the helper failing loudly is the correct outcome, not authenticating as
    // whatever run happened to export one last.
    delete childEnv[AGENT_RUN_CREDENTIAL_ENV_VAR]
  }

  return childEnv
}
