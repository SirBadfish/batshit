import {
  ANATOMY_FIT_STATE_CONTRACT,
  type AnatomyFitState,
} from "./anatomyFitContracts";
import type { SocketEyeSide } from "../socketEyeSurface";
import {
  canonicalRecipeSha256,
  requireLowercaseSha256,
} from "./recipeCanonical";

export const ANATOMY_FIT_MANIFEST_CONTRACT =
  "anatomy-fit-manifest/v2" as const;
export const SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT =
  "socket-eye-anatomy-domain/v1" as const;
export const ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT =
  "oral-cavity-anatomy-domain/v1" as const;

export type SocketEyeAnatomyFitDomain = {
  contract: typeof SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT;
  side: SocketEyeSide;
  bodyMeshId: string;
  bodyTopologySha256: string;
  socketEyeSurfaceDefinitionSha256: string;
  apertureSeamDefinitionSha256: string;
  compositeCapNodeId: string;
  lashesEyeOutlineNodeId: string;
};

export type OralCavityAnatomyFitDomain = {
  contract: typeof ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT;
  bodyMeshId: string;
  bodyTopologySha256: string;
  oralCavityFitDefinitionSha256: string;
};

export type AnatomyFitManifestDomain =
  | OralCavityAnatomyFitDomain
  | SocketEyeAnatomyFitDomain;

export type AnatomyFitManifestDefinition = {
  contract: typeof ANATOMY_FIT_MANIFEST_CONTRACT;
  stateSchemaVersion: typeof ANATOMY_FIT_STATE_CONTRACT;
  domains: AnatomyFitManifestDomain[];
  definitionSha256: string;
};

type AnatomyFitManifestPayload = Omit<
  AnatomyFitManifestDefinition,
  "definitionSha256"
