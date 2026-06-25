import { env } from '$env/dynamic/private'
import { timingSafeEqual } from 'crypto'

function safeTokenEquals(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false

  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false

  return timingSafeEqual(actualBuffer, expectedBuffer)
}

export function getConfiguredInternalToken(): string | undefined {
  return env.BATSHIT_TOKEN || env.MCP_GATEWAY_AUTH_TOKEN || undefined
}

export function isTrustedInternalRequest(request: Request): boolean {
  const configuredToken = getConfiguredInternalToken()
  const suppliedToken =
    request.headers.get('x-batshit-service-token') ||
    request.headers.get('x-batshit-token')

  return safeTokenEquals(suppliedToken, configuredToken)
}

export function internalServiceHeaders(): Record<string, string> {
  const token = getConfiguredInternalToken()
  return token
    ? {
        'x-batshit-service-token': token,
        'x-internal-api-request': '1'
      }
    : {}
}
