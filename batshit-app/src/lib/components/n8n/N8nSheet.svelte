<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import { Button } from '$lib/components/ui/button'
  import { Clipboard, ExternalLink, Send, ShieldAlert } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  
  let {
    open = $bindable(false),
    testMode = false,
    onSendMessage = (message: string) => {}
  } = $props<{
    open?: boolean
    testMode?: boolean
    onSendMessage?: (message: string) => void
  }>()
  
  // For embedded chat input
  let message = $state('')
  let textarea = $state<HTMLTextAreaElement | null>(null)
  let copied = $state(false)
  let mounted = $state(false)

  // Get current agent
  const currentAgent = $derived(agentStore.getCurrentAgent())
  
  // Get the iframe URL
  const iframeUrl = $derived(currentAgent?.agent_url || '')
  const shouldOpenExternally = $derived(mounted && shouldUseExternalN8nWindow(iframeUrl))

  onMount(() => {
    mounted = true
  })

  function parseUrl(value: string): URL | null {
    if (!value) return null
    try {
      return new URL(value, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
    } catch {
      return null
    }
  }

  function isEmbeddedAppleWebView() {
    if (typeof navigator === 'undefined') return false
    const userAgent = navigator.userAgent || ''
    return userAgent.includes('AppleWebKit') && !userAgent.includes('Safari/')
  }

  function isLocalHttpUrl(value: string) {
    const url = parseUrl(value)
    if (!url || url.protocol !== 'http:') return false
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  }

  function shouldUseExternalN8nWindow(value: string) {
    return isEmbeddedAppleWebView() && isLocalHttpUrl(value)
  }

  function openN8n() {
    if (!iframeUrl) return
    window.open(iframeUrl, '_blank', 'noopener,noreferrer')
  }

  async function copyN8nUrl() {
    if (!iframeUrl) return
    try {
      await copyTextToClipboard(iframeUrl)
      copied = true
      setTimeout(() => {
        copied = false
      }, 1500)
    } catch (error) {
      console.error('Failed to copy n8n URL:', error)
    }
  }
  
  function handleSend() {
    if (!message.trim()) return
    
    onSendMessage(message.trim())
    message = ''
    
    // Reset textarea height
    if (textarea) {
      textarea.style.height = 'auto'
    }
  }
  
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }
  
  // Auto-resize textarea
  function autoResize() {
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'
  }
  
  // Auto-click Execute Agent button when sheet opens in test mode
  $effect(() => {
    if (open && testMode && currentAgent?.agent_url) {
      // Small delay to ensure iframe is loaded
      setTimeout(() => {
        try {
          // Try to find and click the Execute Agent button in the iframe
          const iframe = document.querySelector('iframe[title="n8n Agent"]') as HTMLIFrameElement
          if (iframe && iframe.contentWindow) {
            // This might not work due to cross-origin restrictions
            // You may need to implement this differently based on your setup
          }
        } catch (e) {
        }
      }, 1000)
    }
  })
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="bottom" class="p-0 h-[90vh] gap-0" onInteractOutside={(e: Event) => e.preventDefault()}>
    <!-- Sheet Header -->
    <div class="border-b px-4 py-3 flex items-center justify-between gap-3 bg-background">
      <div class="w-28" aria-hidden="true"></div>
      <h3 class="text-lg font-semibold">
        {currentAgent?.displayName || 'Agent'}
        {testMode ? '(Test Mode)' : ''}
      </h3>
      <div class="flex w-28 justify-end gap-2">
        {#if currentAgent?.agent_url}
          <Button type="button" variant="ghost" size="icon" onclick={copyN8nUrl} title={copied ? 'Copied' : 'Copy n8n URL'}>
            <Clipboard class="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onclick={openN8n} title="Open n8n in browser">
            <ExternalLink class="h-4 w-4" />
          </Button>
        {/if}
      </div>
    </div>

    <!-- Iframe Container - explicit height calc since flex inheritance breaks with nested divs -->
    <!-- 53px = header, 97px = test mode chat bar (when enabled) -->
    <div class="relative bg-muted/10">
      {#if currentAgent?.agent_url}
        {#if shouldOpenExternally}
          <div
            class="flex items-center justify-center px-6"
            style="{testMode ? 'height: calc(90vh - 150px)' : 'height: calc(90vh - 53px)'};"
          >
            <div class="max-w-xl rounded-lg border border-border bg-background p-6 text-center shadow-sm">
              <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <ShieldAlert class="h-6 w-6" />
              </div>
              <h4 class="text-base font-semibold text-foreground">Open n8n in your browser</h4>
              <p class="mt-2 text-sm leading-6 text-muted-foreground">
                Local n8n can reject secure cookies inside the Mac app WebView. Batshit will still send messages to the webhook, and n8n can be opened in your normal browser for test-mode workflow runs.
              </p>
              <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Button type="button" onclick={openN8n}>
                  <ExternalLink class="mr-2 h-4 w-4" />
                  Open n8n
                </Button>
                <Button type="button" variant="outline" onclick={copyN8nUrl}>
                  <Clipboard class="mr-2 h-4 w-4" />
                  {copied ? 'Copied' : 'Copy URL'}
                </Button>
              </div>
            </div>
          </div>
        {:else}
          <iframe
            src={iframeUrl}
            class="w-full border-0"
            title="n8n Agent"
            style="{testMode ? 'height: calc(90vh - 150px)' : 'height: calc(90vh - 53px)'};"
          ></iframe>
        {/if}
      {:else}
        <div class="flex items-center justify-center h-full text-muted-foreground">
          No agent URL configured
        </div>
      {/if}
    </div>

    <!-- Embedded ChatBar when in test mode -->
    {#if testMode}
      <div class="border-t px-4 pt-4 pb-6 bg-background">
        <div class="max-w-4xl mx-auto">
          <!-- Simplified ChatInput without toggle -->
          <div class="relative">
            <div class="relative border rounded-lg bg-background">
              <div class="flex items-end gap-2 p-2">
                <div class="flex-1">
                  <textarea
                    bind:value={message}
                    onkeydown={handleKeydown}
                    oninput={autoResize}
                    bind:this={textarea}
                    placeholder="Type a message..."
                    class="w-full bg-transparent resize-none border-0 outline-none focus:ring-0 px-3 py-2 text-base md:text-sm min-h-[40px] max-h-[200px]"
                  ></textarea>
                </div>
                <Button
                  onclick={handleSend}
                  disabled={!message.trim()}
                  size="icon"
                  class="h-10 w-10 shrink-0"
                >
                  <Send class="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
