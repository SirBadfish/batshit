Dynamic Tool Search lets you discover and use Batshit capabilities without loading huge tool lists into context.

## Tool Pair

Use the pair your runtime exposes:

- API/direct agents: `native_batshit_tool_search` / `native_batshit_tool_use`
- Managed CLI and n8n agents: `batshit_tool_search` / `batshit_tool_use`

## Families

Search results return exact typed refs. The prefix matters:

- `mcp:...` for user-installed MCP gateway tools
- `cli:...` for saved Batshit CLI tools
- `artifact:...` for published artifact runtime tools
- `fabric:...` for Batshit control-plane actions when this actor is allowed to use broad Fabric
- `agent_browser:...` for Agent Browser actions where the active runtime supports them

## First-Try Rules

1. Search with `family` when you know the lane: `mcp`, `cli`, `artifact`, `fabric`, or `agent_browser`.
2. Copy the exact returned `ref` into the use call.
3. Put capability-specific arguments inside `input`.
4. Compact schema hints are the default and are usually enough.
5. Request full schema only when the compact hint is not enough or the action may be destructive.
6. Do not pass `userId` unless a specific HTTP bridge contract explicitly requires it.
7. Do not call `native_skill` with `skillId="batshit_tool_search"` or `skillId="batshit_tool_use"`; these are tools, not skills.

## Preferred Call Shapes

API/direct:
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

Managed CLI/n8n:
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

## Bad vs Good Examples

Bad: target arguments at the top level:
```json
batshit_tool_use({
  "ref": "mcp:fetch",
  "url": "https://example.com"
})
```

Good: target arguments inside `input`:
```json
batshit_tool_use({
  "ref": "mcp:fetch",
  "input": {
    "url": "https://example.com"
  }
})
```

Bad: inventing a namespaced MCP ref from a group label:
```json
batshit_tool_use({
  "ref": "youtube.get_transcript",
  "input": { "video_id": "abc123" }
})
```

Good: search first, then use the exact returned ref:
```json
batshit_tool_search({
  "family": "mcp",
  "query": "get transcript",
  "schemaMode": "compact"
})
```

Then copy the exact `results[0].ref` into `batshit_tool_use`.

## Safety Notes

- Hints are guidance, not authorization. Backend validation, scope checks, risk gates, artifact allowlists, and runtime placement checks remain authoritative.
- For write/edit/delete/deploy/payment/account-changing tools, request fuller details or ask the user before execution when the side effects are unclear.
- Broad Fabric controls are not available to all actors. n8n agents and subagents must not assume they can use `fabric:` refs unless search actually returns them.
- Bash, Web Search, Fetch Zip, and `native_skill` are separate primitives. Do not route them through Dynamic Tool Search.

## Recommended Flow

1. Read `tool_discovery` in DCM first. It may list family names, exact refs, or compact schema hints.
2. If DCM gives an exact ref and enough hint detail for a safe action, call the use tool directly.
3. Otherwise call the search tool with a precise `family` and `query`.
4. Use `schemaMode: "full"` only when compact hints are insufficient.
5. Execute one exact returned `ref` with `input`.
