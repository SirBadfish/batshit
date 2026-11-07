<script lang="ts">
  import ZipbatshitWrapper from './ZipbatshitWrapper.svelte'
  import type { ToolResultSizeGuard } from '$lib/utils/toolResultSizeGuard'
  import type { ZipLiveSnapshot } from '$lib/utils/zipLiveSnapshot'

  let {
    isZipped = false,
    isUnzipped = false,
    expandedReason = undefined,
    isPermanent = false,
    remainingMessages = undefined,
    manualZip = false,
    agentControlled = false,
    inferredControlled = false,
    aboutToZip = false,
    holdLabel = null,
    deadCopyReason = null,
    heldDeadCopy = false,
    userHeld = false,
    sizeGuard = null,
    liveSnapshot = null,
    tokens = 857,
    onToggleUnzip = () => {},
    onZipNow = undefined,
    onReturnAutomatic = undefined
  }: {
    isZipped?: boolean
    isUnzipped?: boolean
    expandedReason?: 'buffer' | 'user' | 'agent' | 'inferred'
    isPermanent?: boolean
    remainingMessages?: number | null
    manualZip?: boolean
    agentControlled?: boolean
    inferredControlled?: boolean
    aboutToZip?: boolean
    holdLabel?: string | null
    deadCopyReason?: 'superseded' | 'stale' | null
    heldDeadCopy?: boolean
    userHeld?: boolean
    sizeGuard?: ToolResultSizeGuard
    liveSnapshot?: ZipLiveSnapshot | null
    tokens?: number
    onToggleUnzip?: (permanent: boolean, name?: string, description?: string, tokens?: number) => void
    onZipNow?: (zipId: string, name?: string, description?: string, tokens?: number) => void
    onReturnAutomatic?: (zipId: string) => void
  } = $props()
</script>

<ZipbatshitWrapper
  {isZipped}
  zipId="zip-test"
  {tokens}
  {isUnzipped}
  {expandedReason}
  {isPermanent}
  {remainingMessages}
  {holdLabel}
  {deadCopyReason}
  {heldDeadCopy}
  {userHeld}
  {sizeGuard}
  {liveSnapshot}
  {manualZip}
  {agentControlled}
  {inferredControlled}
  {aboutToZip}
  name="Read File"
  description="Read File output"
  {onToggleUnzip}
  {onZipNow}
  {onReturnAutomatic}
>
  <div>Wrapped zip content</div>
</ZipbatshitWrapper>
