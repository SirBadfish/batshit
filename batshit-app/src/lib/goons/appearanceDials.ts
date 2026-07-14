/**
 * Appearance Dials v2 public facade.
 *
 * The contract is intentionally split into focused pure modules so schema,
 * stored-value, and runtime-inventory changes can be reviewed independently.
 * Importers should continue using this file as the stable public API.
 */

export * from "./appearanceDials.contracts";
export { parseAppearanceDialsManifest } from "./appearanceDials.schema";
export { evaluateAppearanceDialTrack } from "./appearanceDials.validation";
export {
  appearanceDialValuesEqual,
  normalizeAppearanceDialValues,
  reconcileAppearanceDialValues,
  relockAppearanceDialSides,
  resolveAppearanceDialState,
  resolveAppearanceFollowerState,
} from "./appearanceDials.values";
export {
  getAppearanceRecipeBakeInventory,
  getAppearanceTargetBindings,
  validateAppearanceRuntimeInventory,
} from "./appearanceDials.runtime";
