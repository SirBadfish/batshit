<script lang="ts">
  let {
    id,
    title = '',
    class: className = ''
  }: {
    id: string
    title?: string
    class?: string
  } = $props()
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="var(--batshit-icon-stroke-width, 1.4)"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
>
  {#if title}
    <title>{title}</title>
  {/if}

  <g class="batshit-icon-drawing" transform="translate(12 12) scale(1.2) translate(-12 -12)">
    {#if id === 'agents'}
      <circle cx="11" cy="7.5" r="3" />
      <path d="M5.5 19c.8-3.1 2.6-4.8 5.5-4.8s4.7 1.7 5.5 4.8" />
      <path d="M16.8 7.5h2.7" />
      <path d="M18.2 6.1v2.8" />
  {:else if id === 'subagents'}
    <circle cx="10.5" cy="8" r="2.7" />
    <path d="M5.8 18c.8-2.7 2.3-4.1 4.7-4.1s3.9 1.4 4.7 4.1" />
    <circle cx="17.4" cy="6.2" r="1.6" />
    <path d="M15.5 14.5c2.5-.8 4-2.7 4.1-5.2" />
  {:else if id === 'groups'}
    <circle cx="12" cy="7" r="2.7" />
    <path d="M7.2 19c.7-2.9 2.3-4.4 4.8-4.4s4.1 1.5 4.8 4.4" />
    <path d="M5.5 15.8c.4-1.4 1.3-2.4 2.6-3" />
    <path d="M18.5 15.8c-.4-1.4-1.3-2.4-2.6-3" />
    <circle cx="5.8" cy="9.3" r="1.7" />
    <circle cx="18.2" cy="9.3" r="1.7" />
  {:else if id === 'core-basic'}
    <rect x="7" y="7" width="10" height="10" rx="2.2" />
    <path d="M12 3v4" />
    <path d="M12 17v4" />
    <path d="M3 12h4" />
    <path d="M17 12h4" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  {:else if id === 'instructions'}
    <path d="M7 4h7l3 3v13H7z" />
    <path d="M14 4v4h4" />
    <path d="M9.5 11h5" />
    <path d="M9.5 15h4" />
    <path d="M9.5 18h2" />
  {:else if id === 'access'}
    <path d="M12 3.5 18 6v4.8c0 3.9-2.4 7.5-6 9.1-3.6-1.6-6-5.2-6-9.1V6z" />
    <path d="M9.5 12.5 11.2 14 15 10" />
  {:else if id === 'models'}
    <rect x="5" y="5" width="14" height="5" rx="2" />
    <rect x="5" y="14" width="14" height="5" rx="2" />
    <circle cx="9" cy="7.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="16.5" r="1" fill="currentColor" stroke="none" />
    <path d="M10 10v4" />
    <path d="M14 10v4" />
  {:else if id === 'model-catalog'}
    <rect x="4" y="4" width="7" height="7" rx="1.7" />
    <rect x="13" y="4" width="7" height="7" rx="1.7" />
    <rect x="4" y="13" width="7" height="7" rx="1.7" />
    <rect x="13" y="13" width="7" height="7" rx="1.7" />
    <path d="M6.6 7.5h1.8" />
    <path d="M15.6 7.5h1.8" />
    <path d="M6.6 16.5h1.8" />
    <path d="M15.6 16.5h1.8" />
  {:else if id === 'parameters'}
    <rect x="4" y="5" width="16" height="14" rx="3" />
    <path d="M8 9v6" />
    <path d="M12 8v8" />
    <path d="M16 10v4" />
    <circle cx="8" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="10.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="16" cy="13" r="1" fill="currentColor" stroke="none" />
  {:else if id === 'projects'}
    <path d="M4 7.5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <rect x="8" y="12.45" width="8" height="1.1" rx="0.55" fill="currentColor" stroke="none" />
    <rect x="8" y="15.45" width="4" height="1.1" rx="0.55" fill="currentColor" stroke="none" />
  {:else if id === 'rules'}
    <path d="M7 4h10v16H7z" />
    <path d="M10 8h4" />
    <path d="M10 12h4" />
    <path d="M10 16h2" />
    <path d="m15.5 15.2 1.2 1.2 2-2.4" />
  {:else if id === 'zip'}
    <rect x="9" y="3" width="6" height="7" rx="1" />
    <path d="M11 6v4a1 1 0 0 0 1 1h0a1 1 0 0 0 1-1V6" />
    <path d="M12 10l-2 2l4 2l-4 2l4 2l-4 2l2 2" />
  {:else if id === 'unzip'}
    <path d="M12 22l-2-2l4-2l-2-2" />
    <rect x="9" y="10" width="6" height="6" rx="1" />
    <rect x="11" y="12" width="2" height="4" rx="0.5" />
    <path d="M11 10C9 7 7 5 4 3" />
    <path d="M13 10c2-3 4-5 7-7" />
  {:else if id === 'cli-tools'}
    <rect x="4" y="5" width="16" height="14" rx="2.5" />
    <path d="m7.5 10 2 2-2 2" />
    <path d="M12 14h4.5" />
    <path d="M15.5 7.5h1.8" />
    <path d="M16.4 6.6v1.8" />
  {:else if id === 'artifacts'}
    <rect x="5" y="5" width="14" height="14" rx="3" />
    <path d="M8.5 9h7" />
    <path d="M8.5 12.5h3.5" />
    <circle cx="15.5" cy="15.5" r="1.2" />
    <path d="M19 12h2" />
    <path d="M3 12h2" />
  {:else if id === 'zones'}
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M4 9h16" />
    <path d="M15 9v10" />
    <path d="M7 12h5" />
    <path d="M7 15h3" />
  {:else if id === 'zone-none'}
    <rect x="4" y="5" width="16" height="14" rx="2" stroke-dasharray="2 2" />
    <path d="m6 18 12-12" />
  {:else if id === 'zone-headerbar'}
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M4 9h16" />
    <path d="M7 7h5" />
    <path d="M16 7h1" />
  {:else if id === 'zone-trigger-menu'}
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M15 9v10" />
    <circle cx="17.25" cy="11" r="0.5" fill="currentColor" stroke="none" />
    <circle cx="17.25" cy="14" r="0.5" fill="currentColor" stroke="none" />
    <circle cx="17.25" cy="17" r="0.5" fill="currentColor" stroke="none" />
  {:else if id === 'zone-top-panel'}
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M4 9h16" />
    <rect x="7" y="10.8" width="10" height="4" rx="1.2" />
  {:else if id === 'zone-side-panel'}
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M15 5v14" />
    <circle cx="17.45" cy="9" r="0.5" fill="currentColor" stroke="none" />
    <circle cx="17.45" cy="12" r="0.5" fill="currentColor" stroke="none" />
    <circle cx="17.45" cy="15" r="0.5" fill="currentColor" stroke="none" />
  {:else if id === 'skills'}
    <path d="M12 3.5 18 7v7l-6 6.5L6 14V7z" />
    <path d="M9.5 11.5 11.3 13 15 9.5" />
  {:else if id === 'artifact-creator-skill'}
    <path d="M12 3.5 18 7v7l-6 6.5L6 14V7z" />
    <rect x="9" y="9" width="6" height="6" rx="1.5" />
    <path d="M12 7.2v2" />
    <path d="M12 15v2" />
  {:else if id === 'cli-tool-creator-skill'}
    <path d="M12 3.5 18 7v7l-6 6.5L6 14V7z" />
    <path d="m9 10 1.6 1.6L9 13.2" />
    <path d="M12.6 13h2.4" />
  {:else if id === 'voice-engine-installer-skill'}
    <path d="M12 3.5 18 7v7l-6 6.5L6 14V7z" />
    <path d="M9.2 12h1.2" />
    <path d="M13.6 12h1.2" />
    <path d="M11 9v6" />
    <path d="M13 9v6" />
  {:else if id === 'skill-creator-skill'}
    <path d="M12 3.5 18 7v7l-6 6.5L6 14V7z" />
    <path d="M12 8.2v7.6" />
    <path d="M8.2 12h7.6" />
  {:else if id === 'prompts'}
    <path d="M5 6.5a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 6.5v6.2a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 5 12.7z" />
    <path d="m9 8.5 2 2-2 2" />
    <path d="M13 12.5h2" />
  {:else if id === 'fabric'}
    <path d="M5 7h14" />
    <path d="M5 12h14" />
    <path d="M5 17h14" />
    <path d="M7 5v14" />
    <path d="M12 5v14" />
    <path d="M17 5v14" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  {:else if id === 'goons'}
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <rect x="8" y="7" width="8" height="8" rx="2" />
    <line x1="12" y1="7" x2="12" y2="3" />
    <circle cx="12" cy="3" r="1" />
    <circle cx="6" cy="17" r="1" />
    <circle cx="18" cy="17" r="1" />
  {:else if id === 'closet'}
    <path d="M12 11V9.2c2.3-.7 3.5-2.1 3.5-3.8A3.3 3.3 0 0 0 12.2 2.4a3.3 3.3 0 0 0-3.3 3.3" />
    <path d="M12 11 4.8 17.8" />
    <path d="M12 11 19.2 17.8" />
    <path d="M5.2 17.8h13.6" />
  {:else if id === 'kitchen'}
    <path d="M5 11h14v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7Z" />
    <path d="M4 11h16" />
    <path d="M9 11V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4" />
    <path d="M18 11l2-5" />
    <path d="M6 3v2M5 4h2M19 4v2M18 5h2" />
  {:else if id === 'scenes'}
    <rect x="4" y="5" width="16" height="14" rx="2.5" />
    <path d="M7 15l3-3 2.2 2.2L15 11l3 4" />
    <circle cx="8.05" cy="8.5" r="0.5" fill="currentColor" stroke="none" />
  {:else if id === 'motions'}
    <circle cx="12.5" cy="4.8" r="1.6" />
    <path d="M11.2 7.2 10.5 12l2.8 2.6" />
    <path d="M10.9 8.4 7.8 5.4" />
    <path d="M12 8.8h3.4l2.1 3.2" />
    <path d="M13.3 14.6 10.2 20" />
    <path d="M13.3 14.6 16.7 18.2 15.6 21" />
  {:else if id === 'moods'}
    <circle cx="12" cy="12" r="7" />
    <circle cx="9.05" cy="10" r="0.52" fill="currentColor" stroke="none" />
    <circle cx="15.05" cy="10" r="0.52" fill="currentColor" stroke="none" />
    <path d="M9.5 14c1.6 1.2 3.4 1.2 5 0" />
    <path d="M5.6 8.5 3.8 7.4" />
    <path d="M18.4 8.5l1.8-1.1" />
  {:else if id === 'emotes'}
    <path d="M5 7A2.5 2.5 0 0 1 7.5 4.5h9A2.5 2.5 0 0 1 19 7v6.6a2.5 2.5 0 0 1-2.5 2.5h-3.4L9 20v-3.9H7.5A2.5 2.5 0 0 1 5 13.6z" />
    <circle cx="9.55" cy="9.8" r="0.52" fill="currentColor" stroke="none" />
    <circle cx="14.55" cy="9.8" r="0.52" fill="currentColor" stroke="none" />
    <path d="M10.2 12.6c1.2.8 2.4.8 3.6 0" />
  {:else if id === 'voice-studio'}
    <rect x="5" y="4" width="14" height="16" rx="3" />
    <path d="M9 12v3" />
    <path d="M12 9v6" />
    <path d="M15 11v4" />
    <circle cx="9" cy="7.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="7.5" r="1" fill="currentColor" stroke="none" />
  {:else if id === 'voice-engine-manager'}
    <rect x="5" y="7" width="14" height="10" rx="2.5" />
    <path d="M8 11v2" />
    <path d="M11 10v4" />
    <path d="M14 11v2" />
    <path d="M8 4v3" />
    <path d="M16 17v3" />
    <path d="M19 12h2" />
    <path d="M3 12h2" />
  {:else if id === 'icons'}
    <rect x="5" y="5" width="6.5" height="6.5" rx="1.7" />
    <rect x="12.5" y="12.5" width="6.5" height="6.5" rx="1.7" />
    <path d="M15.8 4.5 19 7.7l-3.2 3.2-3.2-3.2z" />
    <circle cx="8.2" cy="16" r="2.1" />
  {:else if id === 'tunnel'}
    <path d="M7 8a4 4 0 0 0 0 8" />
    <path d="M17 8a4 4 0 0 1 0 8" />
    <path d="M7 8h10" />
    <path d="M7 16h10" />
    <path d="M11 12h2" />
  {:else if id === 'local-ai'}
    <rect x="5" y="6" width="14" height="12" rx="2.5" />
    <path d="M9 10h6" />
    <path d="M9 14h3" />
    <path d="M7.5 18v2" />
    <path d="M16.5 18v2" />
    <path d="M12 4v2" />
  {:else}
    <path d="M12 3v4" />
    <path d="M12 17v4" />
    <path d="M3 12h4" />
    <path d="M17 12h4" />
    <path d="m7.8 7.8 2 2" />
    <path d="m14.2 14.2 2 2" />
    {/if}
  </g>
</svg>

<style>
  .batshit-icon-drawing :global(*) {
    vector-effect: non-scaling-stroke;
  }
</style>
