Dynamic Tool Search lets you discover and use Batshit capabilities without loading huge tool lists into context.

## Tool Pair

<!-- runtime:api -->
Your broker pair is `native_batshit_tool_search` / `native_batshit_tool_use`.
<!-- /runtime -->
<!-- runtime:cli -->
Your broker pair is `batshit_tool_search` / `batshit_tool_use`.
<!-- /runtime -->

Do not call `native_skill` with `skillId="{{ $tool_search_tool }}"` or `skillId="{{ $tool_use_tool }}"`; these are tools, not skills.

## Families

Search results return exact typed refs. The prefix matters:

- `mcp:...` for user-installed MCP gateway tools
- `cli:...` for saved Batshit CLI tools
- `artifact:...` for published artifact runtime tools
- `fabric:...` for Batshit control-plane actions when this actor is allowed to use broad Fabric
- `agent_browser:...` for Agent Browser actions where the active runtime supports them

## When To Reach For It

Prefer the broker over bash for saved CLI tools, MCP tools, artifact runtime tools, Fabric controls, and Agent Browser actions whenever that family is available. Bash is for shell work, not for reaching Batshit capabilities that already have a ref.

## First-Try Rules

1. Search with `family` when you know the lane: `mcp`, `cli`, `artifact`, `fabric`, or `agent_browser`.
2. Copy the exact returned `ref` into the use call. Never invent placeholder refs like `"selected"`.
3. Put capability-specific arguments inside `input`. Never flatten required fields to the top level.
4. Compact schema hints are the default and are usually enough.
5. Request full schema only when the compact hint is not enough or the action may be destructive.
6. Do not pass `userId` unless a specific HTTP bridge contract explicitly requires it.
7. If a call fails because a required field is missing, inspect the schema/result and retry with the exact field names.

## Preferred Call Shapes

<!-- runtime:api -->
```json
native_batshit_tool_search({
  "family": "mcp",
  "query": "web fetch",
  "schemaMode": "compact"
})
```

```json
native_batshit_tool_use({
  "ref": "mcp:fetch",
  "input": {
    "url": "https://example.com",
    "max_length": 2000,
    "raw": false
  }
})
```
<!-- /runtime -->
<!-- runtime:cli -->
```json
batshit_tool_search({
  "family": "cli",
  "query": "image resize",
  "schemaMode": "compact"
})
```

```json
batshit_tool_use({
  "ref": "cli:image_resize",
  "input": {
    "inputFile": "/path/to/image.png",
    "width": 1024
  }
})
```
<!-- /runtime -->

If the hint or schema says a required field is `inputFile`, keep it inside `input.inputFile`.

## Bad vs Good Examples

Bad: target arguments at the top level:
```json
{{ $tool_use_tool }}({
  "ref": "mcp:fetch",
  "url": "https://example.com"
})
```

Good: target arguments inside `input`:
```json
{{ $tool_use_tool }}({
  "ref": "mcp:fetch",
  "input": {
    "url": "https://example.com"
  }
})
```

Bad: inventing a namespaced MCP ref from a group label:
```json
{{ $tool_use_tool }}({
  "ref": "youtube.get_transcript",
  "input": { "video_id": "abc123" }
})
```

Good: search first, then use the exact returned ref:
```json
{{ $tool_search_tool }}({
  "family": "mcp",
  "query": "get transcript",
  "schemaMode": "compact"
})
```

Then copy the exact `results[0].ref` into `{{ $tool_use_tool }}`.

## Safety Notes

- Hints are guidance, not authorization. Backend validation, scope checks, risk gates, artifact allowlists, and runtime placement checks remain authoritative.
- For write/edit/delete/deploy/payment/account-changing tools, request fuller details or ask the user before execution when the side effects are unclear.
- Broad Fabric controls are not available to all actors. Subagents must not assume they can use `fabric:` refs unless search actually returns them.
- Bash, Web Search, Fetch Zip, and `native_skill` are separate primitives. Do not route them through Dynamic Tool Search.

## Recommended Flow

1. Read `tool_discovery` in DCM first. It may list family names, exact refs, or compact schema hints.
2. If DCM gives an exact ref and enough hint detail for a safe action, call the use tool directly.
3. Otherwise call the search tool with a precise `family` and `query`.
4. Use `schemaMode: "full"` only when compact hints are insufficient.
5. Execute one exact returned `ref` with `input`.
