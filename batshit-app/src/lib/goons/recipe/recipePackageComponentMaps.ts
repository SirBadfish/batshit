import { canonicalRecipeString } from "./recipeCanonical";
import type { RecipeComponentMapBundle } from "./componentMapSchema";
import {
  verifyRecipeUpdatesContract,
  verifyRecipeUpdateComponentMapBundle,
  type RecipeUpdateEdge,
} from "./updateContracts";

/**
 * Discover package-authored maps from the exact verified target manifest.
 * An explicit API map remains valid, but may never override an embedded map.
 * Every embedded map is checked, including maps for other predecessor edges.
 */
export async function resolveRecipePackageComponentMapBundle(
  updatesValue: unknown,
  edge: RecipeUpdateEdge,
  explicitValue?: unknown,
): Promise<RecipeComponentMapBundle | undefined> {
  const updates = await verifyRecipeUpdatesContract(updatesValue);
  const matchingEdge = updates.edges.find(
    (entry) => entry.directEdgeKey === edge.directEdgeKey,
  );
  if (
    !matchingEdge ||
    canonicalRecipeString(matchingEdge) !== canonicalRecipeString(edge)
  ) {
    throw new Error(
      "selected component map edge is not the exact embedded update edge",
    );
  }
  const embedded = updates.componentMapBundles?.find(
    (bundle) => bundle.directEdgeKey === edge.directEdgeKey,
  );
  const explicit =
    explicitValue === undefined
      ? undefined
      : await verifyRecipeUpdateComponentMapBundle(explicitValue, edge);
  if (
    embedded &&
    explicit &&
    canonicalRecipeString(embedded) !== canonicalRecipeString(explicit)
  ) {
    throw new Error(
      "explicit component map bundle conflicts with the package-authored bundle",
    );
  }
  return embedded ?? explicit;
}
