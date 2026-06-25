<script lang="ts">
  interface Props {
    data: any
    compact?: boolean
  }

  let {
    data,
    compact = false
  }: Props = $props()

  let formattedJSON = $derived.by(() => {
    try {
      if (typeof data === 'string') {
        // Try to parse if it's a string
        const parsed = JSON.parse(data)
        return JSON.stringify(parsed, null, compact ? 0 : 2)
      }
      return JSON.stringify(data, null, compact ? 0 : 2)
    } catch (error) {
      // If it's not valid JSON, just return as-is
      return String(data)
    }
  })
</script>

<pre class="font-mono text-xs whitespace-pre-wrap break-words overflow-x-hidden"><code class="whitespace-pre-wrap break-words">{formattedJSON}</code></pre>
