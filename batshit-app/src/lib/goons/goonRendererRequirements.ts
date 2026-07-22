export type GoonRendererConstructionOptions = {
  antialias: true
  alpha: false
  powerPreference: 'high-performance'
  forceWebGL: boolean
  requiredLimits?: {
    maxTextureArrayLayers: number
  }
}

export function buildGoonRendererConstructionOptions(
  forceWebGL: boolean,
  requiredMaxTextureArrayLayers: number
): GoonRendererConstructionOptions {
  if (!Number.isInteger(requiredMaxTextureArrayLayers) || requiredMaxTextureArrayLayers < 0) {
    throw new Error('Renderer texture-array requirement must be a non-negative integer.')
  }
  return {
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    forceWebGL,
    ...(!forceWebGL && requiredMaxTextureArrayLayers > 0
      ? {
          requiredLimits: {
            maxTextureArrayLayers: requiredMaxTextureArrayLayers
          }
        }
      : {})
  }
}

export function shouldRetryGoonRendererWithWebGL2(
  forceWebGL: boolean,
  requiredMaxTextureArrayLayers: number
) {
  return !forceWebGL && requiredMaxTextureArrayLayers > 0
}
