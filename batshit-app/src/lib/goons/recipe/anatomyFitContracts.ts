/** Recipe integration for the independent Anatomy Fit schema. */
export * from "./anatomyFitSchema";
import {
  ANATOMY_FIT_RECIPE_SIBLING_ID,
  ANATOMY_FIT_STATE_CONTRACT,
  parseAnatomyFitState,
} from "./anatomyFitSchema";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import {
  parseRecipeSiblingStateRecord,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  verifyRecipeStateSnapshot,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "./recipeContracts";

function fail(context: string, reason: string): never {
  throw new Error(`[${context}] ${reason}`);
}

export async function anatomyFitRecipeSibling(stateValue: unknown) {
  const state = await parseAnatomyFitState(stateValue);
  return {
    id: ANATOMY_FIT_RECIPE_SIBLING_ID,
    contract: ANATOMY_FIT_STATE_CONTRACT,
    definitionSha256: state.definitionSha256,
    // Recipe sibling hashes bind the complete state object. The inner
    // stateSha256 separately proves the content excluding its self-hash.
    stateSha256: await canonicalRecipeSha256(state),
    state,
  };
}

/** Verify a managed sibling using its schema's declared numeric precision. */
export async function parseAnatomyFitRecipeSibling(
  value: unknown,
): Promise<RecipeSiblingStateRecord & { state: Awaited<ReturnType<typeof parseAnatomyFitState>> }> {
  const sibling = parseRecipeSiblingStateRecord(value);
  if (
    sibling.id !== ANATOMY_FIT_RECIPE_SIBLING_ID ||
    sibling.contract !== ANATOMY_FIT_STATE_CONTRACT
  ) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe sibling identity is ambiguous");
  }
  // RedisJSON may return adjacent doubles. Parse before the enclosing hash,
  // preserving every claimed hash and verifying all inner input/result hashes.
  const state = await parseAnatomyFitState(sibling.state);
  if (
    sibling.definitionSha256 !== state.definitionSha256 ||
    sibling.stateSha256 !== await recipeSiblingStateSha256(state)
  ) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe sibling hashes do not match its exact Anatomy Fit state");
  }
  return { ...sibling, state };
}

function managedAnatomyFitSibling(
  state: RecipeStateSnapshot,
): RecipeSiblingStateRecord | null {
  const candidates = state.siblings.filter(
    (entry) =>
      entry.id === ANATOMY_FIT_RECIPE_SIBLING_ID ||
      entry.contract === ANATOMY_FIT_STATE_CONTRACT,
  );
  if (candidates.length > 1) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe State contains ambiguous Anatomy Fit siblings");
  }
  const candidate = candidates[0] ?? null;
  if (
    candidate &&
    (candidate.id !== ANATOMY_FIT_RECIPE_SIBLING_ID ||
      candidate.contract !== ANATOMY_FIT_STATE_CONTRACT)
  ) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe sibling identity is ambiguous");
  }
  return candidate;
}

/** Return the one exact managed Anatomy Fit sibling from a verified Recipe State. */
export async function getAnatomyFitRecipeSibling(
  stateValue: unknown,
): Promise<RecipeSiblingStateRecord | null> {
  const state = await verifyRecipeStateSnapshot(stateValue);
  const sibling = managedAnatomyFitSibling(state);
  if (!sibling) return null;
  return parseAnatomyFitRecipeSibling(sibling);
}

/**
 * Remove deterministic Anatomy Fit output from migration-review state.
 *
 * Package migration owns user-authored sibling surfaces. Anatomy Fit is
 * derived from the verified target package and reviewed appearance values,
 * so carrying an old fit through that migration would authorize stale output.
 */
export async function withoutAnatomyFitRecipeSibling(
  stateValue: unknown,
): Promise<RecipeStateSnapshot> {
  const state = await verifyRecipeStateSnapshot(stateValue);
  const sibling = managedAnatomyFitSibling(state);
  if (!sibling) return state;
  await getAnatomyFitRecipeSibling(state);
  const next: RecipeStateSnapshot = {
    ...structuredClone(state),
    stateSha256: "0".repeat(64),
    siblings: state.siblings.filter((entry) => entry.id !== sibling.id),
  };
  next.stateSha256 = await recipeStateSnapshotSha256(next);
  return verifyRecipeStateSnapshot(next);
}

/** Replace the managed sibling from one verified Anatomy Fit state payload. */
export async function replaceAnatomyFitRecipeSibling(
  stateValue: unknown,
  anatomyFitStateValue: unknown | null,
): Promise<RecipeStateSnapshot> {
  const state = await withoutAnatomyFitRecipeSibling(stateValue);
  const sibling = anatomyFitStateValue === null
    ? null
    : await anatomyFitRecipeSibling(anatomyFitStateValue);
  const next: RecipeStateSnapshot = {
    ...structuredClone(state),
    stateSha256: "0".repeat(64),
    siblings: [
      ...state.siblings,
      ...(sibling ? [sibling] : []),
    ].sort((left, right) => left.id.localeCompare(right.id)),
  };
  next.stateSha256 = await recipeStateSnapshotSha256(next);
  return verifyRecipeStateSnapshot(next);
}
