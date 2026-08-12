export type GoonRendererConstructionOptions = {
  antialias: true
  alpha: false
  powerPreference: 'high-performance'
  forceWebGL: boolean
  requiredLimits?: {
    maxTextureArrayLayers: number
  }
}

export type GoonRendererBackendPolicyReason =
  | 'default-webgpu'
  | 'debug-webgl2'
  | 'embedded-webkit-stability'
  | 'explicit-webgpu'
  | 'explicit-webgl2'

export type GoonRendererBackendPolicy = {
  forceWebGL2: boolean
  reason: GoonRendererBackendPolicyReason
}

export function resolveGoonRendererBackendPolicy(options: {
  explicitForceWebGL2?: boolean
  embeddedWebKitRuntime: boolean
  debugForceWebGL2: boolean
}): GoonRendererBackendPolicy {
  if (options.explicitForceWebGL2 !== undefined) {
    return {
      forceWebGL2: options.explicitForceWebGL2,
      reason: options.explicitForceWebGL2 ? 'explicit-webgl2' : 'explicit-webgpu'
    }
  }
  if (options.embeddedWebKitRuntime) {
    return {
      forceWebGL2: true,
      reason: 'embedded-webkit-stability'
    }
  }
  if (options.debugForceWebGL2) {
    return {
      forceWebGL2: true,
      reason: 'debug-webgl2'
    }
  }
  return {
    forceWebGL2: false,
    reason: 'default-webgpu'
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
