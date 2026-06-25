type PrivateEnv = Record<string, string | undefined>

let cachedPrivateEnv: PrivateEnv | null | undefined

async function loadSvelteKitPrivateEnv(): Promise<PrivateEnv | null> {
  if (cachedPrivateEnv !== undefined) {
    return cachedPrivateEnv
  }

  try {
    const mod = (await import('$env/dynamic/private')) as { env?: PrivateEnv }
    cachedPrivateEnv = mod?.env ?? null
  } catch {
    cachedPrivateEnv = null
  }

  return cachedPrivateEnv
}

export async function getRuntimeEnv(name: string): Promise<string | undefined> {
  const direct = process.env[name]
  if (direct !== undefined) {
    return direct
  }

  const env = await loadSvelteKitPrivateEnv()
  return env?.[name]
}

export async function requireRuntimeEnv(name: string): Promise<string> {
  const value = await getRuntimeEnv(name)
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

