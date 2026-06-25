const BLOCK_LOCAL_BATSHIT_SERVER_GATEWAY = true

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function normalizePort(parsed: URL): string {
  if (parsed.port) return parsed.port
  return parsed.protocol === 'https:' ? '443' : '80'
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.trim().toLowerCase()
  if (!trimmed) return '/'
  const withoutTrailing = trimmed.replace(/\/+$/, '')
  return withoutTrailing || '/'
}

/**
 * Temporary policy lock:
 * - Block direct custom MCP gateway usage against local batshit-server endpoints.
 * - Mode 4 uses managed STDIO helper bridges instead.
 * - Modes 1-3 use native control paths.
 *
 * Flip BLOCK_LOCAL_BATSHIT_SERVER_GATEWAY to false to re-enable later.
 */
export function isBlockedBatshitServerGatewayUrl(rawUrl?: string | null): boolean {
  if (!BLOCK_LOCAL_BATSHIT_SERVER_GATEWAY || !rawUrl || typeof rawUrl !== 'string') {
    return false
  }

  try {
    const parsed = new URL(rawUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (!LOCALHOSTS.has(hostname)) return false

    const port = normalizePort(parsed)
    const pathname = normalizePath(parsed.pathname)

    // batshit-server MCP streamable endpoint
    if (port === '5601') return true

    // Defensive block for any direct /mcp or /sse targeting batshit-server app port
    if (
      port === '5600' &&
      (pathname === '/mcp' || pathname.startsWith('/mcp/') || pathname === '/sse' || pathname.startsWith('/sse/'))
    ) {
      return true
    }

    return false
  } catch {
    return false
  }
}

export function getBlockedBatshitServerGatewayReason(): string {
  return 'Local Batshit-Server MCP gateway URLs are disabled by policy. Mode 4 uses managed STDIO helpers; Modes 1-3 use native control paths.'
}
