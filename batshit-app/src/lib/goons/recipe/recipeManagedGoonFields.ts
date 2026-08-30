/**
 * The exact Goon-record fields owned by the durable Recipe compare-and-swap
 * boundary. Keep this list server-safe: it is interpolated into Redis Lua by
 * both generic mutation rejection and Recipe commits.
 */
export const RECIPE_MANAGED_GOON_FIELDS = [
  "recipe",
  "customAvatar",
  "appearanceDials",
  "facialArtwork",
  "eyeAppearance",
  "oralAppearance",
  "lipArtwork",
  "lipArtworkPresence",
  "nailSurface",
  "nailSurfacePresence",
  "skinAppearance",
  "skinMaterialArtwork",
  "hairState",
  "clothingState",
  "recipeFitReceipts",
] as const;

export type RecipeManagedGoonField =
  (typeof RECIPE_MANAGED_GOON_FIELDS)[number];
