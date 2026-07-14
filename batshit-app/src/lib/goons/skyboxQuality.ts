export type GoonSkyboxQuality = 'auto' | 'low' | 'high' | 'ultra'

export type GoonSkyboxTextureBudget = {
  requestedMaxSize: number
  effectiveMaxSize: number
  deviceCapped: boolean
}

export function resolveGoonSkyboxTextureBudget(options: {
  embeddedWebKitRuntime: boolean
  quality: GoonSkyboxQuality
  supportedMaxSize?: number | null
}): GoonSkyboxTextureBudget {
  if (!options.embeddedWebKitRuntime) {
    return { requestedMaxSize: 0, effectiveMaxSize: 0, deviceCapped: false }
  }

  const requestedMaxSize =
    options.quality === 'low' ? 2048 : options.quality === 'ultra' ? 8192 : 4096
  const supportedMaxSize =
    typeof options.supportedMaxSize === 'number' &&
    Number.isFinite(options.supportedMaxSize) &&
    options.supportedMaxSize > 0
      ? Math.floor(options.supportedMaxSize)
      : requestedMaxSize
  const effectiveMaxSize = Math.min(requestedMaxSize, supportedMaxSize)
  return {
    requestedMaxSize,
    effectiveMaxSize,
    deviceCapped: effectiveMaxSize < requestedMaxSize
  }
}
