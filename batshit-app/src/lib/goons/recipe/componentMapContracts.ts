import { canonicalRecipeString } from "./recipeCanonical";
import {
  buildRecipeUpdateDirectEdgeKey,
  verifyRecipeUpdateEdge,
  type RecipeUpdateEdge,
} from "./updateContracts";
import {
  RECIPE_COMPONENT_MAPS_CONTRACT,
  verifyRecipeComponentMapBundleHashes,
  type RecipeComponentMapBundle,
  type RecipeComponentMapMembership,
} from "./componentMapSchema";

export * from "./componentMapSchema";

export type RecipeComponentMapVerifierContext = {
  edge: RecipeUpdateEdge;
  sourceControlRanges: Record<string, [number, number]>;
  targetControlRanges: Record<string, [number, number]>;
  componentMembership: Record<string, RecipeComponentMapMembership>;
};

function fail(message: string): never {
  throw new Error(`[${RECIPE_COMPONENT_MAPS_CONTRACT}] ${message}`);
}

function assertRange(
  actual: [number, number] | undefined,
  context: string,
): [number, number] {
  if (!actual || !actual.every(Number.isFinite) || actual[0] > actual[1]) {
    fail(`${context} has no valid verifier range`);
  }
  return actual;
}

export async function verifyRecipeComponentMapBundle(
  value: unknown,
  verifier: RecipeComponentMapVerifierContext,
): Promise<RecipeComponentMapBundle> {
  const bundle = await verifyRecipeComponentMapBundleHashes(value);
  const edge = await verifyRecipeUpdateEdge(verifier.edge);
  const expectedDirectKey = buildRecipeUpdateDirectEdgeKey(edge.from, edge.to);
  if (
    bundle.directEdgeKey !== expectedDirectKey ||
    bundle.directEdgeKey !== edge.directEdgeKey ||
    bundle.edgeSha256 !== edge.edgeSha256 ||
    canonicalRecipeString(bundle.fromSource) !==
      canonicalRecipeString(edge.from) ||
    canonicalRecipeString(bundle.toSource) !== canonicalRecipeString(edge.to)
  ) {
    fail("bundle targets another direct edge");
  }
  for (const map of bundle.maps) {
    if (map.auditedFixtureSha256 !== edge.proof.fixtureSha256) {
      fail(`map ${map.mapId} targets another audited fixture`);
    }
    const membership = verifier.componentMembership[map.componentId];
    if (
      !membership ||
      canonicalRecipeString({
        sourceControlIds: map.sourceControlIds,
        targetControlIds: map.targetControlIds,
        sourceUnlockDialIds: map.sourceUnlockDialIds,
        targetUnlockDialIds: map.targetUnlockDialIds,
      }) !== canonicalRecipeString(membership)
    ) {
      fail(`map ${map.mapId} contradicts component membership`);
    }
    for (const branch of map.branches) {
      for (const domain of branch.sourceDomain) {
        const range = assertRange(
          verifier.sourceControlRanges[domain.controlId],
          `source control ${domain.controlId}`,
        );
        if (domain.minimum < range[0] || domain.maximum > range[1]) {
          fail(
            `map ${map.mapId} branch ${branch.branchId} exceeds source range`,
          );
        }
      }
      for (const targetId of map.targetControlIds) {
        assertRange(
          verifier.targetControlRanges[targetId],
          `target control ${targetId}`,
        );
      }
    }
  }
  for (const alias of edge.aliases) {
    if (
      !bundle.maps.some((map) => map.mapSha256 === alias.componentMapSha256)
    ) {
      fail(`alias ${alias.fromId} -> ${alias.toId} has no executable map`);
    }
  }
  return bundle;
}
