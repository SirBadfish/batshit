import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArtifactPinokioAppFields from './ArtifactPinokioAppFields.svelte'

/**
 * SA-072 P2 (DL-09): the Pinokio App power source's two rows. They read the installed apps
 * (read-only), show the saved app even when Pinokio no longer lists it, and say plainly when
 * Pinokio is not running. The address is never a field.
 */

function installFetch(payload: Record<string, unknown>) {
  const urls: string[] = []
  // @ts-expect-error test override
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(typeof input === 'string' ? input : input.toString())
    return { ok: true, status: 200, json: async () => payload }
  })
  return { urls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ArtifactPinokioAppFields', () => {
  it('shows the kind and the saved app by its title, from the installed apps', async () => {
    const { urls } = installFetch({ available: true, apps: [{ appId: 'comfy.git', title: 'Comfyui', state: 'online' }], message: null })
    render(ArtifactPinokioAppFields, {
      props: { metadata: { source_type: 'comfyui', runtime_manager: 'pinokio', pinokio_app_id: 'comfy.git' }, onChange: () => {} }
    })
    expect(await screen.findByText('App Kind')).toBeTruthy()
    expect(screen.getByText('ComfyUI')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Comfyui')).toBeTruthy())
    expect(urls).toEqual(['/api/pinokio/apps'])
    expect(screen.queryByText(/localhost|127\.0\.0\.1|port/i)).toBeNull()
  })

  it('keeps showing a saved app Pinokio does not list, and says why the list is empty', async () => {
    installFetch({ available: false, apps: [], message: 'Pinokio is installed but not running. Open Pinokio, then try again.' })
    render(ArtifactPinokioAppFields, {
      props: { metadata: { source_type: 'gradio', runtime_manager: 'pinokio', pinokio_app_id: 'ocr.git' }, onChange: () => {} }
    })
    expect(await screen.findByText('Pinokio is installed but not running. Open Pinokio, then try again.')).toBeTruthy()
    expect(screen.getByText('ocr.git')).toBeTruthy()
    expect(screen.getByText('Gradio')).toBeTruthy()
  })
})
