import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  controlRuntimeAddon,
  getRuntimeAddonCatalogEntry,
  getRuntimeAddonOperatorStatus,
  getRuntimeAddonStatus,
  listRuntimeAddons,
  prepareRuntimeAddon
} from '../runtimeAddons'

const originalContainerized = process.env.BATSHIT_CONTAINERIZED
const originalWorkerUrl = process.env.BATSHIT_FBX2VRMA_WORKER_URL
const originalAudio2FaceBridgeUrl = process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL
const originalAudio2FaceBridgeToken = process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN
const originalComfyUiValidationUrl = process.env.BATSHIT_COMFYUI_VALIDATION_URL
const originalAgentBrowserSidecarUrl = process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL
const originalLiveKitUrl = process.env.LIVEKIT_URL
const originalLiveKitInternalUrl = process.env.LIVEKIT_INTERNAL_URL
const originalLiveKitAgentHealthUrl = process.env.LIVEKIT_AGENT_HEALTH_URL
const originalOperatorUrl = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL
const originalOperatorToken = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN
const originalSandboxOperatorUrl = process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL
const originalSandboxOperatorToken = process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN

function restoreEnv() {
  if (originalContainerized === undefined) {
    delete process.env.BATSHIT_CONTAINERIZED
  } else {
    process.env.BATSHIT_CONTAINERIZED = originalContainerized
  }

  if (originalWorkerUrl === undefined) {
    delete process.env.BATSHIT_FBX2VRMA_WORKER_URL
  } else {
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = originalWorkerUrl
  }

  if (originalAudio2FaceBridgeUrl === undefined) {
    delete process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL
  } else {
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL = originalAudio2FaceBridgeUrl
  }

  if (originalAudio2FaceBridgeToken === undefined) {
    delete process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN
  } else {
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN = originalAudio2FaceBridgeToken
  }

  if (originalComfyUiValidationUrl === undefined) {
    delete process.env.BATSHIT_COMFYUI_VALIDATION_URL
  } else {
    process.env.BATSHIT_COMFYUI_VALIDATION_URL = originalComfyUiValidationUrl
  }

  if (originalAgentBrowserSidecarUrl === undefined) {
    delete process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL
  } else {
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = originalAgentBrowserSidecarUrl
  }

  if (originalLiveKitUrl === undefined) {
    delete process.env.LIVEKIT_URL
  } else {
    process.env.LIVEKIT_URL = originalLiveKitUrl
  }

  if (originalLiveKitInternalUrl === undefined) {
    delete process.env.LIVEKIT_INTERNAL_URL
  } else {
    process.env.LIVEKIT_INTERNAL_URL = originalLiveKitInternalUrl
  }

  if (originalLiveKitAgentHealthUrl === undefined) {
    delete process.env.LIVEKIT_AGENT_HEALTH_URL
  } else {
    process.env.LIVEKIT_AGENT_HEALTH_URL = originalLiveKitAgentHealthUrl
  }

  if (originalOperatorUrl === undefined) {
    delete process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL
  } else {
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = originalOperatorUrl
  }

  if (originalOperatorToken === undefined) {
    delete process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN
  } else {
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = originalOperatorToken
  }

  if (originalSandboxOperatorUrl === undefined) {
    delete process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL
  } else {
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL = originalSandboxOperatorUrl
  }

  if (originalSandboxOperatorToken === undefined) {
    delete process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN
  } else {
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN = originalSandboxOperatorToken
  }
}

