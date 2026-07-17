const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Unzip, UnzipInflate } = require('fflate');

const RECIPE_ARCHIVE_CONTRACT = 'recipe-archive-extraction/v1';
const RECIPE_ARCHIVE_EXTRACTOR_ID = 'batshit-server-recipe-archive';
const RECIPE_ARCHIVE_EXTRACTOR_VERSION = 1;
const RECIPE_ARCHIVE_MEMBER_PATHS = ['avatar.json', 'avatar.glb'];

class RecipeArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecipeArchiveError';
    this.statusCode = 400;
  }
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fsSync.createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function exactRecipeMemberPath(value) {
  if (typeof value !== 'string' || !RECIPE_ARCHIVE_MEMBER_PATHS.includes(value)) {
    throw new RecipeArchiveError(
      'Recipe package must contain exactly the two root files avatar.glb and avatar.json.'
    );
  }
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.includes('../') ||
    value.includes('//')
  ) {
    throw new RecipeArchiveError('Recipe package contains an unsafe archive entry path.');
  }
  return value;
}

function decodeManifestStrict(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RecipeArchiveError('Recipe avatar.json must be strict UTF-8.');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return { text, parsed };
  } catch {
    throw new RecipeArchiveError('Recipe avatar.json must contain a JSON object.');
  }
}

function createOutputState(outputDir, memberPath) {
  const suffix = memberPath === 'avatar.json' ? '.json' : '.glb';
  const tempPath = path.join(outputDir, `${crypto.randomUUID()}${suffix}.extracting`);
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  return {
    memberPath,
    tempPath,
    hash: crypto.createHash('sha256'),
    bytes: 0,
    handlePromise: fs.open(tempPath, 'wx'),
    writeChain: Promise.resolve(),
    done,
    resolveDone,
    rejectDone,
    finished: false
  };
}

async function cleanupOutputs(outputs) {
  await Promise.all(
    [...outputs.values()].map(async (output) => {
      try {
        const handle = await output.handlePromise;
        await handle.close().catch(() => {});
      } catch {
        // The file may not have opened before validation failed.
      }
      await fs.rm(output.tempPath, { force: true }).catch(() => {});
    })
  );
}

