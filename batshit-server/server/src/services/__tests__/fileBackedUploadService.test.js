const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const logger = require('../../utils/logger');

const {
  cleanupAbandonedUploadTemps,
  ensureAofRewriteAfterMigration,
  migrateLegacyBase64Uploads,
  persistFileBackedUpload,
  resolveStoredUploadPath,
  writeVerifiedFileAtomically
} = require('../fileBackedUploadService');

async function createTempUploadRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'batshit-file-uploads-'));
}

function createMigrationRedisService(records, ttlByKey = {}, typeByKey = {}) {
  const state = new Map(Object.entries(records));
  const types = new Map(Object.keys(records).map((key) => [key, typeByKey[key] || 'ReJSON-RL']));
  const ttls = new Map(Object.entries(ttlByKey));
  const client = {
    isOpen: true,
    async *scanIterator() {
      yield Array.from(state.keys());
    },
    type: jest.fn(async (key) => state.has(key) ? types.get(key) : 'none'),
    get: jest.fn(async (key) => state.get(key) ?? null),
    json: {
      get: jest.fn(async (key) => {
        if (!state.has(key)) return null;
        if (types.get(key) !== 'ReJSON-RL') throw new Error('Existing key has wrong Redis type');
        return state.get(key);
      })
    },
    pTTL: jest.fn(async (key) => ttls.get(key) ?? -1),
    info: jest.fn(
      async () =>
        '# Persistence\r\nrun_id:test-run\r\naof_enabled:1\r\naof_rewrites:0\r\naof_rewrite_in_progress:0\r\naof_last_bgrewrite_status:ok\r\n'
    ),
    bgRewriteAof: jest.fn(async () => 'Background append only file rewriting started'),
    eval: jest.fn(async (_script, options) => {
      const key = options.keys[0];
      const payload = state.get(key);
      if (!payload?.base64) return 0;
      if (payload.base64.length !== Number(options.arguments[0])) {
        throw new Error('Legacy upload changed while it was being migrated');
      }
      state.set(key, {
        ...payload,
        storage: JSON.parse(options.arguments[1]),
        relativePath: JSON.parse(options.arguments[2]),
        filePath: JSON.parse(options.arguments[3]),
        size: Number(options.arguments[4]),
        sha256: JSON.parse(options.arguments[5]),
        base64: undefined
      });
      delete state.get(key).base64;
      return 1;
    })
  };
  return { client, state, types, ttls };
}

