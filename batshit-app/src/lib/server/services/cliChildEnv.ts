/**
 * SA-117 P2 (DL-117-07) — what leaves a child process's environment, and what does not, in ONE
 * place, because a rule written in each spawner's own file is a rule that drifts.
 *
 * 1. Host operator bearer tokens and the voice recipe signing key/path are removed from every
 *    child an agent can reach (`stripHostOperatorAuthorityFromChildEnv`). An agent-controlled
 *    child must not gain authority to start host voice programs.
 * 2. A local native command also loses the app's own credentials (`BATSHIT_TOKEN`, a run
 *    credential, the Docker MCP gateway token and the sidecar tokens,
 *    `stripNativeCommandAuthorityFromChildEnv`): it acts through the in-process broker.
 *
 * (SA-139 R5 removed the managed CLI helper bridge, and with it the rule that handed a run's
 * credential and Docker gateway token to that bridge's child.)
 *
 * **What this deliberately does NOT do, and the story says so out loud (Scope).** `REDIS_URL`,
 * `REDIS_PASSWORD`, `REDIS_CONNECTION_STRING`, `ENCRYPTION_KEY` and every provider API key
 * stay. A CLI needs its own provider auth, and the root `.env` holds the same secrets on disk
 * for any same-user process to read, so a deny-list here would fence nothing: the child's shell
 * IS the user's shell on this host.
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
