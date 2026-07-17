export type RecipeCanonicalPrimitive = null | boolean | number | string;
export type RecipeCanonicalValue =
  | RecipeCanonicalPrimitive
  | RecipeCanonicalValue[]
  | { [key: string]: RecipeCanonicalValue };

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function canonicalizationError(path: string, reason: string): never {
  throw new Error(`Recipe canonicalization rejected ${path}: ${reason}`);
}

function serializeCanonicalValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      canonicalizationError(path, "numbers must be finite");
    }
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    canonicalizationError(path, `${typeof value} is not a JSON value`);
  }

  if (ancestors.has(value)) {
    canonicalizationError(path, "cyclic values are not supported");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const serialized: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor) {
          canonicalizationError(
            `${path}[${index}]`,
            "sparse arrays are not supported",
          );
        }
        if (!descriptor.enumerable) {
          canonicalizationError(
            `${path}[${index}]`,
            "non-enumerable elements are not supported",
          );
        }
        if (!("value" in descriptor)) {
          canonicalizationError(
            `${path}[${index}]`,
            "accessor elements are not supported",
          );
        }
        serialized.push(
          serializeCanonicalValue(
            descriptor.value,
            `${path}[${index}]`,
            ancestors,
          ),
        );
      }

      const extraKeys = Object.keys(descriptors).filter(
        (key) =>
          key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
      );
      if (extraKeys.length > 0) {
        canonicalizationError(path, "arrays may not contain named properties");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        canonicalizationError(
          path,
          "symbol-keyed properties are not JSON values",
        );
      }
      return `[${serialized.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      canonicalizationError(path, "only plain objects are supported");
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      canonicalizationError(
        path,
        "symbol-keyed properties are not JSON values",
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const serialized: string[] = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) {
        canonicalizationError(
          `${path}.${key}`,
          "non-enumerable properties are not supported",
        );
      }
      if (!("value" in descriptor)) {
        canonicalizationError(
          `${path}.${key}`,
          "accessor properties are not supported",
        );
      }
      serialized.push(
        `${JSON.stringify(key)}:${serializeCanonicalValue(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
        )}`,
      );
    }
    return `{${serialized.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serialize JSON-compatible Recipe data with recursively sorted object keys.
 * Arrays retain their declared order because order is semantic in Recipe data.
 */
export function canonicalRecipeString(value: unknown): string {
  return serializeCanonicalValue(value, "$", new Set<object>());
}

export function canonicalRecipeUtf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalRecipeString(value));
}

export function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && LOWERCASE_SHA256.test(value);
}

export function requireLowercaseSha256(
  value: unknown,
  path = "sha256",
): string {
  if (!isLowercaseSha256(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  }
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value.buffer instanceof ArrayBuffer
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : Uint8Array.from(value);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function canonicalRecipeSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalRecipeUtf8(value));
}
