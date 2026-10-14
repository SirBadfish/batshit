const BLOCK_LOCAL_BATSHIT_SERVER_GATEWAY = true

/**
 * Does a URL hostname (as `URL` gives it) reach this computer? `URL` already writes every IPv4 spelling
 * (`127.1`, `2130706433`, `0x7f.1`) as dotted decimal and keeps IPv6 brackets, writing an IPv4-mapped
 * address in hex (`[::ffff:127.0.0.1]` is `[::ffff:7f00:1]`). What is left: a trailing dot
 * (`localhost.`), `*.localhost`, all of 127.0.0.0/8, 0.0.0.0 and `[::]` (connecting to them reaches this
 * computer), `[::1]`, and the IPv4-mapped forms of those.
 */
function reachesThisComputer(urlHostname: string): boolean {
  const host = urlHostname.toLowerCase().replace(/\.+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1)
    if (address === '::1' || address === '::') return true
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
    if (!mapped) return false
    const high = Number.parseInt(mapped[1], 16)
    const low = Number.parseInt(mapped[2], 16)
    return high >> 8 === 127 || (high === 0 && low === 0)
  }
  const octets = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!octets) return false
  return Number(octets[1]) === 127 || host === '0.0.0.0'
}

// Batshit's streamable MCP helper (supergateway over batshit-server's src/mcp/index.js): the Mac
// app's 5601 and the native lane's 5611, plus whatever port this instance started it on.
const STREAMABLE_HELPER_PORTS = ['5601', '5611']
// batshit-server itself: the Mac app's 5600 and the native lane's 5610.
const BATSHIT_SERVER_PORTS = ['5600', '5610']

function streamableHelperPorts(): Set<string> {
  const ports = new Set(STREAMABLE_HELPER_PORTS)
  // Compared with a URL's port as written; a value that is not a port matches none.
  const configured = process.env.BATSHIT_MCP_STREAMABLE_PORT?.trim()
  if (configured) ports.add(configured)
  return ports
}

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
    if (!reachesThisComputer(parsed.hostname)) return false

    const port = normalizePort(parsed)
    const pathname = normalizePath(parsed.pathname)

    // Batshit's own streamable MCP helper, on any path.
    if (streamableHelperPorts().has(port)) return true

    // Defensive block for any direct /mcp or /sse targeting batshit-server's own port
    if (
      BATSHIT_SERVER_PORTS.includes(port) &&
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