async function inspectAndExtractRecipeArchive({
  archivePath,
  outputDir,
  maxArchiveBytes,
  maxModelBytes,
  maxManifestBytes,
  maxTotalUncompressedBytes,
  maxExpansionRatio = 20
}) {
  const resolvedArchivePath = path.resolve(archivePath);
  const resolvedOutputDir = path.resolve(outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });

  const archive = await hashFile(resolvedArchivePath);
  if (archive.bytes < 1 || archive.bytes > maxArchiveBytes) {
    throw new RecipeArchiveError('Recipe package exceeds the allowed archive size.');
  }

  const outputs = new Map();
  const caseFoldedNames = new Set();
  let totalUncompressedBytes = 0;
  let firstError = null;

  const fail = (error) => {
    if (!firstError) {
      firstError = error instanceof RecipeArchiveError
        ? error
        : new RecipeArchiveError(error instanceof Error ? error.message : String(error));
    }
  };

  const unzipper = new Unzip((file) => {
    try {
      const memberPath = exactRecipeMemberPath(file.name);
      const caseFolded = memberPath.toLowerCase();
      if (caseFoldedNames.has(caseFolded)) {
        throw new RecipeArchiveError(`Recipe package contains duplicate member ${memberPath}.`);
      }
      caseFoldedNames.add(caseFolded);

      const memberLimit = memberPath === 'avatar.json' ? maxManifestBytes : maxModelBytes;
      if (file.originalSize !== undefined && file.originalSize > memberLimit) {
        throw new RecipeArchiveError(`${memberPath} exceeds the allowed extracted size.`);
      }
      if (
        file.originalSize !== undefined &&
        file.size !== undefined &&
        file.size > 0 &&
        file.originalSize / file.size > maxExpansionRatio
      ) {
        throw new RecipeArchiveError(`${memberPath} exceeds the allowed expansion ratio.`);
      }

      const output = createOutputState(resolvedOutputDir, memberPath);
      outputs.set(memberPath, output);
      file.ondata = (error, data, final) => {
        if (error) {
          fail(error);
          output.rejectDone(firstError);
          return;
        }
        if (firstError) return;
        try {
          if (data?.length) {
            output.bytes += data.length;
            totalUncompressedBytes += data.length;
            if (output.bytes > memberLimit) {
              throw new RecipeArchiveError(`${memberPath} exceeds the allowed extracted size.`);
            }
            if (totalUncompressedBytes > maxTotalUncompressedBytes) {
              throw new RecipeArchiveError('Recipe package expands beyond the allowed total size.');
            }
            output.hash.update(data);
            output.writeChain = output.writeChain.then(async () => {
              const handle = await output.handlePromise;
              await handle.write(data);
            });
          }
          if (final && !output.finished) {
            output.finished = true;
            output.writeChain
              .then(async () => {
                const handle = await output.handlePromise;
                await handle.close();
                output.resolveDone();
              })
              .catch((writeError) => {
                fail(writeError);
                output.rejectDone(firstError);
              });
          }
        } catch (streamError) {
          fail(streamError);
          output.rejectDone(firstError);
          file.terminate();
        }
      };
      file.start();
    } catch (error) {
      fail(error);
      throw firstError;
    }
  });
  unzipper.register(UnzipInflate);

  try {
    for await (const chunk of fsSync.createReadStream(resolvedArchivePath, {
      highWaterMark: 64 * 1024
    })) {
      if (firstError) throw firstError;
      unzipper.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      await Promise.all([...outputs.values()].map((output) => output.writeChain));
    }
    if (firstError) throw firstError;
    unzipper.push(new Uint8Array(0), true);
    if (firstError) throw firstError;
    await Promise.all([...outputs.values()].map((output) => output.done));
    if (firstError) throw firstError;

    if (
      outputs.size !== 2 ||
      !outputs.has('avatar.json') ||
      !outputs.has('avatar.glb')
    ) {
      throw new RecipeArchiveError(
        'Recipe package must contain exactly avatar.glb and avatar.json at the archive root.'
      );
    }
    if (totalUncompressedBytes / archive.bytes > maxExpansionRatio) {
      throw new RecipeArchiveError('Recipe package exceeds the allowed total expansion ratio.');
    }

    const manifestOutput = outputs.get('avatar.json');
    const modelOutput = outputs.get('avatar.glb');
    const manifestBytes = await fs.readFile(manifestOutput.tempPath);
    const manifest = decodeManifestStrict(manifestBytes);
    const modelHeader = Buffer.alloc(4);
    const modelHandle = await fs.open(modelOutput.tempPath, 'r');
    try {
      const { bytesRead } = await modelHandle.read(modelHeader, 0, 4, 0);
      if (bytesRead !== 4 || modelHeader.toString('ascii') !== 'glTF') {
        throw new RecipeArchiveError('Recipe avatar.glb does not have a valid GLB signature.');
      }
    } finally {
      await modelHandle.close();
    }

    const members = [manifestOutput, modelOutput]
      .map((output) => ({
        role: output.memberPath === 'avatar.json' ? 'manifest' : 'model',
        path: output.memberPath,
        tempPath: output.tempPath,
        sha256: output.hash.digest('hex'),
        bytes: output.bytes
      }))
      .sort((left, right) => left.role.localeCompare(right.role));

    return {
      contract: RECIPE_ARCHIVE_CONTRACT,
      extractor: {
        id: RECIPE_ARCHIVE_EXTRACTOR_ID,
        version: RECIPE_ARCHIVE_EXTRACTOR_VERSION
      },
      archive: {
        path: resolvedArchivePath,
        sha256: archive.sha256,
        bytes: archive.bytes
      },
      entryCount: 2,
      totalUncompressedBytes,
      members,
      manifestText: manifest.text,
      manifest: manifest.parsed
    };
  } catch (error) {
    await cleanupOutputs(outputs);
    if (error instanceof RecipeArchiveError) throw error;
    throw new RecipeArchiveError('Recipe package could not be safely extracted.');
  }
}

module.exports = {
  RECIPE_ARCHIVE_CONTRACT,
  RECIPE_ARCHIVE_EXTRACTOR_ID,
  RECIPE_ARCHIVE_EXTRACTOR_VERSION,
  RECIPE_ARCHIVE_MEMBER_PATHS,
  RecipeArchiveError,
  decodeManifestStrict,
  exactRecipeMemberPath,
  hashFile,
  inspectAndExtractRecipeArchive,
  sha256Buffer
};
