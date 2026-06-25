<script lang="ts">
  interface Props {
    name?: string
    onLoaded?: (name: string) => void
  }

  let { name = 'Settings', onLoaded = () => {} }: Props = $props()

  $effect(() => {
    onLoaded(name)
  })
</script>

<p>Loaded {name}</p>
