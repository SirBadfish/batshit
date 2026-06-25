import { env } from '$env/dynamic/private'

function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function resolveCliHelperBatshitToken(userId?: string | null): Promise<string | null> {
  void userId
  return normalizeToken(env.BATSHIT_TOKEN) ?? normalizeToken(env.MCP_GATEWAY_AUTH_TOKEN)
}