describe('fileBackedUploadService', () => {
  let uploadRoot;
  let warnings;

  beforeEach(async () => {
    uploadRoot = await createTempUploadRoot();
    warnings = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(async () => {
    await fs.rm(uploadRoot, { recursive: true, force: true });
    warnings.mockRestore();
  });

  test('persists bytes before metadata and never stores Base64 in a persistent record', async () => {
    const setWithTTL = jest.fn(async () => true);
    const redisService = { setWithTTL };
    const buffer = Buffer.from('persistent upload bytes');

    const payload = await persistFileBackedUpload({
      redisService,
      redisKey: 'upload:images:asset.png',
      uploadType: 'images',
      filename: 'asset.png',
      buffer,
      payload: {
        originalName: 'asset.png',
        mimetype: 'image/png',
        base64: buffer.toString('base64')
      },
      uploadRoot
    });

    expect(payload.base64).toBeUndefined();
    expect(payload.storage).toBe('filesystem');
    expect(payload.relativePath).toBe('images/asset.png');
    expect(await fs.readFile(payload.filePath)).toEqual(buffer);
    expect(setWithTTL).toHaveBeenCalledWith(
      'upload:images:asset.png',
      expect.objectContaining({ storage: 'filesystem', relativePath: 'images/asset.png' }),
      0
    );
  });

  test('removes newly written bytes when Redis metadata persistence fails', async () => {
    const redisService = { setWithTTL: jest.fn(async () => false) };
    const filePath = resolveStoredUploadPath('images', 'rollback.png', uploadRoot);

    await expect(
      persistFileBackedUpload({
        redisService,
        redisKey: 'upload:images:rollback.png',
        uploadType: 'images',
        filename: 'rollback.png',
        buffer: Buffer.from('rollback'),
        payload: { mimetype: 'image/png' },
        uploadRoot
      })
    ).rejects.toThrow('Redis rejected file-backed upload metadata');

    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('refuses to overwrite an existing upload with different bytes', async () => {
    const filePath = resolveStoredUploadPath('goon_scenes', 'scene.png', uploadRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'existing');

    await expect(writeVerifiedFileAtomically(filePath, Buffer.from('replacement'))).rejects.toThrow(
      'existing bytes do not match'
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe('existing');
  });

  test('migrates a persistent legacy record idempotently after the file is durable', async () => {
    const source = Buffer.from('legacy binary payload');
    const key = 'upload:goon_custom_models:model.glb';
    const redisService = createMigrationRedisService({
      [key]: {
        originalName: 'model.glb',
        mimetype: 'model/gltf-binary',
        uploadType: 'goon_custom_models',
        size: source.length,
        base64: source.toString('base64')
      }
    });

    const first = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    const migrated = redisService.state.get(key);
    expect(first).toMatchObject({ migrated: 1, bytesMoved: source.length });
    expect(migrated.base64).toBeUndefined();
    expect(migrated.storage).toBe('filesystem');
    expect(migrated.relativePath).toBe('goon_custom_models/model.glb');
    expect(await fs.readFile(migrated.filePath)).toEqual(source);

    const second = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(second.migrated).toBe(0);
  });

  test('leaves TTL-backed and explicitly ephemeral uploads in Redis', async () => {
    const ttlSource = Buffer.from('ttl');
    const explicitSource = Buffer.from('explicit');
    const redisService = createMigrationRedisService(
      {
        'upload:images:ttl.png': {
          filename: 'ttl.png',
          uploadType: 'images',
          size: ttlSource.length,
          base64: ttlSource.toString('base64')
        },
        'upload:images:ephemeral.png': {
          filename: 'ephemeral.png',
          uploadType: 'images',
          size: explicitSource.length,
          base64: explicitSource.toString('base64'),
          ephemeralUpload: true
        }
      },
      { 'upload:images:ttl.png': 30_000 }
    );

    const result = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(result).toMatchObject({ migrated: 0, skippedEphemeral: 2 });
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(redisService.state.get('upload:images:ttl.png').base64).toBeTruthy();
    expect(redisService.state.get('upload:images:ephemeral.png').base64).toBeTruthy();
  });

  test('rejects path traversal before touching disk', () => {
    expect(() => resolveStoredUploadPath('images', '../escape.png', uploadRoot)).toThrow(
      'Invalid upload filename'
    );
    expect(() => resolveStoredUploadPath('../images', 'escape.png', uploadRoot)).toThrow(
      'Invalid upload type'
    );
  });

  test('keeps a durable marker and schedules AOF rewrite after migration', async () => {
    const source = Buffer.from('rewrite me');
    const redisService = createMigrationRedisService({
      'upload:images:rewrite.png': {
        filename: 'rewrite.png',
        uploadType: 'images',
        size: source.length,
        base64: source.toString('base64')
      }
    });
    const migration = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    await expect(fs.stat(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'))).resolves.toBeTruthy();

    await expect(
      ensureAofRewriteAfterMigration({
        redisService,
        migration,
        uploadRoot
      })
    ).resolves.toBe(true);
    expect(redisService.client.bgRewriteAof).toHaveBeenCalledTimes(1);
    redisService.client.isOpen = false;
  });

  test('requires a rewrite that starts after the entire migration pass', async () => {
    const source = Buffer.from('rewrite after migration');
    const redisService = createMigrationRedisService({
      'upload:images:late-rewrite.png': {
        filename: 'late-rewrite.png',
        uploadType: 'images',
        size: source.length,
        base64: source.toString('base64')
      }
    });
    let completedRewrites = 0;
    redisService.client.info.mockImplementation(async (section) =>
      section === 'server'
        ? 'run_id:test-run\r\n'
        : `aof_enabled:1\r\naof_rewrites:${completedRewrites}\r\naof_rewrite_in_progress:0\r\naof_last_bgrewrite_status:ok\r\n`
    );
    const originalEval = redisService.client.eval.getMockImplementation();
    redisService.client.eval.mockImplementation(async (...args) => {
      const result = await originalEval(...args);
      // Simulate an automatic rewrite completing after the first metadata
      // switch but before the migration finishes scanning.
      completedRewrites = 1;
      return result;
    });

    const migration = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    const marker = JSON.parse(
      await fs.readFile(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'), 'utf8')
    );
    expect(marker).toMatchObject({
      migrationComplete: true,
      baselineAofRewrites: 1,
      requiredAofRewrites: 2
    });

    await expect(
      ensureAofRewriteAfterMigration({ redisService, migration, uploadRoot })
    ).resolves.toBe(true);
    expect(redisService.client.bgRewriteAof).toHaveBeenCalledTimes(1);
    redisService.client.isOpen = false;
  });

  test('does not compact an incomplete interrupted migration', async () => {
    const source = Buffer.from('interrupt after switch');
    const redisService = createMigrationRedisService({
      'upload:images:interrupted.png': {
        filename: 'interrupted.png',
        uploadType: 'images',
        size: source.length,
        base64: source.toString('base64')
      }
    });
    let shouldStop = false;
    const originalEval = redisService.client.eval.getMockImplementation();
    redisService.client.eval.mockImplementation(async (...args) => {
      const result = await originalEval(...args);
      shouldStop = true;
      return result;
    });
    redisService.client.scanIterator = async function* () {
      yield ['upload:images:interrupted.png'];
      yield ['upload:images:not-reached.png'];
    };

    const migration = await migrateLegacyBase64Uploads({
      redisService,
      uploadRoot,
      shouldStop: () => shouldStop
    });
    expect(migration.interrupted).toBe(true);
    const marker = JSON.parse(
      await fs.readFile(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'), 'utf8')
    );
    expect(marker.migrationComplete).toBe(false);

    await expect(
      ensureAofRewriteAfterMigration({ redisService, migration, uploadRoot })
    ).resolves.toBe(false);
    expect(redisService.client.bgRewriteAof).not.toHaveBeenCalled();
  });

  test('removes only abandoned exact upload temp files', async () => {
    const familyDir = path.join(uploadRoot, 'images');
    await fs.mkdir(familyDir, { recursive: true });
    const abandoned = path.join(familyDir, '.asset.png.999999.0123456789abcdef.tmp');
    const malformed = path.join(familyDir, '.asset.png.tmp');
    await fs.writeFile(abandoned, 'partial');
    await fs.writeFile(malformed, 'keep');

    await expect(cleanupAbandonedUploadTemps(uploadRoot)).resolves.toEqual([abandoned]);
    await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(malformed, 'utf8')).resolves.toBe('keep');
  });

  test('rebases pending AOF rewrite counters after Redis restarts', async () => {
    await fs.writeFile(
      path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'),
      JSON.stringify({
        redisRunId: 'old-run',
        baselineAofRewrites: 42,
        requiredAofRewrites: 43
      })
    );
    const client = {
      isOpen: true,
      info: jest.fn(
        async () =>
          'run_id:new-run\r\naof_enabled:1\r\naof_rewrites:0\r\naof_rewrite_in_progress:0\r\naof_last_bgrewrite_status:ok\r\n'
      ),
      bgRewriteAof: jest.fn(async () => 'started')
    };

    await expect(
      ensureAofRewriteAfterMigration({
        redisService: { client },
        migration: { migrated: 0 },
        uploadRoot
      })
    ).resolves.toBe(true);
    const marker = JSON.parse(
      await fs.readFile(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'), 'utf8')
    );
    expect(marker).toMatchObject({
      redisRunId: 'new-run',
      baselineAofRewrites: 0,
      requiredAofRewrites: 1
    });
    expect(client.bgRewriteAof).toHaveBeenCalledTimes(1);
    client.isOpen = false;
  });

  test('migrates eligible JSON while preserving string records, raw types and expiry', async () => {
    const source = Buffer.from('eligible bytes');
    const jsonKey = 'upload:images:eligible.png';
    const stringKey = 'upload:images:inline.png';
    const fileStringKey = 'upload:images:retained.png';
    const hashKey = 'upload:images:unexpected.png';
    const filePath = resolveStoredUploadPath('images', 'retained.png', uploadRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'retained file');
    const inline = JSON.stringify({ base64: 'aW5saW5l', mimetype: 'image/png' });
    const fileString = JSON.stringify({ storage: 'filesystem', relativePath: 'images/retained.png', filePath });
    const redisService = createMigrationRedisService({
      [jsonKey]: { filename: 'eligible.png', uploadType: 'images', size: source.length, base64: source.toString('base64') },
      [stringKey]: inline,
      [fileStringKey]: fileString,
      [hashKey]: { privateField: 'synthetic value' }
    }, { [stringKey]: 30_000, [hashKey]: 45_000 }, {
      [stringKey]: 'string', [fileStringKey]: 'string', [hashKey]: 'hash'
    });
    const retained = [stringKey, fileStringKey, hashKey].map((key) => [key, redisService.state.get(key)]);
    const ttls = Array.from(redisService.ttls);
    const result = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(result).toMatchObject({ migrated: 1, bytesMoved: source.length, retainedNonJson: 3,
      retainedNonJsonByType: { string: 2, hash: 1, other: 0 } });
    for (const [key, value] of retained) expect(redisService.state.get(key)).toEqual(value);
    expect(redisService.types.get(stringKey)).toBe('string');
    expect(redisService.types.get(hashKey)).toBe('hash');
    expect(Array.from(redisService.ttls)).toEqual(ttls);
    expect(redisService.client.json.get.mock.calls).toEqual([[jsonKey]]);
    expect(redisService.client.pTTL.mock.calls).toEqual([[jsonKey]]);
    expect(redisService.client.get).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, 'utf8')).toBe('retained file');
    expect(await fs.readFile(redisService.state.get(jsonKey).filePath)).toEqual(source);
    const marker = JSON.parse(await fs.readFile(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'), 'utf8'));
    expect(marker.migrationComplete).toBe(true);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test('warns once with bounded type counts when every record is non-JSON and nothing migrates', async () => {
    const typeNames = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'private-module-type'];
    const records = {}, types = {}, ttls = {};
    for (const [index, type] of typeNames.entries()) {
      const key = `upload:images:${'private-key-'.repeat(1000)}${index}`;
      records[key] = 'synthetic private value'; types[key] = type; ttls[key] = 40_000 + index;
    }
    const redisService = createMigrationRedisService(records, ttls, types);
    const result = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(result).toMatchObject({ migrated: 0, retainedNonJson: 7,
      retainedNonJsonByType: { string: 1, hash: 1, list: 1, set: 1, zset: 1, stream: 1, other: 1 } });
    expect(Object.fromEntries(redisService.state)).toEqual(records);
    expect(Object.fromEntries(redisService.types)).toEqual(types);
    expect(Object.fromEntries(redisService.ttls)).toEqual(ttls);
    expect(redisService.client.json.get).not.toHaveBeenCalled();
    expect(redisService.client.get).not.toHaveBeenCalled();
    expect(redisService.client.pTTL).not.toHaveBeenCalled();
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadRoot)).toEqual([]);
    expect(warnings).toHaveBeenCalledTimes(1);
    const message = warnings.mock.calls[0][0];
    expect(warnings.mock.calls[0]).toHaveLength(1);
    expect(message).toContain('Retained 7 non-JSON upload record(s)');
    expect(message).toContain('types={"string":1,"hash":1,"list":1,"set":1,"zset":1,"stream":1,"other":1}');
    expect(message.length).toBeLessThan(512);
    expect(message).not.toContain('private-key');
    expect(message).not.toContain('private value');
    expect(message).not.toContain('private-module-type');
  });

  test('ignores a key that vanished before its TYPE read without a warning', async () => {
    const redisService = createMigrationRedisService({});
    redisService.client.scanIterator = async function* () { yield 'upload:images:vanished.png'; };
    const result = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(result).toMatchObject({ scanned: 1, migrated: 0 });
    expect(redisService.client.json.get).not.toHaveBeenCalled();
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  test('keeps the existing absent-record outcome when JSON disappears after TYPE', async () => {
    const key = 'upload:images:vanishing.png';
    const redisService = createMigrationRedisService({ [key]: { base64: 'aGVsbG8=' } });
    redisService.client.type.mockImplementation(async () => {
      redisService.state.delete(key); redisService.types.delete(key); return 'ReJSON-RL';
    });
    const result = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(result).toMatchObject({ scanned: 1, migrated: 0 });
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadRoot)).toEqual([]);
  });

  test('propagates a JSON-to-string race instead of interpreting a failed read as retention', async () => {
    const key = 'upload:images:changed.png';
    const redisService = createMigrationRedisService({ [key]: { base64: 'aGVsbG8=' } });
    redisService.client.type.mockImplementation(async () => {
      redisService.state.set(key, 'new string'); redisService.types.set(key, 'string'); return 'ReJSON-RL';
    });
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toThrow('Existing key has wrong Redis type');
    expect(redisService.state.get(key)).toBe('new string');
    expect(redisService.client.get).not.toHaveBeenCalled();
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  test('leaves a string-to-JSON race untouched and migrates it on the next scan', async () => {
    const key = 'upload:images:later.png';
    const source = Buffer.from('later bytes');
    const payload = { filename: 'later.png', uploadType: 'images', size: source.length, base64: source.toString('base64') };
    const redisService = createMigrationRedisService({ [key]: 'old string' }, {}, { [key]: 'string' });
    redisService.client.type.mockImplementationOnce(async () => {
      redisService.state.set(key, payload); redisService.types.set(key, 'ReJSON-RL'); return 'string';
    });
    const first = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(first).toMatchObject({ migrated: 0, retainedNonJson: 1 });
    expect(redisService.state.get(key)).toEqual(payload);
    expect(redisService.client.json.get).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadRoot)).toEqual([]);
    const second = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(second.migrated).toBe(1);
    expect(await fs.readFile(redisService.state.get(key).filePath)).toEqual(source);
  });

  test('propagates a TYPE failure without reading or changing its record', async () => {
    const key = 'upload:images:type-failure.png';
    const payload = { base64: 'aGVsbG8=' };
    const redisService = createMigrationRedisService({ [key]: payload });
    const failure = new Error('owned TYPE failure');
    redisService.client.type.mockRejectedValue(failure);
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBe(failure);
    expect(redisService.state.get(key)).toEqual(payload);
    expect(redisService.client.json.get).not.toHaveBeenCalled();
    expect(redisService.client.eval).not.toHaveBeenCalled();
  });

  test.each([null, 7])('rejects an invalid TYPE reply %p instead of treating it as another storage type', async (reply) => {
    const redisService = createMigrationRedisService({ 'upload:images:invalid-type.png': { base64: 'aGVsbG8=' } });
    redisService.client.type.mockResolvedValue(reply);
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toThrow('Unexpected Redis type reply');
    expect(redisService.client.json.get).not.toHaveBeenCalled();
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  test('propagates a JSON read failure and preserves an incomplete compaction marker', async () => {
    const key = 'upload:images:read-failure.png';
    const redisService = createMigrationRedisService({ [key]: { base64: 'aGVsbG8=' } });
    const markerPath = path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json');
    const marker = JSON.stringify({ migrationComplete: false, redisRunId: 'test-run' });
    await fs.writeFile(markerPath, marker);
    const failure = new Error('owned JSON read failure');
    redisService.client.json.get.mockRejectedValue(failure);
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBe(failure);
    expect(await fs.readFile(markerPath, 'utf8')).toBe(marker);
    expect(redisService.client.get).not.toHaveBeenCalled();
    expect(redisService.client.eval).not.toHaveBeenCalled();
  });

  test('fails on a genuine file collision after a retained string and leaves the pass incomplete', async () => {
    const stringKey = 'upload:images:retained-string.png';
    const key = 'upload:images:collision.png';
    const payload = { filename: 'collision.png', uploadType: 'images', size: 5, base64: Buffer.from('later').toString('base64') };
    const redisService = createMigrationRedisService({ [stringKey]: 'unchanged string', [key]: payload }, {}, { [stringKey]: 'string' });
    const markerPath = path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json');
    const marker = JSON.stringify({ migrationComplete: false, redisRunId: 'test-run' });
    await fs.writeFile(markerPath, marker);
    const filePath = resolveStoredUploadPath('images', 'collision.png', uploadRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, 'original');
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toThrow('existing bytes do not match');
    expect(await fs.readFile(filePath, 'utf8')).toBe('original');
    expect(await fs.readFile(markerPath, 'utf8')).toBe(marker);
    expect(redisService.state.get(stringKey)).toBe('unchanged string');
    expect(redisService.state.get(key)).toEqual(payload);
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test('propagates a Lua failure, removes newly created bytes and keeps the marker incomplete', async () => {
    const key = 'upload:images:lua-failure.png';
    const payload = { filename: 'lua-failure.png', uploadType: 'images', size: 5, base64: 'aGVsbG8=' };
    const redisService = createMigrationRedisService({ [key]: payload });
    const failure = new Error('owned Lua failure'); redisService.client.eval.mockRejectedValue(failure);
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBe(failure);
    expect(redisService.state.get(key)).toEqual(payload);
    await expect(fs.stat(resolveStoredUploadPath('images', 'lua-failure.png', uploadRoot))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'), 'utf8')).migrationComplete).toBe(false);
  });

  test('propagates a genuine atomic file write failure without switching its record', async () => {
    const key = 'upload:images:write-failure.png';
    const payload = { filename: 'write-failure.png', uploadType: 'images', size: 5, base64: 'aGVsbG8=' };
    const redisService = createMigrationRedisService({ [key]: payload });
    const failure = Object.assign(new Error('owned file write failure'), { code: 'EIO' });
    const link = jest.spyOn(fs, 'link').mockRejectedValue(failure);
    try { await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBe(failure); }
    finally { link.mockRestore(); }
    expect(redisService.state.get(key)).toEqual(payload);
    expect(redisService.client.eval).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(uploadRoot, 'images'))).toEqual([]);
    await expect(fs.stat(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('propagates marker publication failure before switching JSON metadata', async () => {
    const key = 'upload:images:marker-failure.png';
    const payload = { filename: 'marker-failure.png', uploadType: 'images', size: 5, base64: 'aGVsbG8=' };
    const redisService = createMigrationRedisService({ [key]: payload });
    const failure = Object.assign(new Error('owned marker publication failure'), { code: 'EIO' });
    const rename = jest.spyOn(fs, 'rename').mockRejectedValue(failure);
    try { await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBe(failure); }
    finally { rename.mockRestore(); }
    expect(redisService.state.get(key)).toEqual(payload);
    expect(redisService.client.eval).not.toHaveBeenCalled();
    await expect(fs.stat(resolveStoredUploadPath('images', 'marker-failure.png', uploadRoot))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not complete a pending marker when the final Redis info read fails', async () => {
    const key = 'upload:images:completion-failure.png';
    const redisService = createMigrationRedisService({ [key]: {
      filename: 'completion-failure.png', uploadType: 'images', size: 5, base64: 'aGVsbG8='
    } });
    const markerPath = path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json');
    const marker = JSON.stringify({ migrationComplete: false, redisRunId: 'test-run' });
    await fs.writeFile(markerPath, marker);
    const failure = new Error('owned marker completion read failure'); redisService.client.info.mockRejectedValue(failure);
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBe(failure);
    expect(redisService.state.get(key).storage).toBe('filesystem');
    expect(await fs.readFile(redisService.state.get(key).filePath, 'utf8')).toBe('hello');
    expect(await fs.readFile(markerPath, 'utf8')).toBe(marker);
  });

  test('propagates an unreadable marker instead of marking a retained-only pass complete', async () => {
    const key = 'upload:images:retained-only.png';
    const redisService = createMigrationRedisService({ [key]: 'unchanged' }, {}, { [key]: 'string' });
    const markerPath = path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json');
    await fs.writeFile(markerPath, 'invalid marker JSON');
    await expect(migrateLegacyBase64Uploads({ redisService, uploadRoot })).rejects.toBeInstanceOf(SyntaxError);
    expect(await fs.readFile(markerPath, 'utf8')).toBe('invalid marker JSON');
    expect(redisService.state.get(key)).toBe('unchanged');
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test('a complete compaction marker never prevents a later eligible record from migration', async () => {
    const firstKey = 'upload:images:first.png', secondKey = 'upload:images:second.png', stringKey = 'upload:images:retained.png';
    const legacy = (filename) => ({ filename, uploadType: 'images', size: 5, base64: 'aGVsbG8=' });
    const redisService = createMigrationRedisService({ [firstKey]: legacy('first.png'), [stringKey]: 'unchanged' }, {}, { [stringKey]: 'string' });
    await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    const markerPath = path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json');
    expect(JSON.parse(await fs.readFile(markerPath, 'utf8')).migrationComplete).toBe(true);
    redisService.state.set(secondKey, legacy('second.png')); redisService.types.set(secondKey, 'ReJSON-RL');
    const second = await migrateLegacyBase64Uploads({ redisService, uploadRoot });
    expect(second).toMatchObject({ migrated: 1, retainedNonJson: 1 });
    expect(await fs.readFile(redisService.state.get(secondKey).filePath, 'utf8')).toBe('hello');
    expect(redisService.state.get(stringKey)).toBe('unchanged');
    expect(JSON.parse(await fs.readFile(markerPath, 'utf8')).migrationComplete).toBe(true);
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  test('an interrupted pass reports retained types once without completing its marker', async () => {
    const firstKey = 'upload:images:retained.png', secondKey = 'upload:images:not-reached.png';
    const redisService = createMigrationRedisService({ [firstKey]: 'unchanged', [secondKey]: { base64: 'aGVsbG8=' } }, {}, { [firstKey]: 'string' });
    const markerPath = path.join(uploadRoot, '.file-backed-upload-aof-rewrite.json');
    const marker = JSON.stringify({ migrationComplete: false, redisRunId: 'test-run' });
    await fs.writeFile(markerPath, marker);
    let stop = false;
    const originalType = redisService.client.type.getMockImplementation();
    redisService.client.type.mockImplementation(async (key) => { const type = await originalType(key); stop = true; return type; });
    const result = await migrateLegacyBase64Uploads({ redisService, uploadRoot, shouldStop: () => stop });
    expect(result).toMatchObject({ interrupted: true, migrated: 0, retainedNonJson: 1 });
    expect(await fs.readFile(markerPath, 'utf8')).toBe(marker);
    expect(redisService.client.json.get).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});
