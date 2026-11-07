# Dynamic Tool Search

Dynamic Tool Search finds and runs Batshit capabilities without loading every tool into your context.

## Call Directly First

<!-- runtime:api -->
If a tool is already in your tool list (Bash, `native_skill` scripts), call it directly. Search only for capabilities beyond that list.
<!-- /runtime -->

## Tool Hints: Call Without Searching

This is a Batshit feature, and it may be new to you. The `tool_discovery` section of your Agent Setup lists tools you can reach, grouped by where they come from. Read it with `setup_changes` in your DCM; those changes take priority. Some lines carry a hint: the tool's name and the fields it takes. For example:

```text
- HuggingFace (3 tools):
  - hf_search — required: query:string
- Memory:
  - fabric:sys.memory.search — required: `query` · optional: `lane`, `limit` (1 to 25)
```

When a hint tells you enough for a safe call, do not search. Call the use tool straight away. A line that starts with `fabric:` or `batshit:` already shows the full ref, such as `fabric:sys.memory.search`: copy it. Otherwise the ref is the group's prefix plus the name on the line:

- An MCP group (named after its MCP server): `mcp:<name>`, such as `mcp:hf_search`.
- **Fabric & Utilities**: `fabric:<name>`, such as `fabric:sys.zip.fetch`. The three utilities are `batshit:` instead: `batshit:sys.judge.ask`, `batshit:sys.mcp.dynamic.find` and `batshit:sys.mcp.dynamic.use`.
<!-- runtime:api -->
- **Batshit Utilities**: `batshit:<name>`, such as `batshit:sys.web_search.search` for Web Search.
<!-- /runtime -->
- **CLI Tools**: `cli:<name>`.
- **Artifact Tools**: `artifact:<name>`, such as `artifact:use.artifact.poster-maker`.

A line with no hint, or a group that shows only a count, still needs a search.

## Why This Matters: Cost

Every search is a tool call, and its result can be large. Batshit writes every tool result into the prompt cache, which costs money, and the result rides along on later requests until it zips. A wasted or broad search keeps costing. So:

- When a hint gives you what you need, call directly. Do not spend a search on it.
- When you do search, be precise. Set `family`, use a specific `query`, and keep `limit` small, so the results are short.
- Compact schema hints are the default and usually enough. Ask for `schemaMode: "full"` only when the hint is not enough or the action may be destructive.

## Tool Pair

<!-- runtime:api -->
Your broker pair is `native_batshit_tool_search` / `native_batshit_tool_use`.
<!-- /runtime -->

They are tools, not skills: never call `native_skill` with `skillId="{{ $tool_search_tool }}"` or `skillId="{{ $tool_use_tool }}"`.

Use them, not Bash, for saved CLI tools, MCP tools, Artifact tools, Fabric controls, Batshit utilities and Agent Browser actions. Bash is for shell work.

## Families

Every ref starts with its family:

- `mcp:` user-installed MCP gateway tools
- `cli:` saved Batshit CLI tools
- `artifact:` published Artifact tools
- `fabric:` Batshit feature controls and helpers (Fetch Zip, ComfyUI, the model catalog and Artifact authoring are here)
<!-- runtime:api -->
- `batshit:` the utilities above
<!-- /runtime -->
- `agent_browser:` Agent Browser actions, where supported

## Rules

1. Copy a ref exactly; never make one up. `fabric:` and `batshit:` are not interchangeable, and a group heading such as "Fabric & Utilities" is not a prefix.
2. Put the tool's arguments inside `input`, never at the top level.
3. If a call fails for a missing field, read the schema or the result and retry with the exact field names.
4. Use only tools that `tool_discovery` or a search gave you. A Subagent or Worker gets fewer families than a Primary Agent.
5. Before a tool that writes, deletes, deploys, pays or changes an account, get its full details or ask the user when its effects are unclear.
6. Use a tool hint to call a tool without searching whenever the hint tells you enough.
7. Keep every search precise (`family`, a specific `query`, a small `limit`) so it returns the smallest result it can.

## Example

<!-- runtime:api -->
```json
native_batshit_tool_search({ "family": "mcp", "query": "web fetch", "schemaMode": "compact" })
```

```json
native_batshit_tool_use({ "ref": "mcp:fetch", "input": { "url": "https://example.com", "max_length": 2000 } })
```
<!-- /runtime -->

Wrong: `{ "ref": "mcp:fetch", "url": "https://example.com" }`. The arguments must be inside `input`.
Wrong: `{ "ref": "youtube.get_transcript", ... }`. That ref has no family prefix and was made up from a group label; search first, then copy `results[0].ref`.
