import path from 'node:path'
import { resolveCliHelperBatshitBaseUrl } from '$lib/server/services/cliHelperBaseUrl'
import { buildDockerGatewayUrl } from '$lib/server/services/dockerGatewayConfig'

/**
 * BL-152 — the two values a managed CLI helper server's launch depends on that differ between
 * Batshit processes on one Mac: the folder its script lives in (each checkout, worktree, or app
 * bundle has its own) and the URL of the Batshit app it calls back.
 *
 * Every Batshit on the Mac (the Mac app, a dev lane, a worktree lane) shares
 * `~/.batshit/agents/<profile>`, and each one's profile sync rewrites every agent's managed
 * config. With these two values written into the shared files, a run whose config another
 * Batshit rewrote between the run's sync and its start launched the other process's helper
 * script, which called the other server. So the shared files carry only a reference to each
 * value, and every run supplies its own process's values:
 * - Codex does not expand references in its config, so the Codex bridge fills them per run
 *   with a `--config mcp_servers.<id>.args=[…]` override (`codexProfileManager.ts`).
 * - Claude Code expands `${VAR}` in an `--mcp-config` file's `command`, `args`, `env`, and
 *   `url`, so the Claude bridge sets the variables in the CLI's environment for the run.
 *
 * BL-310 adds a third value of the same kind: the address of the Docker MCP gateway, which the
 * app builds from its own runtime (`buildDockerGatewayUrl`: this lane's gateway port or URL, and
 * the in-app proxy in Docker Batshit). The shared files write it as a reference in the Docker
 * gateway's `url`, and each run fills it the same way (Codex: a per-run
 * `--config mcp_servers.<id>.url=…`).
 */

export const CLI_HELPER_SCRIPTS_DIR_ENV = 'BATSHIT_CLI_HELPER_SCRIPTS_DIR'
export const CLI_HELPER_BASE_URL_ENV = 'BATSHIT_CLI_HELPER_BASE_URL'
export const CLI_DOCKER_MCP_GATEWAY_URL_ENV = 'BATSHIT_CLI_DOCKER_MCP_GATEWAY_URL'

const SCRIPTS_DIR_REF = '${' + CLI_HELPER_SCRIPTS_DIR_ENV + '}'
const BASE_URL_REF = '${' + CLI_HELPER_BASE_URL_ENV + '}'
const DOCKER_MCP_GATEWAY_URL_REF = '${' + CLI_DOCKER_MCP_GATEWAY_URL_ENV + '}'

export interface CliHelperLaunchValues {
  scriptsDir: string
  baseUrl: string
  /** BL-310: where this process's app reaches the Docker MCP gateway. */
  dockerGatewayUrl: string
}

/**
 * This process's values: its own `scripts` folder, the app URL its helpers call back, and the
 * Docker MCP gateway address the app itself uses.
 */
export function resolveCliHelperLaunchValues(): CliHelperLaunchValues {
  return {
    scriptsDir: path.join(process.cwd(), 'scripts'),
    baseUrl: resolveCliHelperBatshitBaseUrl(),
    dockerGatewayUrl: buildDockerGatewayUrl('/mcp')
  }
}

/** BL-310: the Docker MCP gateway's `url` as the shared managed files write it. */
export function cliDockerGatewayUrlRef(): string {
  return DOCKER_MCP_GATEWAY_URL_REF
}

/** A helper script's path as the shared managed files write it. */
export function cliHelperScriptRef(scriptName: string): string {
  return `${SCRIPTS_DIR_REF}/${scriptName}`
}

/** The helper's `--url` argument as the shared managed files write it. */
export function cliHelperUrlArgRef(): string {
  return `--url=${BASE_URL_REF}`
}

export function hasCliHelperLaunchRef(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.includes(SCRIPTS_DIR_REF) ||
      value.includes(BASE_URL_REF) ||
      value.includes(DOCKER_MCP_GATEWAY_URL_REF))
  )
}

/** The same value with this process's values in place of the references. */
export function fillCliHelperLaunchRefs(value: string, values: CliHelperLaunchValues): string {
  return value
    .split(SCRIPTS_DIR_REF)
    .join(values.scriptsDir)
    .split(BASE_URL_REF)
    .join(values.baseUrl)
    .split(DOCKER_MCP_GATEWAY_URL_REF)
    .join(values.dockerGatewayUrl)
}

/** The environment a Claude run needs for Claude Code to expand the references itself. */
export function cliHelperLaunchEnv(values: CliHelperLaunchValues): Record<string, string> {
  return {
    [CLI_HELPER_SCRIPTS_DIR_ENV]: values.scriptsDir,
    [CLI_HELPER_BASE_URL_ENV]: values.baseUrl,
    [CLI_DOCKER_MCP_GATEWAY_URL_ENV]: values.dockerGatewayUrl
  }
}
