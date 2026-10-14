<script lang="ts">
  import { onMount } from 'svelte'
  import { confirmDialog } from '$lib/stores/confirmDialog'

  /**
   * SA-072 P2 (DL-03, DL-10): the page half of "Start with Pinokio".
   *
   * A Pinokio app artifact runs in a sandboxed iframe with an opaque origin, so it cannot start
   * anything itself. When its app is offline, its Builder Kit asks THIS page with a
   * `batshit:pinokio:start-request` message. The page accepts it only from an artifact iframe
   * it rendered (`/artifact/<id>`, matched by `event.source`, the id in the message equal to the
   * iframe's), shows Batshit's own confirm dialog naming the app and every app the start also
   * starts, and only after the user's click calls the session-only start route. The iframe hears
   * back through `batshit:pinokio:start-result`. Nothing renders here; the dialog is the shared
   * ConfirmDialogHost.
   */

  const waiting = new Set<string>()

  function artifactIdOfFrame(source: MessageEventSource | null): string | null {
    if (!source) return null
    for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
      if (iframe.contentWindow !== source) continue
      try {
        const url = new URL(iframe.getAttribute('src') || '', window.location.href)
        if (url.origin !== window.location.origin) return null
        const match = /^\/artifact\/([^/?#]+)$/.exec(url.pathname)
        return match ? decodeURIComponent(match[1]) : null
      } catch {
        return null
      }
    }
    return null
  }

  async function readJson(response: Response): Promise<Record<string, any>> {
    return ((await response.json().catch(() => null)) as Record<string, any> | null) ?? {}
  }

  async function handleStartRequest(event: MessageEvent) {
    if (event.data?.type !== 'batshit:pinokio:start-request') return
    if (event.origin !== 'null') return
    const artifactId = artifactIdOfFrame(event.source)
    if (!artifactId || artifactId !== event.data?.artifactId) return

    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : ''
    const source = event.source as Window
    const reply = (payload: Record<string, unknown>) =>
      source.postMessage({ type: 'batshit:pinokio:start-result', artifactId, requestId, ...payload }, '*')

    if (waiting.has(artifactId)) {
      reply({ ok: false, message: 'A start for this artifact is already waiting for your answer.' })
      return
    }
    waiting.add(artifactId)
    try {
      const query = new URLSearchParams({ artifactId })
      const previewResponse = await fetch(`/api/pinokio/apps/start?${query.toString()}`)
      const preview = await readJson(previewResponse)
      if (!previewResponse.ok || !preview.success) {
        reply({ ok: false, message: preview.error || 'Batshit could not ask Pinokio about this app.' })
        return
      }
      if (preview.state === 'online' && preview.ready) {
        reply({ ok: true, alreadyRunning: true, message: `${preview.title} is already running.` })
        return
      }

      const alsoStarts: string[] = Array.isArray(preview.alsoStarts) ? preview.alsoStarts : []
      const confirmed = await confirmDialog({
        title: `Start ${preview.title} with Pinokio?`,
        description: [
          `The artifact "${preview.artifactName}" needs ${preview.title}, which is installed in Pinokio but not running.`,
          ...(alsoStarts.length > 0 ? [`Starting it also starts ${alsoStarts.join(', ')}.`] : []),
          'Batshit asks Pinokio to start it. Nothing is installed, stopped, or deleted.'
        ],
        confirmLabel: 'Start'
      })
      if (!confirmed) {
        reply({ ok: false, cancelled: true, message: `${preview.title} was not started.` })
        return
      }

      const startResponse = await fetch('/api/pinokio/apps/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId, alsoStarts })
      })
      const started = await readJson(startResponse)
      if (!startResponse.ok || !started.success) {
        reply({ ok: false, message: started.error || `${preview.title} did not start.` })
        return
      }
      reply({
        ok: started.ready === true || started.alreadyRunning === true,
        ready: started.ready === true,
        state: started.state ?? null,
        message: started.message ?? ''
      })
    } catch (error) {
      reply({ ok: false, message: error instanceof Error ? error.message : 'Batshit could not start the app.' })
    } finally {
      waiting.delete(artifactId)
    }
  }

  onMount(() => {
    const listener = (event: MessageEvent) => void handleStartRequest(event)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  })
</script>