>;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(reason: string): never {
  throw new Error(`[${ANATOMY_FIT_MANIFEST_CONTRACT}] ${reason}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((entry, index) => entry !== sortedExpected[index])
  ) {
    fail(`${context} must contain exactly: ${sortedExpected.join(", ")}`);
  }
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    fail(`${context} must be a stable id`);
  }
  return value;
}

export function anatomyFitManifestDomainId(value: AnatomyFitManifestDomain) {
  return value.contract === ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT
    ? "oral-cavity"
    : `socket-eye:${value.side}`;
}

function parseDomain(value: unknown, index: number): AnatomyFitManifestDomain {
  const context = `Anatomy Fit manifest domains[${index}]`;
  const raw = record(value, context);
  if (raw.contract === ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT) {
    exactKeys(
      raw,
      [
        "contract",
        "bodyMeshId",
        "bodyTopologySha256",
        "oralCavityFitDefinitionSha256",
      ],
      context,
    );
    return {
      contract: ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT,
      bodyMeshId: stableId(raw.bodyMeshId, `${context}.bodyMeshId`),
      bodyTopologySha256: requireLowercaseSha256(
        raw.bodyTopologySha256,
        `${context}.bodyTopologySha256`,
      ),
      oralCavityFitDefinitionSha256: requireLowercaseSha256(
        raw.oralCavityFitDefinitionSha256,
        `${context}.oralCavityFitDefinitionSha256`,
      ),
    };
  }
  exactKeys(
    raw,
    [
      "contract",
      "side",
      "bodyMeshId",
      "bodyTopologySha256",
      "socketEyeSurfaceDefinitionSha256",
      "apertureSeamDefinitionSha256",
      "compositeCapNodeId",
      "lashesEyeOutlineNodeId",
    ],
    context,
  );
  if (raw.contract !== SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT) {
    fail(`${context}.contract is unsupported`);
  }
  if (raw.side !== "left" && raw.side !== "right") {
    fail(`${context}.side must be left or right`);
  }
  const compositeCapNodeId = stableId(raw.compositeCapNodeId, `${context}.compositeCapNodeId`);
  const lashesEyeOutlineNodeId = stableId(
    raw.lashesEyeOutlineNodeId,
    `${context}.lashesEyeOutlineNodeId`,
  );
  if (compositeCapNodeId === lashesEyeOutlineNodeId) {
    fail(`${context} cap and liner node ids must differ`);
  }
  return {
    contract: SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
    side: raw.side,
    bodyMeshId: stableId(raw.bodyMeshId, `${context}.bodyMeshId`),
    bodyTopologySha256: requireLowercaseSha256(
      raw.bodyTopologySha256,
      `${context}.bodyTopologySha256`,
    ),
    socketEyeSurfaceDefinitionSha256: requireLowercaseSha256(
      raw.socketEyeSurfaceDefinitionSha256,
      `${context}.socketEyeSurfaceDefinitionSha256`,
    ),
    apertureSeamDefinitionSha256: requireLowercaseSha256(
      raw.apertureSeamDefinitionSha256,
      `${context}.apertureSeamDefinitionSha256`,
    ),
    compositeCapNodeId,
    lashesEyeOutlineNodeId,
  };
}

function parsePayload(value: unknown): AnatomyFitManifestPayload {
  const raw = record(value, "Anatomy Fit manifest");
  exactKeys(raw, ["contract", "stateSchemaVersion", "domains"], "Anatomy Fit manifest");
  if (raw.contract !== ANATOMY_FIT_MANIFEST_CONTRACT) fail("contract is unsupported");
  if (raw.stateSchemaVersion !== ANATOMY_FIT_STATE_CONTRACT) {
    fail(`stateSchemaVersion must be ${ANATOMY_FIT_STATE_CONTRACT}`);
  }
  if (!Array.isArray(raw.domains) || raw.domains.length !== 3) {
    fail("domains must contain the oral cavity plus left and right socket-eye specializations");
  }
  const domains = raw.domains.map(parseDomain);
  const ids = domains.map(anatomyFitManifestDomainId);
  if (new Set(ids).size !== ids.length) fail("domains must not contain duplicate specialization ids");
  const sorted = [...domains].sort((left, right) =>
    anatomyFitManifestDomainId(left).localeCompare(anatomyFitManifestDomainId(right)),
  );
  if (
    domains.some(
      (entry, index) =>
        anatomyFitManifestDomainId(entry) !== anatomyFitManifestDomainId(sorted[index]!),
    )
  ) {
    fail("domains must be sorted by specialization id");
  }
  if (
    ids[0] !== "oral-cavity" ||
    ids[1] !== "socket-eye:left" ||
    ids[2] !== "socket-eye:right"
  ) {
    fail("domains must contain exactly oral-cavity, socket-eye:left, and socket-eye:right");
  }
  const topology = new Set(domains.map((entry) => entry.bodyTopologySha256));
  const socketDomains = domains.filter(
    (entry): entry is SocketEyeAnatomyFitDomain =>
      entry.contract === SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
  );
  const surface = new Set(socketDomains.map((entry) => entry.socketEyeSurfaceDefinitionSha256));
  const seam = new Set(socketDomains.map((entry) => entry.apertureSeamDefinitionSha256));
  if (topology.size !== 1 || surface.size !== 1 || seam.size !== 1) {
    fail("all domains must share one topology and bilateral sockets must share one surface and seam");
  }
  const nodes = socketDomains.flatMap((entry) => [
    entry.compositeCapNodeId,
    entry.lashesEyeOutlineNodeId,
  ]);
  if (new Set(nodes).size !== nodes.length) fail("bilateral cap and liner node ids must be unique");
  return {
    contract: ANATOMY_FIT_MANIFEST_CONTRACT,
    stateSchemaVersion: ANATOMY_FIT_STATE_CONTRACT,
    domains,
  };
}

export async function createAnatomyFitManifestDefinition(
  domainsValue: readonly AnatomyFitManifestDomain[],
): Promise<AnatomyFitManifestDefinition> {
  const domains = domainsValue
    .map((entry, index) => parseDomain(entry, index))
    .sort((left, right) =>
      anatomyFitManifestDomainId(left).localeCompare(anatomyFitManifestDomainId(right)),
    );
  const payload = parsePayload({
    contract: ANATOMY_FIT_MANIFEST_CONTRACT,
    stateSchemaVersion: ANATOMY_FIT_STATE_CONTRACT,
    domains,
  });
  return { ...payload, definitionSha256: await canonicalRecipeSha256(payload) };
}

export async function parseAnatomyFitManifestDefinition(
  value: unknown,
): Promise<AnatomyFitManifestDefinition> {
  const raw = record(value, "Anatomy Fit manifest");
  exactKeys(
    raw,
    ["contract", "stateSchemaVersion", "domains", "definitionSha256"],
    "Anatomy Fit manifest",
  );
  const { definitionSha256: claimed, ...payloadValue } = raw;
  const payload = parsePayload(payloadValue);
  const definitionSha256 = requireLowercaseSha256(
    claimed,
    "Anatomy Fit manifest definitionSha256",
  );
  if (definitionSha256 !== (await canonicalRecipeSha256(payload))) {
    fail("definitionSha256 does not match canonical content");
  }
  return { ...payload, definitionSha256 };
}

export function requireAnatomyFitStateDefinition(
  definition: AnatomyFitManifestDefinition,
  state: AnatomyFitState,
) {
  if (state.definitionSha256 !== definition.definitionSha256) {
    fail("state targets a different Anatomy Fit definition");
  }
  const declared = new Set(definition.domains.map(anatomyFitManifestDomainId));
  const actual = state.fits.map((entry) => entry.result.domain);
  if (actual.length !== declared.size || actual.some((entry) => !declared.has(entry))) {
    fail("state must contain exactly one fit for every declared domain");
  }
  return state;
}
