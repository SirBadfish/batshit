<script>
  import { onMount } from "svelte";
  import bootIcon from "./assets/batshit-icon-dark-ios.png";

  const commands = {
    status: "batshit.runtime.status",
    doctor: "batshit.runtime.doctor",
    start: "batshit.runtime.start",
    stop: "batshit.runtime.stop",
    restart: "batshit.runtime.restart",
    appleContainerStart: "batshit.runtime.appleContainerStart"
  };

  let bridgeReady = $state(false);
  let loading = $state(true);
  let busy = $state(null);
  let booting = $state(true);
  let report = $state(null);
  let error = $state("");

  const appUrl = $derived(report?.appUrl || "http://127.0.0.1:5620");
  const services = $derived.by(() => {
    const source = report?.services || {};
    return [
      source.redis,
      source.batshitServer,
      source.mcpProxy,
      source.batshitApp,
      source.dockerMcpGateway
    ].filter(Boolean);
  });
  const requiredServices = $derived.by(() => services.filter((item) => !item.optional));
  const tools = $derived.by(() => {
    const source = report?.tools || {};
    return [
      { key: "node", label: "Node.js", ...source.node },
      { key: "npm", label: "npm", ...source.npm },
      { key: "redisCli", label: "Redis CLI", ...source.redisCli },
      { key: "ffmpeg", label: "FFmpeg", ...source.ffmpeg },
      { key: "appleContainer", label: "Apple Container", ...source.appleContainer },
      { key: "docker", label: "Docker Desktop", ...source.docker },
      { key: "dockerMcpToolkit", label: "Docker MCP Toolkit", ...source.dockerMcpToolkit }
    ].filter((item) => !item.skipped && (item.available !== undefined || item.healthy !== undefined));
  });
  const actions = $derived(report?.actions || []);

  function unwrapBridgeResponse(value) {
    if (value?.result && typeof value.result === "object") return value.result;
    return value;
  }

  async function invoke(action) {
    if (!window.zero?.invoke) {
      bridgeReady = false;
      error = "The native bridge is not available in this window.";
      return null;
    }
    bridgeReady = true;
    const value = await window.zero.invoke(commands[action], {});
    return unwrapBridgeResponse(value);
  }

  function applyRuntimeResult(next, fallbackError) {
    if (!next) return null;
    const current = next.status || next;
    if (next.success === false || (current?.ok === false && current?.error)) {
      error = next.error || current.error || fallbackError;
    }
    report = current;
    return current;
  }

  async function refresh(action = "doctor") {
    loading = true;
    error = "";
    try {
      const next = await invoke(action);
      applyRuntimeResult(next, "Runtime status failed.");
    } catch (err) {
      error = err?.message || "Runtime status failed.";
    } finally {
      loading = false;
    }
  }

  async function run(action) {
    busy = action;
    error = "";
    try {
      const next = await invoke(action);
      applyRuntimeResult(next, `Runtime ${action} failed.`);
    } catch (err) {
      error = err?.message || `Runtime ${action} failed.`;
    } finally {
      busy = null;
      loading = false;
    }
  }

  async function boot() {
    if (!window.zero?.invoke) {
      bridgeReady = false;
      loading = false;
      booting = false;
      error = "The native bridge is not available in this window.";
      return;
    }

    bridgeReady = true;
    busy = "start";
    loading = true;
    error = "";
    let redirecting = false;
    try {
      const next = await invoke("start");
      const current = applyRuntimeResult(next, "Runtime start failed.");
      if (current?.ok) {
        redirecting = true;
        window.location.replace(current.appUrl || appUrl);
        return;
      }
    } catch (err) {
      error = err?.message || "Runtime start failed.";
    } finally {
      busy = null;
      if (!redirecting) {
        loading = false;
        booting = false;
      }
    }
  }

  function openBatshit() {
    window.location.href = appUrl;
  }

  function stateLabel(item) {
    if (item.healthy === true || (item.healthy === undefined && item.available)) return "Ready";
    if (item.optional) return "Optional";
    if (item.supported && item.healthy === false) return "Needs setup";
    if ((item.available || item.reachable) && item.healthy === false) return "Needs attention";
    return "Offline";
  }

  function stateClass(item) {
    if (item.healthy === true || (item.healthy === undefined && item.available)) return "ready";
    if (item.optional) return "warn";
    if (item.supported && item.healthy === false) return "warn";
    if ((item.available || item.reachable) && item.healthy === false) return "warn";
    return "offline";
  }

  onMount(() => {
    bridgeReady = Boolean(window.zero?.invoke);
    boot();
  });
