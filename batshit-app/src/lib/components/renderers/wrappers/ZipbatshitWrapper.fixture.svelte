<script lang="ts">
  import ZipbatshitWrapper from './ZipbatshitWrapper.svelte'

  let {
    isZipped = false,
    isUnzipped = false,
    expandedReason = undefined,
    isPermanent = false,
    remainingMessages = undefined,
    manualZip = false,
    agentControlled = false,
    aboutToZip = false,
    onToggleUnzip = () => {},
    onZipNow = undefined,
    onReturnAutomatic = undefined
  }: {
    isZipped?: boolean
    isUnzipped?: boolean
    expandedReason?: 'buffer' | 'user' | 'agent'
    isPermanent?: boolean
    remainingMessages?: number | null
    manualZip?: boolean
    agentControlled?: boolean
    aboutToZip?: boolean
    onToggleUnzip?: (permanent: boolean, name?: string, description?: string, tokens?: number) => void
    onZipNow?: (zipId: string, name?: string, description?: string, tokens?: number) => void
    onReturnAutomatic?: (zipId: string) => void
  } = $props()
</script>

<ZipbatshitWrapper
  {isZipped}
  zipId="zip-test"
  tokens={857}
  {isUnzipped}
  {expandedReason}
  {isPermanent}
  {remainingMessages}
  {manualZip}
  {agentControlled}
  {aboutToZip}
  name="Read File"
  description="Read File output"
  {onToggleUnzip}
  {onZipNow}
  {onReturnAutomatic}
>
  <div>Wrapped zip content</div>
</ZipbatshitWrapper>
