<script lang="ts">
	/**
	 * SA-113 P4 (DL-113-10b) — the Agent DM tool card.
	 *
	 * The one thing a generic Fabric card cannot show is what a DM actually DID. Every
	 * `deliver: 'wake'` that could not wake degrades to a wait with a recorded reason
	 * (DL-113-12: nothing is dropped, nothing retries), and that reason is the most useful
	 * line on the card — "DM to Cooper · assignment · woke a chat" versus "· waiting in his
	 * inbox (Cooper is already working an assignment)". Without it the send just looks like
	 * it worked and the user wonders later why nothing happened.
	 *
	 * Structure and tokens copied from its neighbour `../workers/WorkersRenderer.svelte`.
	 */
	import Mail from '@lucide/svelte/icons/mail'
	import FullTool from '../templates/FullTool.svelte'
	import JevJuiceFlagBlock from '$lib/components/chat/JevJuiceFlagBlock.svelte'
	import { getJevJuiceDmScreen, requestDmBrief } from '$lib/stores/dmBriefs.svelte'
	import {
		UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT,
		UNTRUSTED_TEXT_INLINE_TEXT,
		jevJuiceNoteDetail,
		jevJuiceNoteText,
		untrustedTextSkippedNote
	} from '$lib/utils/jevJuice'

	let { tool } = $props()

	let collapsed = $state(true)

	const OPERATION_LABELS: Record<string, string> = {
		'sys.dm.send': 'Send',
		'sys.dm.list': 'Inbox',
		'sys.dm.read': 'Read',
		'sys.dm.claim': 'Claim',
		'sys.dm.done': 'Done',
		'sys.dm.blocked': 'Blocked',
		'sys.dm.agents': 'Who is around'
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

	/**
	 * The control envelope, as it actually arrives.
	 *
	 * A broker step is compacted before it reaches a card: `toolArgs` keeps only
	 * `{ref, target}`, the agent's real input moves to `toolResult.input`, and the control's
	 * own answer sits one level down at `toolResult.result`. Reading the top level finds
	 * nothing, which is exactly what an untested card does — so both levels are read here,
	 * and `dmRenderer.test.ts` pins the shape against a payload captured from a live run.
	 */
	const envelope = $derived.by(() => {
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

	const result = $derived.by<Record<string, any>>(() => {
		const inner = (envelope as any)?.result
		return inner && typeof inner === 'object' && !Array.isArray(inner)
			? { ...(envelope as any), ...inner }
			: ((envelope as any) ?? {})
	})

	const controlId = $derived.by<string>(() => {
		const candidates = [tool?.metadata?.fabricControlId, tool?.displayToolName, tool?.toolName]
		for (const candidate of candidates) {
			if (typeof candidate === 'string' && candidate.toLowerCase().includes('sys.dm.')) {
				const match = candidate.match(/sys\.dm\.[a-z_]+/i)
				if (match) return match[0].toLowerCase()
			}
		}
		return ''
	})

	const operationLabel = $derived(OPERATION_LABELS[controlId] ?? 'Agent DM')

	const args = $derived.by<Record<string, any>>(() => {
		const nested = (envelope as any)?.input
		const direct = tool?.toolInput
		// SA-120 P7, found live: the managed CLI lane keeps the agent's input under
		// `toolArgs.input` (its result envelope has no `input`), so a Codex or Claude
		// `sys.dm.read` / `claim` card had no DM id and an empty subtitle.
		const cliInput = tool?.toolArgs?.input
		const merged: Record<string, any> = {}
		for (const source of [direct, cliInput, nested]) {
			if (source && typeof source === 'object' && !Array.isArray(source)) {
				Object.assign(merged, source)
			}
		}
		return merged
	})

	function readString(...values: unknown[]): string | null {
		for (const value of values) {
			if (typeof value === 'string' && value.trim()) return value.trim()
		}
		return null
	}

	const deliveredAs = $derived(readString((result as any)?.delivered_as))
	const reason = $derived(readString((result as any)?.reason))
	const dmId = $derived(
		readString((result as any)?.dm_id, (args as any)?.dm_id, (result as any)?.dm?.id)
	)
	const recipient = $derived(readString((args as any)?.to))
	const kind = $derived(readString((args as any)?.kind))
	const subject = $derived(readString((args as any)?.subject))
	const recipientState = $derived(readString((result as any)?.recipient_state))
	const sessionId = $derived(readString((result as any)?.session_id))
	const errorText = $derived(
		readString(
			typeof (envelope as any)?.error === 'string' ? (envelope as any).error : null,
			typeof (envelope as any)?.error?.message === 'string' ? (envelope as any).error.message : null,
			tool?.error
		)
	)

	/** `to: "all"` returns a broadcast summary rather than one delivery. */
	const broadcast = $derived.by(() => {
		const raw = result as any
		if (raw?.broadcast !== true) return null
		const delivered = Array.isArray(raw.delivered) ? raw.delivered.length : 0
		const skipped = Array.isArray(raw.skipped) ? raw.skipped.length : 0
		return { delivered, skipped }
	})

	/**
	 * SA-120 P7 — the Jev Juice flag on this DM, if it has one.
	 *
	 * Asked by DM id from the screens store rather than read off the tool result, on purpose:
	 * the result is what the AGENT reads, and only the agent that READS a flagged DM is told
	 * about it (a sender gets no oracle for rewording). The user's badge must not depend on
	 * that, so every card that names a DM (send, read, claim, done, blocked) looks its id up.
	 * A broadcast shares one text, so its first delivery's id stands for all of them.
	 * "No flag" and "never screened" both come back `null` and draw nothing.
	 */
	const screenDmId = $derived.by<string | null>(() => {
		if (dmId) return dmId
		const delivered = (result as any)?.delivered
		return Array.isArray(delivered) ? readString(delivered[0]?.dm_id) : null
	})
	$effect(() => {
		requestDmBrief(screenDmId)
	})
	const screen = $derived(getJevJuiceDmScreen(screenDmId))
	const flagSuffix = $derived(screen?.status === 'flagged' ? ` · ${UNTRUSTED_TEXT_INLINE_TEXT}` : '')

	const openCount = $derived.by<number | null>(() => {
		const value = (result as any)?.total_open
		return typeof value === 'number' && Number.isFinite(value) ? value : null
	})

	const subtitle = $derived.by(() => {
		if (errorText) return errorText
		if (broadcast) {
			return `broadcast · ${broadcast.delivered} delivered${broadcast.skipped ? `, ${broadcast.skipped} skipped` : ''}${flagSuffix}`
		}
		if (controlId === 'sys.dm.send') {
			const who = recipient ? `to ${recipient}` : 'sent'
			const what = kind ? ` · ${kind}` : ''
			if (deliveredAs === 'wake') return `${who}${what} · woke a chat${flagSuffix}`
			// SA-114 DL-114-13: a steer landed INSIDE a reply that was already running. It
			// needs its own line, because without one it falls through to the bare `${who}`
			// and reads as an ordinary send — the card would be the only place in Batshit
			// that could not tell the three delivery modes apart.
			if (deliveredAs === 'steer') return `${who}${what} · landed mid-reply${flagSuffix}`
			if (deliveredAs === 'wait') {
				return reason
					? `${who}${what} · waiting in inbox (${reason})${flagSuffix}`
					: `${who}${what} · waiting in inbox${flagSuffix}`
			}
			return `${who}${what}${flagSuffix}`
		}
		if (controlId === 'sys.dm.list') {
			if (openCount === null) return 'Inbox'
			return openCount === 1 ? '1 open item' : `${openCount} open items`
		}
		if (controlId === 'sys.dm.agents') {
			const agents = (result as any)?.agents
			const count = Array.isArray(agents) ? agents.length : 0
			return count === 1 ? '1 agent' : `${count} agents`
		}
		// SA-120 P7: the card opens collapsed, so a flag has to be readable from the subtitle.
		return `${dmId ?? ''}${flagSuffix}`
	})

	const cardStatus = $derived.by(() => {
		if (errorText) return 'error'
		// A degraded wake is not a failure — the DM is safely in the inbox — but it is not
		// the thing the agent asked for either, so it reads as info rather than success.
		if (controlId === 'sys.dm.send' && deliveredAs === 'wait' && reason) return 'info'
		// SA-120 P7: a flagged DM is not a failed call, but a green tick beside it would read wrong.
		if (screen?.status === 'flagged') return 'info'
		return 'success'
	})
</script>

<FullTool icon={Mail} title={`Agent DM · ${operationLabel}`} {subtitle} status={cardStatus} bind:collapsed>
	<div class="dm-card">
		{#if errorText}
			<div class="dm-card-refusal">{errorText}</div>
		{/if}

		{#if screen?.status === 'flagged'}
			<JevJuiceFlagBlock view={screen} closing={UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT} testId="jev-juice-dm-card-flag" />
		{:else if screen?.status === 'skipped'}
			<div
				class="dm-card-flag-note"
				title={jevJuiceNoteDetail(untrustedTextSkippedNote(screen))}
				data-testid="jev-juice-dm-card-skipped"
			>
				{jevJuiceNoteText(untrustedTextSkippedNote(screen))}
			</div>
		{/if}

		{#if subject}
			<div class="dm-card-subject">{subject}</div>
		{/if}

		<dl class="dm-card-fields">
			{#if recipient}
				<div><dt>To</dt><dd>{recipient}</dd></div>
			{/if}
			{#if kind}
				<div><dt>Kind</dt><dd>{kind}</dd></div>
			{/if}
			{#if deliveredAs}
				<div><dt>Delivered as</dt><dd>{deliveredAs}</dd></div>
			{/if}
			{#if reason}
				<div><dt>Why it waited</dt><dd>{reason}</dd></div>
			{/if}
			{#if recipientState}
				<div><dt>Recipient</dt><dd>{recipientState}</dd></div>
			{/if}
			{#if sessionId}
				<div><dt>Chat it started</dt><dd><code>{sessionId}</code></dd></div>
			{/if}
			{#if dmId}
				<div><dt>DM id</dt><dd><code>{dmId}</code></dd></div>
			{/if}
		</dl>
	</div>
</FullTool>

<style>
	.dm-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.5rem;
	}

	.dm-card-refusal {
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--bs-settings-danger-line, var(--border));
		border-radius: 8px;
		background: var(--bs-settings-danger-bg, transparent);
		color: var(--bs-settings-danger, var(--destructive));
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	/* SA-120 P7: the skipped note under the card (the flag itself is `JevJuiceFlagBlock`). */
	.dm-card-flag-note {
		color: var(--muted-foreground);
		font-size: 0.75rem;
		line-height: 1.45;
	}

	.dm-card-subject {
		color: var(--foreground);
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.4;
	}

	.dm-card-fields {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
	}

	.dm-card-fields div {
		display: flex;
		gap: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.45;
	}

	.dm-card-fields dt {
		flex: 0 0 auto;
		min-width: 7rem;
		color: var(--muted-foreground);
		font-weight: 500;
	}

	.dm-card-fields dd {
		margin: 0;
		color: var(--foreground);
		overflow-wrap: anywhere;
	}
</style>