</script>

{#if booting && !error}
  <main class="boot-shell" aria-live="polite">
    <div class="boot-mark">
      <img src={bootIcon} alt="" />
    </div>
    <h1>Batshit</h1>
    <p>Starting local runtime...</p>
    <div class="boot-meter" aria-hidden="true"></div>
  </main>
{:else}
  <main class="shell">
    <section class="mast">
      <div>
        <p class="eyebrow">Batshit Mac</p>
        <h1>Runtime Doctor</h1>
      </div>
      <div class:ready={report?.ok} class="runtime-mark">
        <span></span>
        {report?.ok ? "Ready" : "Needs Check"}
      </div>
    </section>

    {#if error}
      <section class="notice error" aria-live="polite">{error}</section>
    {/if}

    {#if !bridgeReady && !loading}
      <section class="notice">Native bridge unavailable. Launch this screen from Batshit.app.</section>
    {/if}

    <section class="control-band" aria-label="Runtime controls">
      <button disabled={busy !== null} onclick={() => run("start")}>
        {busy === "start" ? "Starting" : "Start Runtime"}
      </button>
      <button disabled={busy !== null} onclick={() => run("restart")}>
        {busy === "restart" ? "Restarting" : "Restart"}
      </button>
      <button class="quiet" disabled={busy !== null} onclick={() => run("stop")}>
        {busy === "stop" ? "Stopping" : "Stop"}
      </button>
      <button class="quiet" disabled={busy !== null || loading} onclick={() => refresh()}>
        {loading ? "Checking" : "Refresh"}
      </button>
      <button class="primary" disabled={!report?.ok} onclick={openBatshit}>Open Batshit</button>
    </section>

    <section class="status-layout">
      <div class="service-panel">
        <div class="section-head">
          <h2>Services</h2>
          <span>{requiredServices.filter((item) => item.healthy).length}/{requiredServices.length} ready</span>
        </div>
        <div class="rows">
          {#if services.length === 0}
            <div class="skeleton-row"></div>
            <div class="skeleton-row short"></div>
          {:else}
            {#each services as item}
              <article class="status-row">
                <div>
                  <h3>{item.label}</h3>
                  <p>{item.error || item.healthUrl || item.dataDir}</p>
                </div>
                <span class={`pill ${stateClass(item)}`}>{stateLabel(item)}</span>
              </article>
            {/each}
          {/if}
        </div>
      </div>

      <aside class="doctor-panel">
        <div class="section-head">
          <h2>Doctor</h2>
          <span>{actions.length} notes</span>
        </div>
        <div class="doctor-list">
          {#if loading}
            <div class="skeleton-row"></div>
            <div class="skeleton-row"></div>
          {:else if actions.length === 0}
            <p class="empty">Core runtime checks are clean.</p>
          {:else}
            {#each actions as action}
              <article class={`doctor-note ${action.severity}`}>
                <div class="note-head">
                  <h3>{action.title}</h3>
                  {#if action.repairCommand}
                    <button
                      class="mini"
                      disabled={busy !== null}
                      onclick={() => run(action.repairCommand)}
                    >
                      {busy === action.repairCommand ? "Starting" : action.repairLabel}
                    </button>
                  {/if}
                  {#if action.externalUrl}
                    <a
                      class="mini"
                      href={action.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {action.externalLabel || "Open"}
                    </a>
                  {/if}
                </div>
                <p>{action.detail}</p>
              </article>
            {/each}
          {/if}
        </div>
      </aside>
    </section>

    <section class="tool-strip" aria-label="Required runtime checks">
      {#each tools as tool}
        <div class="tool-item">
          <span class={`dot ${stateClass(tool)}`}></span>
          <span>{tool.label}</span>
        </div>
      {/each}
    </section>

    <footer>
      <span>{report?.paths?.data || "~/Library/Application Support/Batshit"}</span>
      <span>{report?.paths?.logs || "~/Library/Logs/Batshit"}</span>
    </footer>
  </main>
{/if}
