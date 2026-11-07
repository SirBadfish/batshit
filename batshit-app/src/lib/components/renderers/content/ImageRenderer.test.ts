import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from '$app/state'
import { toast } from 'svelte-sonner'

import ImageRenderer from './ImageRenderer.svelte'
import { IMAGE_MESSAGE_ID_CONTEXT, resetImageLoadConsentForTests } from '$lib/stores/imageLoadConsent.svelte'

// BL-474 step 1: a picture from outside Batshit gets no address, and so makes no request, until
// the user clicks Load. Batshit's own pictures draw at once, as before.
const OUTSIDE = 'https://pictures.example.org/cat.png'
const SERVER_UPLOAD = 'http://localhost:5600/uploads/images/owned.png'

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetImageLoadConsentForTests()
  fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const images = (container: HTMLElement) => Array.from(container.querySelectorAll('img'))
const outsideRequests = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('example.org'))

describe('ImageRenderer outside pictures (BL-474 step 1)', () => {
  for (const state of ['pending', 'blocked'] as const) {
    it(`refuses ${state} pictures even when this address already has click consent`, async () => {
      const view = render(ImageRenderer, { props: { src: OUTSIDE, messageId: 'm1', origin: { state: 'as_read', line: null } } })
      await fireEvent.click(screen.getByRole('button', { name: 'Load picture' }))
      expect(images(view.container)).toHaveLength(1)
      await view.rerender({ src: OUTSIDE, messageId: 'm1', origin: { state, line: 'Origin check' } })
      expect(images(view.container)).toHaveLength(0)
      expect(screen.queryByRole('button', { name: 'Load picture' })).toBeNull()
      expect(screen.getByText('Origin check')).toBeTruthy()
      expect(outsideRequests()).toHaveLength(0)
    })
  }

  it('shows the unknown warning with a small Load action', async () => {
    const view = render(ImageRenderer, { props: { src: OUTSIDE, messageId: 'm1', origin: { state: 'unknown', line: 'Batshit cannot tell where this address came from.' } } })
    expect(screen.getByText('Batshit cannot tell where this address came from.')).toBeTruthy()
    expect(images(view.container)).toHaveLength(0)
    await fireEvent.click(screen.getByRole('button', { name: 'Load picture' }))
    expect(images(view.container)[0]?.getAttribute('src')).toBe(OUTSIDE)
  })

  it('revokes an open preview and download when a matching address becomes blocked', async () => {
    const view=render(ImageRenderer,{props:{src:OUTSIDE,messageId:'preview',origin:{state:'as_read',line:null}}})
    await fireEvent.click(screen.getByRole('button',{name:'Load picture'}))
    await fireEvent.load(images(view.container)[0])
    await fireEvent.click(screen.getByRole('button',{name:'Quick view image'}))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.querySelectorAll(`img[src="${OUTSIDE}"]`)).toHaveLength(2)
    await view.rerender({src:OUTSIDE,messageId:'preview',origin:{state:'blocked',line:'Origin changed'}})
    expect(document.querySelectorAll(`img[src="${OUTSIDE}"]`)).toHaveLength(0)
    expect(screen.queryByRole('button',{name:'Download full-resolution image'})).toBeNull()
    expect(outsideRequests()).toHaveLength(0)
  })

  it('draws an outside picture as a box with no address until Load is clicked, then loads it with no referrer', async () => {
    const { container } = render(ImageRenderer, { props: { src: OUTSIDE, alt: 'Cat', messageId: 'm1' } })

    expect(images(container)).toHaveLength(0)
    expect(container.innerHTML).not.toContain(OUTSIDE.replace('https://', 'src="https://'))
    expect(screen.getByText('Picture from pictures.example.org')).toBeTruthy()
    expect(screen.queryByText(/carries extra data/)).toBeNull()
    expect(outsideRequests()).toHaveLength(0)

    await fireEvent.click(screen.getByRole('button', { name: 'Load picture' }))

    const [image] = images(container)
    expect(image?.getAttribute('src')).toBe(OUTSIDE)
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(outsideRequests()).toHaveLength(0)
  })

  it('shows the full address on request and warns when the address carries extra data', async () => {
    const withData = 'https://pictures.example.org/cat.png?chat=hello'
    const { container } = render(ImageRenderer, { props: { src: withData, messageId: 'm1' } })

    expect(screen.getByText('This address carries extra data. Loading it sends that data to the website.')).toBeTruthy()
    const details = container.querySelector('details')
    expect(details?.querySelector('summary')?.textContent?.trim()).toBe('Show address')
    expect(details?.textContent).toContain(withData)
    expect(images(container)).toHaveLength(0)
  })

  it('needs a new click for a changed address, and a permission is for one message only', async () => {
    const first = render(ImageRenderer, { props: { src: OUTSIDE, messageId: 'm1' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Load picture' }))
    expect(images(first.container)).toHaveLength(1)

    await first.rerender({ src: 'https://pictures.example.org/dog.png', messageId: 'm1' })
    expect(images(first.container)).toHaveLength(0)
    first.unmount()

    const other = render(ImageRenderer, { props: { src: OUTSIDE, messageId: 'm2' } })
    expect(images(other.container)).toHaveLength(0)
    other.unmount()

    const again = render(ImageRenderer, { props: { src: OUTSIDE, messageId: 'm1' } })
    expect(images(again.container)).toHaveLength(1)
  })

  it('draws Batshit uploads, raster data, and Clip pictures at once, as before', () => {
    for (const props of [
      { src: SERVER_UPLOAD },
      { src: 'data:image/png;base64,iVBORw0KGgo=' },
      { src: 'https://tunnel.example.net/clip.png', trustedClip: true }
    ]) {
      const { container, unmount } = render(ImageRenderer, { props: { ...props, messageId: 'm1' } })
      const [image] = images(container)
      expect(image?.getAttribute('src')).toBe(props.src)
      expect(image?.hasAttribute('referrerpolicy')).toBe(false)
      expect(screen.queryByRole('button', { name: 'Load picture' })).toBeNull()
      unmount()
    }
  })

  it('never draws an SVG data address or an unregistered blob address', () => {
    for (const src of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'blob:http://localhost/abc']) {
      const { container, unmount } = render(ImageRenderer, { props: { src, messageId: 'm1' } })
      expect(images(container)).toHaveLength(0)
      expect(screen.queryByRole('button', { name: 'Load picture' })).toBeNull()
      unmount()
    }
  })

  it('treats /uploads/ on another website as outside', () => {
    const { container } = render(ImageRenderer, {
      props: { src: 'https://pictures.example.org/uploads/images/a.png', messageId: 'm1' }
    })
    expect(images(container)).toHaveLength(0)
    expect(screen.getByText('Picture from pictures.example.org')).toBeTruthy()
  })

  it('keys a picture inside a tool card to the message it is drawn in (context), not to no message', async () => {
    const inMessage = (id: string) => ({ props: { src: OUTSIDE }, context: new Map([[IMAGE_MESSAGE_ID_CONTEXT, () => id]]) })
    const first = render(ImageRenderer, inMessage('m1'))
    await fireEvent.click(screen.getByRole('button', { name: 'Load picture' }))
    expect(images(first.container)).toHaveLength(1)
    first.unmount()

    const other = render(ImageRenderer, inMessage('m2'))
    expect(images(other.container)).toHaveLength(0)
    other.unmount()

    const noMessage = render(ImageRenderer, { props: { src: OUTSIDE } })
    expect(images(noMessage.container)).toHaveLength(0)
  })
})

// BL-797: Save to Clip Vault must use the Clip compression settings saved NOW. The page's
// load-time snapshot (`page.data.userSettings`) never changes until a reload.
describe('ImageRenderer Save to Clip Vault compression settings (BL-797)', () => {
  const DATA_IMAGE = 'data:image/png;base64,iVBORw0KGgo='
  const staleSnapshot = { ui_settings: { compress_images: true, compression_quality: 40, max_image_size: '1024', force_jpeg: true } }
  const savedNow = { compress_images: false, compression_quality: 75, max_image_size: '2048', force_jpeg: false }
  const pageData = page.data as Record<string, unknown>
  let savedPageData: unknown

  beforeEach(() => {
    savedPageData = pageData.userSettings
    pageData.userSettings = staleSnapshot
  })

  afterEach(() => {
    if (savedPageData === undefined) delete pageData.userSettings
    else pageData.userSettings = savedPageData
    vi.restoreAllMocks()
  })

  const route = (settings: () => Response) => {
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url)
      if (target === DATA_IMAGE) return new Response(new Blob(['x'], { type: 'image/png' }))
      if (target.startsWith('/api/user/settings')) return settings()
      if (target === '/api/uploads/clips') {
        return new Response(JSON.stringify({ files: [{ originalName: 'x.png', clipData: { id: 'clip-1' } }] }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
  }
  const uploads = () => fetchSpy.mock.calls.filter(([url]) => String(url) === '/api/uploads/clips')
  const clickSave = async (container: HTMLElement) => {
    await fireEvent.load(images(container)[0])
    await fireEvent.click(screen.getByRole('button', { name: 'Upload to Clip Vault' }))
  }

  it('sends the compression settings read at click time, not the page-load snapshot', async () => {
    route(() => new Response(JSON.stringify({ settings: { ui_settings: savedNow } }), { status: 200 }))
    const { container } = render(ImageRenderer, { props: { src: DATA_IMAGE, messageId: 'm1' } })
    await clickSave(container)
    await vi.waitFor(() => expect(uploads()).toHaveLength(1))
    const body = uploads()[0][1].body as FormData
    expect(JSON.parse(String(body.get('compressionSettings')))).toEqual(savedNow)
  })

  it('applies a change saved after the picture was drawn to the very next save', async () => {
    let current: Record<string, unknown> = { compress_images: true, compression_quality: 40, max_image_size: '1024', force_jpeg: true }
    route(() => new Response(JSON.stringify({ settings: { ui_settings: current } }), { status: 200 }))
    const { container } = render(ImageRenderer, { props: { src: DATA_IMAGE, messageId: 'm1' } })
    current = savedNow
    await clickSave(container)
    await vi.waitFor(() => expect(uploads()).toHaveLength(1))
    expect(JSON.parse(String((uploads()[0][1].body as FormData).get('compressionSettings')))).toEqual(savedNow)
  })

  it('uses the defaults when the saved settings have no Clip section yet', async () => {
    route(() => new Response(JSON.stringify({ settings: { user_id: 'josh' } }), { status: 200 }))
    const { container } = render(ImageRenderer, { props: { src: DATA_IMAGE, messageId: 'm1' } })
    await clickSave(container)
    await vi.waitFor(() => expect(uploads()).toHaveLength(1))
    expect(JSON.parse(String((uploads()[0][1].body as FormData).get('compressionSettings')))).toEqual({
      compress_images: true,
      compression_quality: 40,
      max_image_size: '1024',
      force_jpeg: true
    })
  })

  it('fails visibly and uploads nothing when the saved settings cannot be read', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'error-toast')
    route(() => new Response('{}', { status: 503 }))
    const { container } = render(ImageRenderer, { props: { src: DATA_IMAGE, messageId: 'm1' } })
    await clickSave(container)
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
    expect(String(error.mock.calls[0][0])).toContain('Clip upload settings are unavailable (503)')
    expect(uploads()).toHaveLength(0)
  })
})
