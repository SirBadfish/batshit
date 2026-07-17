const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

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

function createMigrationRedisService(records, ttlByKey = {}) {
  const state = new Map(Object.entries(records));
  const client = {
    isOpen: true,
    async *scanIterator() {
      yield Array.from(state.keys());
    },
    json: {
      get: jest.fn(async (key) => state.get(key) ?? null)
    },
    pTTL: jest.fn(async (key) => ttlByKey[key] ?? -1),
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
  return { client, state };
}

describe('fileBackedUploadService', () => {
  let uploadRoot;

  beforeEach(async () => {
    uploadRoot = await createTempUploadRoot();
  });

  afterEach(async () => {
    await fs.rm(uploadRoot, { recursive: true, force: true });
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
});
