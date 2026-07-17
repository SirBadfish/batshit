import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";

export const RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT =
  "recipe-archive-containment-receipt/v1" as const;
export const RECIPE_ARCHIVE_EXTRACTOR_ID =
  "batshit-server-recipe-archive" as const;
export const RECIPE_ARCHIVE_EXTRACTOR_VERSION = 1 as const;

export type RecipeStoredAssetRef = {
  ref: string;
  sha256: string;
  bytes: number;
};

export type RecipeArchiveMemberReceipt = {
  role: "manifest" | "model";
  path: "avatar.json" | "avatar.glb";
  sha256: string;
  bytes: number;
  extracted: RecipeStoredAssetRef;
};

export type RecipeArchiveContainmentReceiptContent = {
  contract: typeof RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT;
  archiveFormat: "zip";
  extractor: {
    id: typeof RECIPE_ARCHIVE_EXTRACTOR_ID;
    version: typeof RECIPE_ARCHIVE_EXTRACTOR_VERSION;
  };
  archive: RecipeStoredAssetRef;
  entryCount: 2;
  totalUncompressedBytes: number;
  members: [RecipeArchiveMemberReceipt, RecipeArchiveMemberReceipt];
};

export type RecipeArchiveContainmentReceipt =
  RecipeArchiveContainmentReceiptContent & {
    receiptSha256: string;
  };

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`[${RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT}] ${path} ${message}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(path, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function safeBytes(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, "must be a positive safe integer");
  }
  return value as number;
}

function canonicalUploadRef(value: unknown, path: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    fail(path, "must be a canonical /uploads/... path");
  }
  if (
    !/^\/uploads\/[A-Za-z0-9._-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
      value,
    ) ||
    value.includes("..")
  ) {
    fail(path, "must be a canonical /uploads/... path");
  }
  return value;
}

export function parseRecipeStoredAssetRef(
  value: unknown,
  path = "stored asset",
): RecipeStoredAssetRef {
  const raw = record(value, path);
  exactKeys(raw, ["ref", "sha256", "bytes"], path);
  return {
    ref: canonicalUploadRef(raw.ref, `${path}.ref`),
    sha256: requireLowercaseSha256(raw.sha256, `${path}.sha256`),
    bytes: safeBytes(raw.bytes, `${path}.bytes`),
  };
}

function parseMember(
  value: unknown,
  index: number,
): RecipeArchiveMemberReceipt {
  const path = `receipt.members[${index}]`;
  const raw = record(value, path);
  exactKeys(raw, ["role", "path", "sha256", "bytes", "extracted"], path);
  const role = raw.role;
  if (role !== "manifest" && role !== "model") {
    fail(`${path}.role`, "must be manifest or model");
  }
  const expectedPath = role === "manifest" ? "avatar.json" : "avatar.glb";
  if (raw.path !== expectedPath) {
    fail(`${path}.path`, `must equal ${expectedPath}`);
  }
  const sha256 = requireLowercaseSha256(raw.sha256, `${path}.sha256`);
  const bytes = safeBytes(raw.bytes, `${path}.bytes`);
  const extracted = parseRecipeStoredAssetRef(raw.extracted, `${path}.extracted`);
  if (extracted.sha256 !== sha256 || extracted.bytes !== bytes) {
    fail(path, "extracted bytes must match the exact archive member");
  }
  return { role, path: expectedPath, sha256, bytes, extracted };
}

export function parseRecipeArchiveContainmentReceipt(
  value: unknown,
): RecipeArchiveContainmentReceipt {
  canonicalRecipeString(value);
  const raw = record(value, "receipt");
  exactKeys(
    raw,
    [
      "contract",
      "archiveFormat",
      "extractor",
      "archive",
      "entryCount",
      "totalUncompressedBytes",
      "members",
      "receiptSha256",
    ],
    "receipt",
  );
  if (raw.contract !== RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT) {
    fail("receipt.contract", `must equal ${RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT}`);
  }
  if (raw.archiveFormat !== "zip") {
    fail("receipt.archiveFormat", "must equal zip");
  }
  const extractor = record(raw.extractor, "receipt.extractor");
  exactKeys(extractor, ["id", "version"], "receipt.extractor");
  if (
    extractor.id !== RECIPE_ARCHIVE_EXTRACTOR_ID ||
    extractor.version !== RECIPE_ARCHIVE_EXTRACTOR_VERSION
  ) {
    fail("receipt.extractor", "is unsupported");
  }
  if (raw.entryCount !== 2) {
    fail("receipt.entryCount", "must equal 2");
  }
  if (!Array.isArray(raw.members) || raw.members.length !== 2) {
    fail("receipt.members", "must contain exactly two entries");
  }
  const members = raw.members.map((member, index) =>
    parseMember(member, index),
  ) as [RecipeArchiveMemberReceipt, RecipeArchiveMemberReceipt];
  if (members[0].role !== "manifest" || members[1].role !== "model") {
    fail("receipt.members", "must be sorted as manifest then model");
  }
  const totalUncompressedBytes = safeBytes(
    raw.totalUncompressedBytes,
    "receipt.totalUncompressedBytes",
  );
  if (
    totalUncompressedBytes !== members[0].bytes + members[1].bytes
  ) {
    fail("receipt.totalUncompressedBytes", "does not match the member inventory");
  }
  const archive = parseRecipeStoredAssetRef(raw.archive, "receipt.archive");
  const refs = [archive.ref, ...members.map((member) => member.extracted.ref)];
  if (new Set(refs).size !== refs.length) {
    fail("receipt", "archive and extracted refs must be distinct");
  }
  return {
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: "zip",
    extractor: {
      id: RECIPE_ARCHIVE_EXTRACTOR_ID,
      version: RECIPE_ARCHIVE_EXTRACTOR_VERSION,
    },
    archive,
    entryCount: 2,
    totalUncompressedBytes,
    members,
    receiptSha256: requireLowercaseSha256(
      raw.receiptSha256,
      "receipt.receiptSha256",
    ),
  };
}

export async function recipeArchiveContainmentReceiptSha256(
  value: unknown,
): Promise<string> {
  const receipt = parseRecipeArchiveContainmentReceipt(value);
  const { receiptSha256: _receiptSha256, ...content } = receipt;
  return canonicalRecipeSha256(content);
}

export async function createRecipeArchiveContainmentReceipt(
  value: RecipeArchiveContainmentReceiptContent,
): Promise<RecipeArchiveContainmentReceipt> {
  const candidate = {
    ...value,
    receiptSha256: "0".repeat(64),
  };
  const parsed = parseRecipeArchiveContainmentReceipt(candidate);
  parsed.receiptSha256 = await recipeArchiveContainmentReceiptSha256(parsed);
  return parsed;
}

export async function verifyRecipeArchiveContainmentReceipt(
  value: unknown,
): Promise<RecipeArchiveContainmentReceipt> {
  const receipt = parseRecipeArchiveContainmentReceipt(value);
  const actual = await recipeArchiveContainmentReceiptSha256(receipt);
  if (actual !== receipt.receiptSha256) {
    fail(
      "receipt.receiptSha256",
      `mismatch: expected ${receipt.receiptSha256}, got ${actual}`,
    );
  }
  return receipt;
}
