import { error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import {
  buildDockerGatewayUpstreamUrl,
  getDockerGatewayAuthToken,
  shouldUseDockerGatewayProxy
} from '$lib/server/services/dockerGatewayConfig'

const FORWARDED_HEADER_DENYLIST = new Set([
  'connection',
  'cookie',
  'host',
  'transfer-encoding'
])

const RESPONSE_HEADER_DENYLIST = new Set([
  'connection',
  'transfer-encoding'
])

const expectedAuthorizationHeader = (): string | null => {
  const token = getDockerGatewayAuthToken()
  return token ? `Bearer ${token}` : null
}

const resolveProxyPath = (path?: string): string => {
  const cleaned = (path || 'mcp').replace(/^\/+/, '')
  return `/${cleaned || 'mcp'}`
}

const localhostHostHeaderFor = (target: URL): string => {
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  return `localhost:${port}`
}

const copyRequestHeaders = (request: Request, target: URL): Record<string, string> => {
  const headers: Record<string, string> = {
    Host: localhostHostHeaderFor(target)
  }

  request.headers.forEach((value, key) => {
    if (FORWARDED_HEADER_DENYLIST.has(key.toLowerCase())) return
    headers[key] = value
  })

  return headers
}

const copyResponseHeaders = (headers: http.IncomingHttpHeaders): Headers => {
  const responseHeaders = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (RESPONSE_HEADER_DENYLIST.has(key.toLowerCase())) continue
    if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(key, entry)
    } else if (typeof value === 'string') {
      responseHeaders.set(key, value)
    }
  }
  return responseHeaders
}

const dockerGatewayUnavailableResponse = (target: URL, reason: unknown): Response => {
  const detail = reason instanceof Error ? reason.message : String(reason || 'Unknown error')
  const message = `Docker MCP Gateway is not reachable at ${target.origin}${target.pathname}. Start the host Docker MCP Gateway on the configured port or update .env.docker and restart containers.`
  console.error('[Docker MCP Gateway Proxy] Upstream unavailable:', {
    target: `${target.origin}${target.pathname}`,
    reason: detail
  })

  return new Response(
    JSON.stringify({
      error: message,
      code: 'DOCKER_MCP_GATEWAY_UNREACHABLE',
      detail
    }),
    {
      status: 503,
      headers: { 'content-type': 'application/json' }
    }
  )
}

const forwardToGateway = async (request: Request, path: string): Promise<Response> => {
  if (!shouldUseDockerGatewayProxy()) {
    throw error(404, 'Docker MCP Gateway proxy is disabled')
  }

  const expectedAuth = expectedAuthorizationHeader()
  if (!expectedAuth) {
    throw error(503, 'Docker MCP Gateway token is not configured')
  }

  const suppliedAuth = request.headers.get('authorization') || ''
  if (suppliedAuth !== expectedAuth) {
    return apiError('Unauthorized', 401)
  }

  const target = new URL(buildDockerGatewayUpstreamUrl(path))
  const requestBody = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer())
  const transport = target.protocol === 'https:' ? https : http

  try {
    return await new Promise<Response>((resolve, reject) => {
      const upstreamRequest = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: copyRequestHeaders(request, target),
          signal: request.signal
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode || 502
          const headers = copyResponseHeaders(upstreamResponse.headers)
          const body =
            status === 204 || request.method === 'HEAD'
              ? null
              : (Readable.toWeb(upstreamResponse) as ReadableStream)

          resolve(new Response(body, { status, headers }))
        }
      )

      upstreamRequest.on('error', reject)

      if (requestBody) {
        upstreamRequest.write(requestBody)
      }
      upstreamRequest.end()
    })
  } catch (proxyError) {
    return dockerGatewayUnavailableResponse(target, proxyError)
  }
}

const handle: RequestHandler = async ({ request, params, url }) => {
  const proxyPath = resolveProxyPath(params.path)
  const upstreamPath = `${proxyPath}${url.search}`
  return forwardToGateway(request, upstreamPath)
}

export const GET = handle
export const POST = handle
export const DELETE = handle
export const OPTIONS: RequestHandler = async () => new Response(null, { status: 204 })
