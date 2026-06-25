import { buildDockerGatewayHeaders, buildDockerGatewayUrl } from './dockerGatewayConfig'

/**
 * Docker MCP Gateway Manager
 *
 * Lifecycle ownership stays with the active runtime launcher. Batshit only
 * observes gateway status and reports clear ownership errors for direct
 * start/stop requests from the app process.
 */

type GatewayStatus = 'running' | 'stopped' | 'error'
type GatewayMutationResult = { success: boolean; error?: string }

const lifecycleOwner = (): string => {
  if (process.env.BATSHIT_RUNTIME_OWNER === 'mac-app') return 'Mac Runtime Doctor'
  if (process.env.BATSHIT_CONTAINERIZED === '1') return 'start-docker.sh'
  return 'the active Batshit runtime launcher'
}

const lifecycleHint = (): string => {
  if (process.env.BATSHIT_RUNTIME_OWNER === 'mac-app') {
    return 'Open Runtime Doctor and restart the Mac runtime to launch or repair Docker MCP Gateway.'
  }
  if (process.env.BATSHIT_CONTAINERIZED === '1') {
    return 'Update .env.docker if needed, then run ./start-docker.sh to launch or repair Docker MCP Gateway.'
  }
  return 'Restart the active Batshit runtime launcher to launch or repair Docker MCP Gateway.'
}

const resolvePortFromEnv = (): number | null => {
  const explicitPort = Number.parseInt(process.env.DOCKER_MCP_GATEWAY_PORT ?? '', 10)
  if (Number.isFinite(explicitPort) && explicitPort > 0) {
    return explicitPort
  }

  const rawUrl = process.env.DOCKER_MCP_GATEWAY_URL?.trim()
  if (!rawUrl) {
    return null
  }

  try {
    const parsed = new URL(rawUrl)
    if (parsed.port) {
      const port = Number.parseInt(parsed.port, 10)
      if (Number.isFinite(port) && port > 0) return port
    }
    if (parsed.protocol === 'https:') return 443
    if (parsed.protocol === 'http:') return 80
  } catch {
    // Ignore invalid URL and fall back to default port
  }

  return null
}

const normalizePort = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return fallback
}

export class DockerGatewayManager {
  private gatewayPort: number

  constructor() {
    this.gatewayPort = resolvePortFromEnv() ?? 8080
  }

  getLifecycleOwner(): string {
    return lifecycleOwner()
  }

  getGatewayPort(): number {
    return this.gatewayPort
  }

  async initialize(userSettings: any) {
    this.updateSettings({ port: userSettings?.dockerMCP?.port })
  }

  async startGatewayIfNeeded(): Promise<boolean> {
    const status = await this.getStatus()
    return status === 'running'
  }

  async startGateway(): Promise<GatewayMutationResult> {
    return {
      success: false,
      error: `Docker MCP Gateway lifecycle is managed by ${lifecycleOwner()}. ${lifecycleHint()}`
    }
  }

  stopGateway(): GatewayMutationResult {
    return {
      success: false,
      error: `Docker MCP Gateway lifecycle is managed by ${lifecycleOwner()}. ${lifecycleHint()}`
    }
  }

  async getStatus(): Promise<GatewayStatus> {
    try {
      const response = await fetch(buildDockerGatewayUrl('/mcp'), {
        headers: buildDockerGatewayHeaders(),
        signal: AbortSignal.timeout(1000)
      })
      if ([200, 202, 204, 307, 400, 405].includes(response.status)) return 'running'
      if (response.status === 401 || response.status === 403) return 'error'
      return 'stopped'
    } catch {
      return 'stopped'
    }
  }

  updateSettings(settings: { port?: number | string | null | undefined }) {
    this.gatewayPort = normalizePort(settings.port, this.gatewayPort)
  }
}

// Export singleton instance
export const gatewayManager = new DockerGatewayManager()
