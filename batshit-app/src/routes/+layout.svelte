<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto, invalidate } from '$app/navigation';
  import { onMount } from 'svelte';
  import * as Sidebar from '$lib/components/ui/sidebar';
  import { Sidebar_batshit } from '$lib/components/batshit-sidebar';
  import { Toaster } from '$lib/components/ui/sonner';
  import ConfirmDialogHost from '$lib/components/ui/ConfirmDialogHost.svelte';
  import { installGlobalClientTelemetry } from '$lib/services/clientTelemetry';
  const { data, children } = $props();

  const isDesktopGoonPage = $derived(page.url.pathname === '/desktop-goon');
  const isDesktopControlsPage = $derived(page.url.pathname === '/desktop-controls');
  const isDesktopCompanionPage = $derived(isDesktopGoonPage || isDesktopControlsPage);

  function normalizeRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, any>) }
      : {};
  }

  function shouldWarmManagedClipTunnel(settings: any): boolean {
    const uiSettings = normalizeRecord(settings?.ui_settings);
    const nestedUpload = normalizeRecord(uiSettings.upload_settings);
    const legacyUpload = normalizeRecord(settings?.upload_settings);
    const uploadSettings =
      Object.keys(nestedUpload).length > 0 ? nestedUpload : legacyUpload;

    const tunnelProvider =
      typeof uploadSettings.tunnel_provider === 'string'
        ? uploadSettings.tunnel_provider.trim()
        : 'none';
    const autoStart = uploadSettings.cloudflared_auto_start === true;

    return tunnelProvider === 'cloudflared_managed' && autoStart;
  }

  async function warmManagedVoiceRuntimes() {
    try {
      await fetch('/api/voice/runtime/auto-start', {
        method: 'POST'
      });
    } catch (error) {
      console.warn('Failed to auto-start managed voice runtimes:', error);
    }
  }
  
  // No registry sync needed anymore - we fetch directly from Upstash when needed!
  onMount(async () => {
    if (isDesktopCompanionPage) return;
    enforceLaunchDarkTheme();

    if (data?.user) {
      installGlobalClientTelemetry();
      void warmManagedVoiceRuntimes();
    }

    if (data?.user && shouldWarmManagedClipTunnel(data?.userSettings)) {
      try {
        const response = await fetch('/api/native-tools/cloudflared/tunnel');
        const payload = await response.json().catch(() => null);
        window.dispatchEvent(
          new CustomEvent('batshit:managed-tunnel-status', {
            detail: {
              payload,
              ok: response.ok,
              error:
                response.ok
                  ? null
                  : (payload && (payload.error || payload.reason)) || 'Failed to warm managed tunnel',
            },
          })
        );
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent('batshit:managed-tunnel-status', {
            detail: {
              payload: null,
              ok: false,
              error: error instanceof Error ? error.message : 'Failed to warm managed tunnel',
            },
          })
        );
      }
    }
  });
  
  function enforceLaunchDarkTheme() {
    if (typeof document === 'undefined') return;

    document.documentElement.classList.add('dark');
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.colorScheme = 'dark';

    if (typeof window !== 'undefined') {
      window.localStorage?.setItem('theme', 'dark');
    }
  }

  enforceLaunchDarkTheme();

  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('batshit-desktop-goon-surface', isDesktopGoonPage);
    document.body.classList.toggle('batshit-desktop-goon-surface', isDesktopGoonPage);
    document.documentElement.classList.toggle('batshit-desktop-controls-surface', isDesktopControlsPage);
    document.body.classList.toggle('batshit-desktop-controls-surface', isDesktopControlsPage);
    return () => {
      document.documentElement.classList.remove('batshit-desktop-goon-surface');
      document.body.classList.remove('batshit-desktop-goon-surface');
      document.documentElement.classList.remove('batshit-desktop-controls-surface');
      document.body.classList.remove('batshit-desktop-controls-surface');
    };
  });
  
  // Check if we're on auth pages
  const isAuthPage = $derived(
    page.url.pathname === '/login' ||
    page.url.pathname === '/setup'
  )
</script>

{#if isDesktopCompanionPage}
  {@render children?.()}
{:else if isAuthPage}
  <!-- Auth pages (login/setup) -->
  {@render children?.()}
{:else}
  <!-- Main app layout -->
  <Sidebar.SidebarProvider>
    <div class="app-shell-root">
      <!-- Our custom Batshit sidebar -->
      <Sidebar_batshit {data} />
      
      <!-- Main content area with inset -->
      <Sidebar.SidebarInset class="app-main-inset">
        <header class="app-header-bar">
          <div class="app-header-spacer"></div>
        </header>
        
        <main class="app-content">
          {@render children?.()}
        </main>
      </Sidebar.SidebarInset>
    </div>
  </Sidebar.SidebarProvider>
{/if}

{#if !isDesktopCompanionPage}
  <Toaster position="top-right" />
  <ConfirmDialogHost />
{/if}