describe('runtime add-on catalog', () => {
  afterEach(() => {
    restoreEnv()
    vi.unstubAllGlobals()
  })

  it('lists approved Docker add-ons without live status by default', async () => {
    const addons = await listRuntimeAddons()
    expect(addons.map((entry) => entry.id)).toEqual([
      'cloudflared',
      'fbx2vrma',
      'audio2face',
      'comfyui-validation',
      'comfyui',
      'local-ai',
      'voice-engines',
      'livekit',
      'agent-browser'
    ])
    expect(getRuntimeAddonCatalogEntry('fbx2vrma')).toMatchObject({
      route: 'sidecar/profile',
      composeProfile: 'fbx2vrma',
      internalUrl: 'http://fbx2vrma-worker:8079',
      controllerRequiredForAutoStart: true
    })
    expect(getRuntimeAddonCatalogEntry('audio2face')).toMatchObject({
      route: 'sidecar/profile',
      composeProfile: 'audio2face',
      internalUrl: 'http://audio2face-bridge:8068',
      services: ['audio2face-bridge'],
      controllerRequiredForAutoStart: true
    })
    expect(getRuntimeAddonCatalogEntry('local-ai')).toMatchObject({
      route: 'connect-existing',
      composeProfile: '',
      controllerRequiredForAutoStart: false
    })
    expect(getRuntimeAddonCatalogEntry('livekit')).toMatchObject({
      route: 'sidecar/profile',
      composeProfile: 'livekit',
      services: ['livekit', 'livekit-agent'],
      controllerRequiredForAutoStart: true
    })
  })

  it('reports connect-existing runtime families without pretending the operator can start them', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'

    const status = await getRuntimeAddonStatus('local-ai')
    expect(status).toMatchObject({
      id: 'local-ai',
      route: 'connect-existing',
      state: 'waiting',
      running: false,
      supported: false,
      dockerUnsupported: true,
      details: {
        supportLevel: 'connect-existing'
      }
    })

    const prepared = await prepareRuntimeAddon('voice-engines')
    expect(prepared).toMatchObject({
      id: 'voice-engines',
      route: 'connect-existing',
      canStartAutomatically: false,
      requiresOperator: false,
      operator: {
        configured: false,
        available: false
      }
    })
    expect(prepared?.nextSteps.join(' ')).toMatch(/host\.docker\.internal/)

    const result = await controlRuntimeAddon('voice-engines', 'start')
    expect(result).toMatchObject({
      success: false,
      operation: 'start',
      addonId: 'voice-engines',
      error: expect.stringContaining('connect-existing route')
    })
  })

  it('reports a waiting Agent Browser sidecar with an approved operator command', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('sidecar offline')
      })
    )

    const status = await getRuntimeAddonStatus('agent-browser')
    expect(status).toMatchObject({
      id: 'agent-browser',
      route: 'sidecar/profile',
      state: 'waiting',
      running: false,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-sidecar-missing',
        url: 'http://agent-browser.test'
      }
    })

    const prepared = await prepareRuntimeAddon('agent-browser')
    expect(prepared).toMatchObject({
      id: 'agent-browser',
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile agent-browser up -d --build agent-browser'
    })
    expect(prepared?.nextSteps.join(' ')).toMatch(/approved Compose command/i)

    const result = await controlRuntimeAddon('agent-browser', 'start')
    expect(result).toMatchObject({
      success: false,
      addonId: 'agent-browser',
      error: expect.stringContaining('Runtime add-on operator is not configured')
    })
  })

  it('reports an active Agent Browser sidecar when health is reachable', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          service: 'batshit-agent-browser-sidecar',
          mode: 'docker-sidecar',
          version: 'agent-browser 0.24.1'
        })
      )
    )

    const status = await getRuntimeAddonStatus('agent-browser')
    expect(status).toMatchObject({
      id: 'agent-browser',
      state: 'running',
      running: true,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-sidecar',
        url: 'http://agent-browser.test',
        version: 'agent-browser 0.24.1'
      }
    })
  })

  it('reports a waiting LiveKit runtime with an approved operator command', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.LIVEKIT_URL = 'ws://localhost:7880'
    process.env.LIVEKIT_INTERNAL_URL = 'ws://livekit.test:7880'
    process.env.LIVEKIT_AGENT_HEALTH_URL = 'http://livekit-agent.test/worker'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('runtime offline')
      })
    )

    const status = await getRuntimeAddonStatus('livekit')
    expect(status).toMatchObject({
      id: 'livekit',
      route: 'sidecar/profile',
      state: 'waiting',
      running: false,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-sidecar-missing',
        browserUrl: 'ws://localhost:7880',
        internalUrl: 'ws://livekit.test:7880',
        agentHealthUrl: 'http://livekit-agent.test/worker'
      }
    })

    const prepared = await prepareRuntimeAddon('livekit')
    expect(prepared).toMatchObject({
      id: 'livekit',
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile livekit up -d --build livekit livekit-agent'
    })
  })

  it('reports an active LiveKit runtime when the server and agent worker are reachable', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.LIVEKIT_URL = 'ws://localhost:7880'
    process.env.LIVEKIT_INTERNAL_URL = 'ws://livekit.test:7880'
    process.env.LIVEKIT_AGENT_HEALTH_URL = 'http://livekit-agent.test/worker'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === 'http://livekit.test:7880') {
          return new Response('OK', { status: 200 })
        }
        if (url === 'http://livekit-agent.test/worker') {
          return Response.json({
            agent_name: 'batshit-livekit-agent',
            active_jobs: 0
          })
        }
        throw new Error(`Unexpected fetch ${url}`)
      })
    )

    const status = await getRuntimeAddonStatus('livekit')
    expect(status).toMatchObject({
      id: 'livekit',
      state: 'running',
      running: true,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-sidecar',
        server: {
          ready: true,
          url: 'http://livekit.test:7880'
        },
        agent: {
          ready: true,
          agentName: 'batshit-livekit-agent',
          activeJobs: 0
        }
      }
    })
  })

  it('reports a waiting FBX worker with an approved operator command', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('worker offline')
      })
    )

    const status = await getRuntimeAddonStatus('fbx2vrma')
    expect(status).toMatchObject({
      id: 'fbx2vrma',
      state: 'waiting',
      running: false,
      dockerUnsupported: true,
      installHelp:
        'Start the optional Docker worker with: docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker'
    })

    const prepared = await prepareRuntimeAddon('fbx2vrma')
    expect(prepared).toMatchObject({
      id: 'fbx2vrma',
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker',
      operator: {
        configured: false,
        available: false
      }
    })
  })

  it('reports an active FBX worker when its health check passes', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          status: 'ready',
          mode: 'docker-worker',
          version: 'v0.9.7',
          fbx2gltfVersion: 'FBX2glTF version 0.9.7'
        })
      )
    )

    const status = await getRuntimeAddonStatus('fbx2vrma')
    expect(status).toMatchObject({
      id: 'fbx2vrma',
      state: 'running',
      running: true,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-worker',
        worker: {
          running: true,
          url: 'http://fbx2vrma-worker.test'
        },
        manifest: {
          checksumVerified: true
        }
      }
    })

    const prepared = await prepareRuntimeAddon('fbx2vrma')
    expect(prepared).toMatchObject({
      id: 'fbx2vrma',
      canStartAutomatically: false,
      requiresOperator: false
    })
  })

  it('requires a distinct Audio2Face bridge token before probing the sidecar', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL = 'http://audio2face.test'
    delete process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const status = await getRuntimeAddonStatus('audio2face')
    expect(status).toMatchObject({
      id: 'audio2face',
      state: 'waiting',
      running: false,
      supported: true,
      dockerUnsupported: false,
      reason: expect.stringContaining('BATSHIT_AUDIO2FACE_BRIDGE_TOKEN'),
      details: {
        supportLevel: 'docker-sidecar-missing-token',
        url: 'http://audio2face.test'
      }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('distinguishes a live Audio2Face bridge from a ready NVIDIA NIM runtime', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL = 'http://audio2face.test'
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN = 'audio2face-token'
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)?.authorization).toBe(
        'Bearer audio2face-token'
      )
      return Response.json({
        ok: false,
        bridgeRunning: true,
        nimReady: false,
        reason: 'NVIDIA Audio2Face gRPC health check failed: UNAVAILABLE.',
        version: '0.1.0',
        protocol: 'nvidia-audio2face-3d-v2-bidirectional-grpc',
        outputFps: 30,
        cacheSchema: 'batshit-audio2face/v1'
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const status = await getRuntimeAddonStatus('audio2face')
    expect(status).toMatchObject({
      id: 'audio2face',
      state: 'waiting',
      running: false,
      supported: true,
      reason: 'NVIDIA Audio2Face gRPC health check failed: UNAVAILABLE.',
      details: {
        supportLevel: 'docker-sidecar-waiting',
        bridgeRunning: true,
        nimReady: false,
        outputFps: 30,
        cacheSchema: 'batshit-audio2face/v1'
      }
    })
  })

  it('reports Audio2Face ready only when both bridge and NIM are healthy', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL = 'http://audio2face.test'
    process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN = 'audio2face-token'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          bridgeRunning: true,
          nimReady: true,
          version: '0.1.0',
          protocol: 'nvidia-audio2face-3d-v2-bidirectional-grpc',
          outputFps: 30,
          cacheSchema: 'batshit-audio2face/v1'
        })
      )
    )

    const status = await getRuntimeAddonStatus('audio2face')
    expect(status).toMatchObject({
      id: 'audio2face',
      state: 'running',
      running: true,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-sidecar',
        bridgeRunning: true,
        nimReady: true,
        version: '0.1.0'
      }
    })

    const prepared = await prepareRuntimeAddon('audio2face')
    expect(prepared).toMatchObject({
      id: 'audio2face',
      canStartAutomatically: false,
      requiresOperator: false,
      operatorCommand:
        'docker compose --env-file .env.docker --profile audio2face up -d --build audio2face-bridge'
    })
  })

  it('reports a waiting ComfyUI validation sidecar with an approved operator command', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_COMFYUI_VALIDATION_URL = 'http://comfyui.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('sidecar offline')
      })
    )

    const status = await getRuntimeAddonStatus('comfyui-validation')
    expect(status).toMatchObject({
      id: 'comfyui-validation',
      state: 'waiting',
      running: false,
      dockerUnsupported: true,
      installHelp:
        'docker compose --env-file .env.docker --profile comfyui-validation up -d --build comfyui-validation',
      details: {
        supportLevel: 'docker-sidecar-missing',
        url: 'http://comfyui.test'
      }
    })

    const prepared = await prepareRuntimeAddon('comfyui-validation')
    expect(prepared).toMatchObject({
      id: 'comfyui-validation',
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile comfyui-validation up -d --build comfyui-validation'
    })
  })

  it('reports an active ComfyUI validation sidecar when system_stats is reachable', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_COMFYUI_VALIDATION_URL = 'http://comfyui.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          system: {
            os: 'batshit-comfyui-validation'
          }
        })
      )
    )

    const status = await getRuntimeAddonStatus('comfyui-validation')
    expect(status).toMatchObject({
      id: 'comfyui-validation',
      state: 'running',
      running: true,
      supported: true,
      dockerUnsupported: false,
      details: {
        supportLevel: 'docker-sidecar',
        url: 'http://comfyui.test',
        systemStats: {
          system: {
            os: 'batshit-comfyui-validation'
          }
        }
      }
    })
  })

  it('reports configured operator availability and prepares automatic start', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = 'http://operator.test'
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = 'operator-token'

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === 'http://operator.test/health') {
          return Response.json({
            ok: true,
            controls: ['start', 'stop']
          })
        }
        throw new Error(`Unexpected fetch ${url}`)
      })
    )

    const prepared = await prepareRuntimeAddon('fbx2vrma')
    expect(prepared).toMatchObject({
      id: 'fbx2vrma',
      canStartAutomatically: true,
      requiresOperator: true,
      operator: {
        configured: true,
        available: true,
        url: 'http://operator.test'
      }
    })
    expect(prepared?.nextSteps.join(' ')).toMatch(/runtime_addon_start/)
  })

  it('can reuse the Docker Sandbox operator config for approved add-on controls', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL = 'http://operator.test'
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN = 'sandbox-operator-token'

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === 'http://fbx2vrma-worker.test/health') {
          throw new Error('worker offline')
        }
        if (url === 'http://operator.test/health') {
          expect((init?.headers as Record<string, string>)?.authorization).toBe(
            'Bearer sandbox-operator-token'
          )
          return Response.json({
            ok: true,
            controls: ['start', 'stop']
          })
        }
        throw new Error(`Unexpected fetch ${url}`)
      })
    )

    const prepared = await prepareRuntimeAddon('fbx2vrma')
    expect(prepared).toMatchObject({
      id: 'fbx2vrma',
      canStartAutomatically: true,
      operator: {
        configured: true,
        available: true,
        url: 'http://operator.test'
      }
    })
  })

  it('starts an add-on through the authenticated operator and re-checks status', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = 'http://operator.test/'
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = 'operator-token'

    let workerHealthCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://operator.test/health') {
        return Response.json({
          ok: true,
          controls: ['start', 'stop']
        })
      }
      if (url === 'http://operator.test/v1/addons/fbx2vrma/start') {
        expect(init?.method).toBe('POST')
        expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer operator-token')
        return Response.json({
          ok: true,
          output: 'started'
        })
      }
      if (url === 'http://fbx2vrma-worker.test/health') {
        workerHealthCalls += 1
        if (workerHealthCalls === 1) {
          throw new Error('worker offline before start')
        }
        return Response.json({
          ok: true,
          status: 'ready',
          mode: 'docker-worker',
          version: 'v0.9.7',
          fbx2gltfVersion: 'FBX2glTF version 0.9.7'
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await controlRuntimeAddon('fbx2vrma', 'start')
    expect(result).toMatchObject({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma',
      alreadySatisfied: false,
      output: 'started',
      after: {
        running: true
      }
    })
  })

  it('returns operator unavailable instead of running Docker from the app container', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('worker offline')
      })
    )

    const result = await controlRuntimeAddon('fbx2vrma', 'start')
    expect(result).toMatchObject({
      success: false,
      operation: 'start',
      addonId: 'fbx2vrma',
      operator: {
        configured: false,
        available: false
      },
      error: 'Runtime add-on operator is not configured.'
    })
  })

  it('treats already stopped add-ons as idempotent no-ops', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_FBX2VRMA_WORKER_URL = 'http://fbx2vrma-worker.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('worker offline')
      })
    )

    const result = await controlRuntimeAddon('fbx2vrma', 'stop')
    expect(result).toMatchObject({
      success: true,
      operation: 'stop',
      addonId: 'fbx2vrma',
      alreadySatisfied: true
    })
  })

  it('rejects malformed operator URLs as unavailable configuration', async () => {
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = 'file:///tmp/operator.sock'
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = 'operator-token'

    const status = await getRuntimeAddonOperatorStatus()
    expect(status).toMatchObject({
      configured: true,
      available: false,
      reason: 'BATSHIT_RUNTIME_ADDON_OPERATOR_URL must be an http(s) URL.'
    })
  })
})
