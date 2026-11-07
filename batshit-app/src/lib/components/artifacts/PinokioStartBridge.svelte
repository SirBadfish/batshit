<script lang="ts">
  import { onMount } from 'svelte'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { isPinokioRemoteMachineId } from '$lib/pinokio/machines'

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

  const waiting = new Map<string, AbortController>()
  let disposed = true

  function artifactFrame(source: MessageEventSource | null): { iframe: HTMLIFrameElement; src: string; artifactId: string } | null {
    if (!source) return null
    for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
      if (iframe.contentWindow !== source) continue
      try {
        const url = new URL(iframe.getAttribute('src') || '', window.location.href)
        if (url.origin !== window.location.origin) return null
        const match = /^\/artifact\/([^/?#]+)$/.exec(url.pathname)
        return match ? { iframe, src: url.href, artifactId: decodeURIComponent(match[1]) } : null
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
    const frame = artifactFrame(event.source)
    if (disposed || !frame || frame.artifactId !== event.data?.artifactId) return
    const { artifactId } = frame

    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : ''
    const source = event.source as Window
    const current = () => {
      const rendered = artifactFrame(source)
      return !disposed && frame.iframe.isConnected && rendered?.iframe === frame.iframe && rendered.src === frame.src
    }
    const reply = (payload: Record<string, unknown>) => {
      if (current()) source.postMessage({ type: 'batshit:pinokio:start-result', artifactId, requestId, ...payload }, '*')
    }

    if (waiting.has(artifactId)) {
      reply({ ok: false, launchState: 'pending', message: 'A start for this artifact is already waiting for your answer.' })
      return
    }
    const controller = new AbortController()
    waiting.set(artifactId, controller)
    // A same-window iframe navigation can retain contentWindow. Pin the full rendered src too.
    const observer = new MutationObserver(() => { if (!current()) controller.abort() })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    let issued = false
    try {
      const query = new URLSearchParams({ artifactId })
      const previewResponse = await fetch(`/api/pinokio/apps/start?${query.toString()}`, { signal: controller.signal })
      const preview = await readJson(previewResponse)
      if (!current() || controller.signal.aborted) return
      if (!previewResponse.ok || !preview.success) {
        reply({ ok: false, startEffect: 'not_sent', message: preview.error || 'Batshit could not ask Pinokio about this app.' })
        return
      }
      const remote = preview.machineId !== 'local'
      if ((!isPinokioRemoteMachineId(preview.machineId) && preview.machineId !== 'local') ||
        !Number.isSafeInteger(preview.machineRevision) || (remote ? preview.machineRevision <= 0 : preview.machineRevision !== 0) ||
        typeof preview.machineLabel !== 'string' || !preview.machineLabel.trim() ||
        typeof preview.launchFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(preview.launchFingerprint) ||
        typeof preview.bindingFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(preview.bindingFingerprint) ||
        !Array.isArray(preview.alsoStarts) || !preview.alsoStarts.every((app: unknown) => typeof app === 'string')) {
        reply({ ok: false, startEffect: 'not_sent', message: 'Batshit could not confirm this app’s saved start preview. Refresh the artifact and confirm its Pinokio start again.' })
        return
      }
      if (preview.state === 'online' && (remote ? preview.endpointReady === true : preview.ready === true)) {
        reply({ ok: true, ready: true, endpointReady: preview.endpointReady === true, machineId: preview.machineId, alreadyRunning: true, message: `${preview.title} is already running.` })
        return
      }

      const alsoStarts: string[] = [...preview.alsoStarts]
      const machine = remote ? ` on ${preview.machineLabel}` : ' on This computer'
      const confirmed = await confirmDialog({
        title: `Start ${preview.title}${machine} with Pinokio?`,
        description: [
          `The artifact "${preview.artifactName}" needs ${preview.title}${machine}.`,
          ...(alsoStarts.length > 0 ? [`Starting it also starts ${alsoStarts.join(', ')}.`] : []),
          'Batshit asks Pinokio to start it. Nothing is installed, stopped, or deleted.'
        ],
        confirmLabel: 'Start'
      })
      if (!current() || controller.signal.aborted) return
      if (!confirmed) {
        reply({ ok: false, cancelled: true, startEffect: 'not_sent', message: `${preview.title} was not started.` })
        return
      }

      const body = {
        artifactId, alsoStarts,
        machineId: preview.machineId, revision: preview.machineRevision,
        launchFingerprint: preview.launchFingerprint, bindingFingerprint: preview.bindingFingerprint
      }
      issued = true
      const startResponse = await fetch('/api/pinokio/apps/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const started = await readJson(startResponse)
      if (!current() || controller.signal.aborted) return
      const issuedOutcome = started.nativeControlOutcome === 'blocked' || started.nativeControlOutcome === 'cancelled' ||
        started.observationEnded === 'cancelled' || started.observationEnded === 'timeout' ||
        started.launchState === 'pending' || started.launchState === 'unknown' || started.state === 'starting'
      // Only this explicit route-owned fact proves a POST never entered the start service.
      // A status code or generic provider failure after entry cannot make that assertion.
      const notSent = started.startEffect === 'not_sent' && !issuedOutcome
      const outcomes = {
        machineId: preview.machineId,
        ...(notSent ? { startEffect: 'not_sent' } : {}),
        launchState: started.launchState,
        nativeControlOutcome: started.nativeControlOutcome,
        observationEnded: started.observationEnded,
        endpointReady: started.endpointReady === true
      }
      const outcomeMessage = started.message || (
        started.nativeControlOutcome === 'blocked' ? 'Pinokio blocked the start.'
          : started.nativeControlOutcome === 'cancelled' ? 'Pinokio cancelled its start control.'
          : started.observationEnded === 'cancelled' ? 'Batshit stopped observing the start. The app may still be running in Pinokio.'
          : started.observationEnded === 'timeout' ? 'Batshit stopped waiting for the start. The app may still be running in Pinokio.'
          : started.launchState === 'unknown' ? 'Batshit could not confirm the start outcome. Check the app before trying its recipe again.'
          : started.launchState === 'pending' ? 'Pinokio is still handling the start. Try the recipe again to check the app.'
          : remote && started.endpointReady !== true ? 'Batshit cannot reach the app’s API yet. Try the recipe again to check it.'
          : started.ready || started.alreadyRunning ? `${preview.title} is ready.` : `${preview.title} is not ready yet.`
      )
      if (!startResponse.ok || !started.success) {
        const unconfirmed = !notSent && !issuedOutcome
        reply({ ...outcomes, ok: false, ...(unconfirmed ? { startEffect: 'unknown', launchState: 'unknown' } : {}),
          message: `${started.error || outcomeMessage}${unconfirmed ? ' The start outcome is unconfirmed. Check the app before trying its recipe again.' : ''}` })
        return
      }
      if (remote && (started.machineId !== preview.machineId || started.machineRevision !== preview.machineRevision)) {
        reply({ ok: false, machineId: preview.machineId, launchState: 'unknown', message: 'Batshit could not confirm the saved computer for this start result. Check the app before trying its recipe again.' })
        return
      }
      const terminal = started.nativeControlOutcome === 'blocked' || started.nativeControlOutcome === 'cancelled' ||
        started.observationEnded === 'cancelled' || started.observationEnded === 'timeout' ||
        started.launchState === 'pending' || started.launchState === 'unknown'
      reply({
        ...outcomes,
        ok: !terminal && (remote ? started.endpointReady === true : started.ready === true || started.alreadyRunning === true),
        ready: started.ready === true,
        state: started.state ?? null,
        message: outcomeMessage
      })
    } catch (error) {
      reply({ ok: false, startEffect: issued ? 'unknown' : 'not_sent', ...(issued ? { launchState: 'unknown' } : {}), message: issued
        ? 'Batshit could not confirm the start outcome. Check the app before trying its recipe again.'
        : error instanceof Error ? error.message : 'Batshit could not start the app.' })
    } finally {
      observer.disconnect()
      waiting.delete(artifactId)
    }
  }

  onMount(() => {
    disposed = false
    const listener = (event: MessageEvent) => void handleStartRequest(event)
    window.addEventListener('message', listener)
    return () => {
      disposed = true
      window.removeEventListener('message', listener)
      for (const controller of waiting.values()) controller.abort()
      waiting.clear()
    }
  })
</script>
