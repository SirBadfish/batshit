type RedisConnectionEnv = {
  REDIS_URL?: string
  REDIS_HOST?: string
  REDIS_PORT?: string
  REDIS_DB?: string
  // SvelteKit generates $env/dynamic/private's type from whichever variables exist on
  // the machine running `svelte-kit sync`. Without this index signature the type above
  // is "weak", and passing `env` fails typecheck on any machine whose environment
  // happens to contain none of the four keys (e.g. CI runners with no .env).
  [key: string]: string | undefined
}

function formatRedisHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
    return `[${host}]`
  }
  return host
}

export function resolveRedisConnectionUrl(env: RedisConnectionEnv): string {
  if (env.REDIS_URL && env.REDIS_URL.trim().length > 0) {
    return env.REDIS_URL.trim()
  }

  const host = formatRedisHost((env.REDIS_HOST || 'localhost').trim() || 'localhost')
  const port = (env.REDIS_PORT || '6379').trim() || '6379'
  const db = env.REDIS_DB && env.REDIS_DB.trim().length > 0 ? `/${env.REDIS_DB.trim()}` : ''

  return `redis://${host}:${port}${db}`
}
