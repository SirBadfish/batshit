/**
 * Fabric control runtime modes.
 *
 * This lives in its own leaf module so consumers that only need the type do not have to
 * import `fabricRegistry`. SA-096 P4 gave `dynamicMcpIndex` a dependency on the registry,
 * which closed the cycle
 * `dynamicMcpTools` -> `dynamicMcpIndex` -> `fabricRegistry` -> `dynamicMcpTools`
 * (the registry's `sys.mcp.dynamic.*` controls delegate to the shared Dynamic MCP
 * executor by design). CI enforces a zero circular-import budget, and madge counts
 * `import type` as a real edge, so a type-only import was not enough to break it.
 *
 * `fabricRegistry` re-exports this type, so every existing import path still works.
 */
export type ControlRuntimeMode = 'mode1' | 'mode2' | 'mode3' | 'mode4'
