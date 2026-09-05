<script lang="ts">
	/**
	 * SA-111 P4 (DL-111-11) — the Workers tool card.
	 *
	 * One `spawn_workers` call is ONE tool result carrying up to three runs, so this card
	 * is a list, not a conversation. Structure and tokens are copied from its neighbour
	 * `../subagent/CallSubagentRenderer.svelte`; a worker row is quieter than a subagent
	 * exchange because the useful part is the output, not who said it.
	 */
	import UsersRound from '@lucide/svelte/icons/users-round'
	import FullTool from '../templates/FullTool.svelte'
	import { numericKeyObjectToArray } from '$lib/utils/toolPayloadUnwrap'

	let { tool } = $props()

	let collapsed = $state(true)

	type WorkerRow = {
		index: number
		name: string
		role: string | null
		base: string | null
		status: 'completed' | 'failed' | 'timed_out'
		output: string
		durationMs: number
		totalTokens: number | null
	}

	function toPlain(value: any) {
		try {
			return typeof structuredClone === 'function'
				? structuredClone(value)
				: JSON.parse(JSON.stringify(value))
		} catch {
			return value
		}
	}

	const result = $derived.by(() => {
		const raw = tool?.toolResult ?? {}
		if (typeof raw === 'string') {
			try {
				return JSON.parse(raw)
			} catch {
				return { message: raw }
			}
		}
		return toPlain(raw) || {}
	})

	function readNumber(value: unknown): number | null {
		const parsed = typeof value === 'number' ? value : Number(value)
		return Number.isFinite(parsed) ? parsed : null
	}

	function readStatus(value: unknown): WorkerRow['status'] {
		return value === 'completed' || value === 'failed' || value === 'timed_out' ? value : 'failed'
	}

	const workers = $derived.by<WorkerRow[]>(() => {
		const raw = (result as any)?.workers
		// A tool payload can arrive as an object with numeric keys once it has been through
		// JSON round-trips; the shared helper is the same one the subagent card uses.
		const list = Array.isArray(raw) ? raw : numericKeyObjectToArray(raw)
		if (!Array.isArray(list)) return []
		return list
			.filter((entry: any) => entry && typeof entry === 'object')
			.map((entry: any, position: number) => {
				const usage = entry.usage && typeof entry.usage === 'object' ? entry.usage : null
				return {
					index: readNumber(entry.index) ?? position,
					name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `Worker ${position + 1}`,
					role: typeof entry.role === 'string' && entry.role.trim() ? entry.role.trim() : null,
					base: typeof entry.base === 'string' && entry.base.trim() ? entry.base.trim() : null,
					status: readStatus(entry.status),
					output: typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output ?? '', null, 2),
					durationMs: readNumber(entry.durationMs) ?? 0,
					totalTokens: usage ? readNumber(usage.totalTokens) : null
				}
			})
	})

	/** A refusal (cap hit, unknown base, workers off) returns no runs and a message. */
	const refusalMessage = $derived.by(() => {
		if (workers.length > 0) return ''
		const message = (result as any)?.message
		return typeof message === 'string' && message.trim() ? message.trim() : ''
	})

	const completedCount = $derived(workers.filter((worker) => worker.status === 'completed').length)

	const cardStatus = $derived.by(() => {
		if (workers.length === 0) return 'error'
		return completedCount === workers.length ? 'success' : 'info'
	})

	const subtitle = $derived.by(() => {
		if (workers.length === 0) return 'No workers ran'
		const noun = workers.length === 1 ? 'worker' : 'workers'
		return `${completedCount}/${workers.length} ${noun} completed`
	})

	function formatDuration(ms: number): string {
		if (!Number.isFinite(ms) || ms <= 0) return '—'
		if (ms < 1000) return `${Math.round(ms)} ms`
		return `${(ms / 1000).toFixed(1)} s`
	}

	function statusLabel(status: WorkerRow['status']): string {
		if (status === 'completed') return 'Completed'
		if (status === 'timed_out') return 'Timed out'
		return 'Failed'
	}
</script>

<FullTool
	icon={UsersRound}
	title="Workers"
	{subtitle}
	status={cardStatus}
	bind:collapsed
>
	<div class="workers-content">
		{#if refusalMessage}
			<div class="worker-refusal">{refusalMessage}</div>
		{/if}

		{#each workers as worker (worker.index)}
			<div class="worker">
				<div class="worker-header">
					<span class="worker-name">{worker.name}</span>
					{#if worker.base}
						<span class="worker-meta">copy of {worker.base}</span>
					{/if}
					<span class="worker-spacer"></span>
					<span class="worker-meta">{formatDuration(worker.durationMs)}</span>
					{#if worker.totalTokens !== null}
						<span class="worker-meta">{worker.totalTokens.toLocaleString()} tokens</span>
					{/if}
					<span class="worker-status" data-status={worker.status}>{statusLabel(worker.status)}</span>
				</div>
				<div class="worker-output">{worker.output}</div>
			</div>
		{/each}
	</div>
</FullTool>

<style>
	.workers-content {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.worker {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.5rem;
	}

	.worker-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		padding: 0.25rem 0;
		flex-wrap: wrap;
	}

	.worker-name {
		font-weight: 500;
		color: var(--foreground);
		font-size: 0.8125rem;
	}

	.worker-meta {
		opacity: 0.7;
	}

	.worker-spacer {
		flex: 1 1 auto;
	}

	.worker-status {
		font-weight: 500;
	}

	.worker-status[data-status='completed'] {
		color: var(--bs-app-success-text, var(--muted-foreground));
	}

	.worker-status[data-status='failed'],
	.worker-status[data-status='timed_out'] {
		color: var(--bs-settings-danger, var(--destructive));
	}

	.worker-output {
		padding: 0.75rem;
		background: oklch(from var(--muted) l c h / 0.3);
		border-radius: 0.375rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
	}

	.worker-refusal {
		margin: 0 0.5rem;
		padding: 0.75rem;
		background: oklch(from var(--muted) l c h / 0.2);
		border-radius: 0.375rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--muted-foreground);
	}

	.worker-output::-webkit-scrollbar {
		width: 8px;
		height: 8px;
	}

	.worker-output::-webkit-scrollbar-track {
		background: transparent;
	}

	.worker-output::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 9999px;
	}

	.worker-output::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}
</style>
