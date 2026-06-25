<script lang="ts">
  import type { FileTreeNode as FileTreeNodeType } from '$lib/stores/projects.svelte'
  import FileTreeNode from './FileTreeNode.svelte'
  
  let { nodes = [] } = $props<{ nodes: FileTreeNodeType[] }>()
</script>

<div class="project-file-tree">
  {#each nodes as node}
    <FileTreeNode {node} level={0} />
  {/each}
</div>

<style>
  .project-file-tree {
    padding: 0.25rem 0;
  }
</style>
