const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  AvatarOwnerDeleteRequestError,
  parseAvatarOwnerDeleteRequest,
  sweepOwnedAvatars
} = require('../avatarOwnerSweep');

/**
 * BL-41: deleting an agent sweeps every avatar picture the upload route ever stored for it,
 * and nothing else. The fake client below keeps real node-redis 5 shapes: `scanIterator`
 * yields ARRAYS of keys (one per SCAN reply), `json.get` answers null for a missing key, and
 * `del` answers the number of keys removed. MATCH supports the only wildcard the sweep uses
 * (`*`); the sweep never builds a pattern with any other glob character, because the owner
 * id is validated to `[A-Za-z0-9_-]` first (pinned by the parser tests below).
 */
function createFakeRedis(records) {
  const store = new Map(Object.entries(records));
  const matchToRegExp = (match) =>
    new RegExp(
      `^${match
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
    );
  return {
    store,
    isOpen: true,
    scanIterator: jest.fn(async function* ({ MATCH }) {
      const matched = [...store.keys()].filter((key) => matchToRegExp(MATCH).test(key));
      // Two keys per reply, so the sweep has to walk more than one batch.
      for (let index = 0; index < matched.length; index += 2) {
        yield matched.slice(index, index + 2);
      }
    }),
    json: {
      get: jest.fn(async (key) => (store.has(key) ? structuredClone(store.get(key)) : null))
    },
    del: jest.fn(async (key) => (store.delete(key) ? 1 : 0))
  };
}

let uploadRoot;

async function writeUpload(relativePath, bytes = 'jpg') {
  const filePath = path.join(uploadRoot, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return filePath;
}

async function exists(relativePath) {
  try {
    await fs.lstat(path.join(uploadRoot, ...relativePath.split('/')));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function avatarRecord(filename, owner = {}) {
  return {
    originalName: 'picked.png',
    mimetype: 'image/jpeg',
    size: 3,
    uploadType: 'avatars',
    uploadedAt: '2026-09-22T12:00:00.000Z',
    entityType: owner.entityType ?? 'agent',
    entityId: owner.entityId ?? 'unknown',
    storage: 'filesystem',
    relativePath: `avatars/${filename}`,
    filePath: path.join(uploadRoot, 'avatars', filename),
    sha256: 'a'.repeat(64)
  };
}

beforeEach(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-avatar-sweep-'));
});

afterEach(async () => {
  await fs.rm(uploadRoot, { recursive: true, force: true });
});

describe('sweepOwnedAvatars (BL-41)', () => {
  test('deletes every record and file named for the agent, current and replaced, under both key forms, and nothing else', async () => {
    // Real shapes from Josh's native DB0: `n8n_agent` and `n8n_agent_ctrlain` are two agents,
    // so a bare prefix `agent_n8n_agent_` would also take the second one's picture.
    const own = {
      current: 'agent_n8n_agent_1770236491677.jpg',
      replaced: 'agent_n8n_agent_1770236400000.jpg',
      flatKey: 'agent_n8n_agent_1770236300000.jpg',
      unmigrated: 'agent_n8n_agent_1770236200000.jpg',
      orphanFile: 'agent_n8n_agent_1770236100000.jpg'
    };
    const client = createFakeRedis({
      [`upload:avatars:agent:${own.current}`]: avatarRecord(own.current, { entityId: 'n8n_agent' }),
      [`upload:avatars:agent:${own.replaced}`]: avatarRecord(own.replaced, { entityId: 'n8n_agent' }),
      // The serve route reads the flat key first, so a record can live there too.
      [`upload:avatars:${own.flatKey}`]: avatarRecord(own.flatKey, { entityId: 'n8n_agent' }),
      // A legacy Redis/Base64 record the startup migration has not moved: no file, key only.
      [`upload:avatars:agent:${own.unmigrated}`]: {
        originalName: 'old.png',
        mimetype: 'image/jpeg',
        size: 3,
        base64: 'anBn',
        uploadedAt: '2025-09-01T00:00:00.000Z'
      },
      // Everything below belongs to someone else and must stay.
      'upload:avatars:agent:agent_n8n_agent_ctrlain_1775677157367.jpg': avatarRecord(
        'agent_n8n_agent_ctrlain_1775677157367.jpg',
        { entityId: 'n8n_agent_ctrlain' }
      ),
      'upload:avatars:subagent:subagent_n8n_agent_1770000000000.jpg': avatarRecord(
        'subagent_n8n_agent_1770000000000.jpg',
        { entityType: 'subagent', entityId: 'n8n_agent' }
      ),
      'upload:avatars:user:user_josh_1775362752696.jpg': avatarRecord('user_josh_1775362752696.jpg', {
        entityType: 'user',
        entityId: 'josh'
      }),
      'upload:avatars:group:group_new_group_1770000000001.jpg': avatarRecord(
        'group_new_group_1770000000001.jpg',
        { entityType: 'group', entityId: 'new_group' }
      ),
      'upload:avatars:avatar_1754000000000.jpg': avatarRecord('avatar_1754000000000.jpg'),
      'defaults:avatars:agent': { mimetype: 'image/png', base64: 'cG5n' },
      'upload:goon_closet:1770000000002_shirt.png': {
        uploadType: 'goon_closet',
        storage: 'filesystem',
        relativePath: 'goon_closet/1770000000002_shirt.png'
      },
      'upload:memory-media:n8n_agent/mem_1/media_1.png': {
        uploadType: 'memory-media',
        storage: 'filesystem',
        relativePath: 'memory-media/n8n_agent/mem_1/media_1.png'
      }
    });
    for (const filename of [own.current, own.replaced, own.flatKey, own.orphanFile]) {
      await writeUpload(`avatars/${filename}`);
    }
    const kept = [
      'avatars/agent_n8n_agent_ctrlain_1775677157367.jpg',
      'avatars/subagent_n8n_agent_1770000000000.jpg',
      'avatars/user_josh_1775362752696.jpg',
      'avatars/group_new_group_1770000000001.jpg',
      'avatars/avatar_1754000000000.jpg',
      // Named like the agent but not the upload route's shape, and an in-flight temp file.
      'avatars/agent_n8n_agent_backup.jpg',
      'avatars/.agent_n8n_agent_1770236491677.jpg.4242.0123456789abcdef.tmp',
      'goon_closet/1770000000002_shirt.png',
      'memory-media/n8n_agent/mem_1/media_1.png'
    ];
    for (const relativePath of kept) await writeUpload(relativePath);

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'n8n_agent',
      legacyFilenames: []
    });

    expect(result.deletedRecords).toEqual(
      [
        `upload:avatars:${own.flatKey}`,
        `upload:avatars:agent:${own.current}`,
        `upload:avatars:agent:${own.replaced}`,
        `upload:avatars:agent:${own.unmigrated}`
      ].sort()
    );
    expect(result.deletedFiles).toEqual(
      [own.current, own.replaced, own.flatKey, own.orphanFile].map((name) => `avatars/${name}`).sort()
    );
    for (const filename of Object.values(own)) {
      expect(await exists(`avatars/${filename}`)).toBe(false);
    }
    expect([...client.store.keys()].sort()).toEqual(
      [
        'upload:avatars:agent:agent_n8n_agent_ctrlain_1775677157367.jpg',
        'upload:avatars:subagent:subagent_n8n_agent_1770000000000.jpg',
        'upload:avatars:user:user_josh_1775362752696.jpg',
        'upload:avatars:group:group_new_group_1770000000001.jpg',
        'upload:avatars:avatar_1754000000000.jpg',
        'defaults:avatars:agent',
        'upload:goon_closet:1770000000002_shirt.png',
        'upload:memory-media:n8n_agent/mem_1/media_1.png'
      ].sort()
    );
    for (const relativePath of kept) {
      expect(await exists(relativePath)).toBe(true);
    }
    // The scan is scoped to this owner's names, never the whole keyspace.
    expect(client.scanIterator.mock.calls.map(([options]) => options.MATCH).sort()).toEqual([
      'upload:avatars:agent:agent_n8n_agent_*',
      'upload:avatars:agent_n8n_agent_*'
    ]);
  });

  test('deletes the legacy flat pictures the caller names, under both key forms, and keeps every other flat picture', async () => {
    const client = createFakeRedis({
      'upload:avatars:avatar_1754000000000.jpg': avatarRecord('avatar_1754000000000.jpg'),
      'upload:avatars:agent:avatar_1754000000005.jpg': avatarRecord('avatar_1754000000005.jpg'),
      'upload:avatars:avatar_1754000000001.jpg': avatarRecord('avatar_1754000000001.jpg')
    });
    await writeUpload('avatars/avatar_1754000000000.jpg');
    await writeUpload('avatars/avatar_1754000000005.jpg');
    await writeUpload('avatars/avatar_1754000000001.jpg');

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: ['avatar_1754000000000.jpg', 'avatar_1754000000005.jpg']
    });

    expect(result.deletedRecords).toEqual([
      'upload:avatars:agent:avatar_1754000000005.jpg',
      'upload:avatars:avatar_1754000000000.jpg'
    ]);
    expect(result.deletedFiles).toEqual([
      'avatars/avatar_1754000000000.jpg',
      'avatars/avatar_1754000000005.jpg'
    ]);
    expect([...client.store.keys()]).toEqual(['upload:avatars:avatar_1754000000001.jpg']);
    expect(await exists('avatars/avatar_1754000000001.jpg')).toBe(true);
  });

  test('a named legacy picture whose record is already gone still loses its own file', async () => {
    const client = createFakeRedis({});
    await writeUpload('avatars/avatar_1754000000009.jpg');
    await writeUpload('avatars/avatar_1754000000010.jpg');

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: ['avatar_1754000000009.jpg']
    });

    expect(result).toEqual({ deletedRecords: [], deletedFiles: ['avatars/avatar_1754000000009.jpg'] });
    expect(await exists('avatars/avatar_1754000000009.jpg')).toBe(false);
    expect(await exists('avatars/avatar_1754000000010.jpg')).toBe(true);
  });

  test('checks every record before deleting any: one bad record leaves everything in place and is named', async () => {
    const good = ['agent_bob_1770000000001.jpg', 'agent_bob_1770000000003.jpg'];
    const bad = 'agent_bob_1770000000002.jpg';
    // The good record comes first in scan order, so a sweep that checks as it goes would
    // already have deleted it (and its file) when it reaches the bad one.
    const client = createFakeRedis({
      [`upload:avatars:agent:${good[0]}`]: avatarRecord(good[0], { entityId: 'bob' }),
      [`upload:avatars:agent:${bad}`]: {
        ...avatarRecord(bad, { entityId: 'bob' }),
        relativePath: 'avatars/user_josh_1775362752696.jpg',
        filePath: path.join(uploadRoot, 'avatars', 'user_josh_1775362752696.jpg')
      },
      [`upload:avatars:agent:${good[1]}`]: avatarRecord(good[1], { entityId: 'bob' })
    });
    for (const filename of [...good, 'user_josh_1775362752696.jpg', 'agent_bob_1770000000004.jpg']) {
      await writeUpload(`avatars/${filename}`);
    }

    const error = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: []
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`upload:avatars:agent:${bad}`);
    expect(error.message).toMatch(/nothing was deleted/i);
    expect(client.del).not.toHaveBeenCalled();
    expect(client.store.size).toBe(3);
    for (const filename of [...good, 'user_josh_1775362752696.jpg', 'agent_bob_1770000000004.jpg']) {
      expect(await exists(`avatars/${filename}`)).toBe(true);
    }
  });

  test('refuses a record that points at a file other than its own name, and leaves that file and record alone', async () => {
    const client = createFakeRedis({
      'upload:avatars:agent:agent_bob_1770000000000.jpg': {
        ...avatarRecord('agent_bob_1770000000000.jpg', { entityId: 'bob' }),
        relativePath: 'avatars/user_josh_1775362752696.jpg',
        filePath: path.join(uploadRoot, 'avatars', 'user_josh_1775362752696.jpg')
      }
    });
    await writeUpload('avatars/user_josh_1775362752696.jpg');

    await expect(
      sweepOwnedAvatars({ client, uploadRoot, entityType: 'agent', entityId: 'bob', legacyFilenames: [] })
    ).rejects.toThrow(/points at avatars\/user_josh_1775362752696\.jpg/);
    expect(await exists('avatars/user_josh_1775362752696.jpg')).toBe(true);
    expect(client.store.has('upload:avatars:agent:agent_bob_1770000000000.jpg')).toBe(true);
  });

  test('refuses a record whose stored path leaves the upload directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-avatar-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'keep.jpg'), 'keep');
      const client = createFakeRedis({
        'upload:avatars:agent:agent_bob_1770000000000.jpg': {
          storage: 'filesystem',
          filePath: path.join(outside, 'keep.jpg')
        }
      });

      const error = await sweepOwnedAvatars({
        client,
        uploadRoot,
        entityType: 'agent',
        entityId: 'bob',
        legacyFilenames: []
      }).catch((caught) => caught);
      expect(error.message).toMatch(/escaped the configured upload directory/);
      expect(error.message).toContain('upload:avatars:agent:agent_bob_1770000000000.jpg');
      expect(await fs.readFile(path.join(outside, 'keep.jpg'), 'utf8')).toBe('keep');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('an agent that never had an avatar, on an instance with no avatars folder yet, sweeps nothing', async () => {
    const client = createFakeRedis({});
    await expect(
      sweepOwnedAvatars({ client, uploadRoot, entityType: 'agent', entityId: 'fresh', legacyFilenames: [] })
    ).resolves.toEqual({ deletedRecords: [], deletedFiles: [] });
  });

  test('a Redis failure propagates instead of reading as "nothing to delete"', async () => {
    const client = createFakeRedis({
      'upload:avatars:agent:agent_bob_1770000000000.jpg': avatarRecord('agent_bob_1770000000000.jpg')
    });
    client.json.get.mockRejectedValueOnce(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'));
    const error = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: []
    }).catch((caught) => caught);
    expect(error.message).toMatch(/WRONGTYPE/);
    // Named, so the one bad record can be repaired by hand.
    expect(error.message).toContain('upload:avatars:agent:agent_bob_1770000000000.jpg');
    expect(client.del).not.toHaveBeenCalled();
  });
});

describe('sweepOwnedAvatars for Subagents and Groups (BL-139, BL-140)', () => {
  test.each([
    // Real shapes from Josh's native DB0: `cr_subagent` has a sibling-looking id, and
    // `new_group` / `new_group_2` are two Groups.
    ['subagent', 'cr_subagent', 'cr_subagent_2'],
    ['group', 'new_group', 'new_group_2']
  ])('a %s delete takes exactly that owner’s pictures', async (entityType, entityId, neighbourId) => {
    const own = [`${entityType}_${entityId}_1770865895722.jpg`, `${entityType}_${entityId}_1770865800000.jpg`];
    const neighbour = `${entityType}_${neighbourId}_1775865948156.jpg`;
    // The same id under another owner type is a different owner.
    const otherType = entityType === 'group' ? 'agent' : 'group';
    const sameIdOtherType = `${otherType}_${entityId}_1770000000000.jpg`;
    const client = createFakeRedis({
      [`upload:avatars:${entityType}:${own[0]}`]: avatarRecord(own[0], { entityType, entityId }),
      [`upload:avatars:${entityType}:${own[1]}`]: avatarRecord(own[1], { entityType, entityId }),
      [`upload:avatars:${entityType}:${neighbour}`]: avatarRecord(neighbour, { entityType, entityId: neighbourId }),
      [`upload:avatars:${otherType}:${sameIdOtherType}`]: avatarRecord(sameIdOtherType, {
        entityType: otherType,
        entityId
      })
    });
    for (const filename of [...own, neighbour, sameIdOtherType]) await writeUpload(`avatars/${filename}`);

    const result = await sweepOwnedAvatars({ client, uploadRoot, entityType, entityId, legacyFilenames: [] });

    expect(result).toEqual({
      deletedRecords: own.map((filename) => `upload:avatars:${entityType}:${filename}`).sort(),
      deletedFiles: own.map((filename) => `avatars/${filename}`).sort()
    });
    expect([...client.store.keys()].sort()).toEqual(
      [`upload:avatars:${entityType}:${neighbour}`, `upload:avatars:${otherType}:${sameIdOtherType}`].sort()
    );
    expect(await exists(`avatars/${neighbour}`)).toBe(true);
    expect(await exists(`avatars/${sameIdOtherType}`)).toBe(true);
  });
});

describe('sweepOwnedAvatars with a keep list (BL-142: tidying a living owner)', () => {
  test('keeps the picture the owner shows, under both key forms, and deletes the owner’s other pictures', async () => {
    const shown = 'agent_bob_1770000000003.jpg';
    const replaced = ['agent_bob_1770000000001.jpg', 'agent_bob_1770000000002.jpg'];
    const orphanFile = 'agent_bob_1770000000000.jpg';
    const client = createFakeRedis({
      [`upload:avatars:agent:${shown}`]: avatarRecord(shown, { entityId: 'bob' }),
      [`upload:avatars:${shown}`]: avatarRecord(shown, { entityId: 'bob' }),
      [`upload:avatars:agent:${replaced[0]}`]: avatarRecord(replaced[0], { entityId: 'bob' }),
      [`upload:avatars:agent:${replaced[1]}`]: avatarRecord(replaced[1], { entityId: 'bob' }),
      'upload:avatars:agent:agent_bob_2_1770000000009.jpg': avatarRecord('agent_bob_2_1770000000009.jpg', {
        entityId: 'bob_2'
      })
    });
    for (const filename of [shown, ...replaced, orphanFile, 'agent_bob_2_1770000000009.jpg']) {
      await writeUpload(`avatars/${filename}`);
    }

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: [],
      keepFilenames: [shown],
      tidy: true
    });

    expect(result).toEqual({
      deletedRecords: replaced.map((filename) => `upload:avatars:agent:${filename}`).sort(),
      deletedFiles: [...replaced, orphanFile].map((filename) => `avatars/${filename}`).sort()
    });
    expect([...client.store.keys()].sort()).toEqual(
      [`upload:avatars:agent:${shown}`, `upload:avatars:${shown}`, 'upload:avatars:agent:agent_bob_2_1770000000009.jpg'].sort()
    );
    expect(await exists(`avatars/${shown}`)).toBe(true);
    expect(await exists('avatars/agent_bob_2_1770000000009.jpg')).toBe(true);
  });

  test('a kept picture whose record is broken does not stop the tidy: it is not touched at all', async () => {
    const shown = 'agent_bob_1770000000003.jpg';
    const client = createFakeRedis({
      [`upload:avatars:agent:${shown}`]: {
        ...avatarRecord(shown, { entityId: 'bob' }),
        relativePath: 'avatars/user_josh_1775362752696.jpg',
        filePath: path.join(uploadRoot, 'avatars', 'user_josh_1775362752696.jpg')
      },
      'upload:avatars:agent:agent_bob_1770000000001.jpg': avatarRecord('agent_bob_1770000000001.jpg', {
        entityId: 'bob'
      })
    });
    await writeUpload('avatars/agent_bob_1770000000001.jpg');

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: [],
      keepFilenames: [shown],
      tidy: true
    });

    expect(result.deletedRecords).toEqual(['upload:avatars:agent:agent_bob_1770000000001.jpg']);
    expect(client.store.has(`upload:avatars:agent:${shown}`)).toBe(true);
  });
});

describe('a tidy never deletes a picture that may still be on its way to a save (BL-288)', () => {
  // A tidy runs after a save and keeps the pictures the SAVED record shows. An upload that
  // finished after that save (another tab, or ms timing) is in no saved record yet, and the
  // tidy used to delete it; the form's next save then pointed at a deleted picture.
  test('with a kept picture: every picture uploaded after it stays, record and file', async () => {
    const shown = 'group_crew_1770000000005.jpg';
    const older = 'group_crew_1770000000002.jpg';
    const newer = 'group_crew_1770000000009.jpg';
    const newerFileOnly = 'group_crew_1770000000011.jpg';
    const client = createFakeRedis({
      [`upload:avatars:group:${shown}`]: avatarRecord(shown, { entityType: 'group', entityId: 'crew' }),
      [`upload:avatars:group:${older}`]: avatarRecord(older, { entityType: 'group', entityId: 'crew' }),
      [`upload:avatars:group:${newer}`]: avatarRecord(newer, { entityType: 'group', entityId: 'crew' })
    });
    for (const filename of [shown, older, newer, newerFileOnly]) await writeUpload(`avatars/${filename}`);

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'group',
      entityId: 'crew',
      keepFilenames: [shown],
      tidy: true
    });

    expect(result).toEqual({
      deletedRecords: [`upload:avatars:group:${older}`],
      deletedFiles: [`avatars/${older}`]
    });
    expect(client.store.has(`upload:avatars:group:${newer}`)).toBe(true);
    expect(await exists(`avatars/${newer}`)).toBe(true);
    // A file whose record is not written yet (an upload mid-store) stays too.
    expect(await exists(`avatars/${newerFileOnly}`)).toBe(true);
  });

  test('with no kept picture (cleared, or an icon): only pictures older than ten minutes go', async () => {
    const nowMs = 1_780_000_000_000;
    const old = `user_josh_${nowMs - 11 * 60_000}.jpg`;
    const recent = `user_josh_${nowMs - 60_000}.jpg`;
    const recentFileOnly = `user_josh_${nowMs - 1_000}.jpg`;
    const client = createFakeRedis({
      [`upload:avatars:user:${old}`]: avatarRecord(old, { entityType: 'user', entityId: 'josh' }),
      [`upload:avatars:user:${recent}`]: avatarRecord(recent, { entityType: 'user', entityId: 'josh' })
    });
    for (const filename of [old, recent, recentFileOnly]) await writeUpload(`avatars/${filename}`);

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'user',
      entityId: 'josh',
      keepFilenames: [],
      tidy: true,
      nowMs
    });

    expect(result).toEqual({ deletedRecords: [`upload:avatars:user:${old}`], deletedFiles: [`avatars/${old}`] });
    expect(client.store.has(`upload:avatars:user:${recent}`)).toBe(true);
    expect(await exists(`avatars/${recent}`)).toBe(true);
    expect(await exists(`avatars/${recentFileOnly}`)).toBe(true);
  });

  // The save that cleared the picture names the picture it replaced: that one and every older
  // one go at once, and only a picture uploaded after it (on its way to a save) stays.
  test('with no kept picture but the replaced one named: it and every older one go, a newer one stays', async () => {
    const nowMs = 1_780_000_000_000;
    const older = `agent_bob_${nowMs - 90_000}.jpg`;
    const replaced = `agent_bob_${nowMs - 60_000}.jpg`;
    const newer = `agent_bob_${nowMs - 1_000}.jpg`;
    const client = createFakeRedis({
      [`upload:avatars:agent:${older}`]: avatarRecord(older, { entityId: 'bob' }),
      [`upload:avatars:agent:${replaced}`]: avatarRecord(replaced, { entityId: 'bob' }),
      [`upload:avatars:agent:${newer}`]: avatarRecord(newer, { entityId: 'bob' })
    });
    for (const filename of [older, replaced, newer]) await writeUpload(`avatars/${filename}`);

    const result = await sweepOwnedAvatars({
      client,
      uploadRoot,
      entityType: 'agent',
      entityId: 'bob',
      keepFilenames: [],
      replacedFilename: replaced,
      tidy: true,
      nowMs
    });

    expect(result).toEqual({
      deletedRecords: [`upload:avatars:agent:${older}`, `upload:avatars:agent:${replaced}`].sort(),
      deletedFiles: [`avatars/${older}`, `avatars/${replaced}`].sort()
    });
    expect(client.store.has(`upload:avatars:agent:${newer}`)).toBe(true);
    expect(await exists(`avatars/${newer}`)).toBe(true);
  });

  test('an owner delete (no tidy) still sweeps every picture, the newest included', async () => {
    const nowMs = 1_780_000_000_000;
    const recent = `group_crew_${nowMs - 1_000}.jpg`;
    const client = createFakeRedis({
      [`upload:avatars:group:${recent}`]: avatarRecord(recent, { entityType: 'group', entityId: 'crew' })
    });
    await writeUpload(`avatars/${recent}`);

    const result = await sweepOwnedAvatars({ client, uploadRoot, entityType: 'group', entityId: 'crew', nowMs });

    expect(result).toEqual({ deletedRecords: [`upload:avatars:group:${recent}`], deletedFiles: [`avatars/${recent}`] });
  });
});

describe('parseAvatarOwnerDeleteRequest (BL-41)', () => {
  test('accepts an agent id and legacy flat filenames, deduplicated', () => {
    expect(
      parseAvatarOwnerDeleteRequest({
        entityType: 'agent',
        entityId: 'n8n_agent-2',
        legacyFilenames: ['avatar_1754000000000.jpg', 'avatar_1754000000000.jpg']
      })
    ).toEqual({
      tidy: false,
      entityType: 'agent',
      entityId: 'n8n_agent-2',
      legacyFilenames: ['avatar_1754000000000.jpg'],
      keepFilenames: [],
      replacedFilename: null
    });
    expect(parseAvatarOwnerDeleteRequest({ entityType: 'agent', entityId: 'b2c8f713-12af-4448-84ac-bf80a2866dab' }))
      .toEqual({
        tidy: false,
        entityType: 'agent',
        entityId: 'b2c8f713-12af-4448-84ac-bf80a2866dab',
        legacyFilenames: [],
        keepFilenames: [],
        replacedFilename: null
      });
  });

  test('accepts a Subagent or a Group owner (BL-139, BL-140)', () => {
    expect(parseAvatarOwnerDeleteRequest({ entityType: 'subagent', entityId: 'cr_subagent' })).toEqual({
      tidy: false,
      entityType: 'subagent',
      entityId: 'cr_subagent',
      legacyFilenames: [],
      keepFilenames: [],
      replacedFilename: null
    });
    expect(parseAvatarOwnerDeleteRequest({ entityType: 'group', entityId: 'new_group_2' }).entityType).toBe('group');
  });

  test('accepts a tidy with a keep list of the owner’s own pictures, deduplicated (BL-142)', () => {
    expect(
      parseAvatarOwnerDeleteRequest({
        tidy: true,
        entityType: 'agent',
        entityId: 'bob',
        keepFilenames: ['agent_bob_1770000000003.jpg', 'agent_bob_1770000000003.jpg']
      })
    ).toEqual({
      tidy: true,
      entityType: 'agent',
      entityId: 'bob',
      legacyFilenames: [],
      keepFilenames: ['agent_bob_1770000000003.jpg'],
      replacedFilename: null
    });
  });

  test('accepts, in a tidy, the owner’s own picture the save replaced (BL-288)', () => {
    expect(
      parseAvatarOwnerDeleteRequest({
        tidy: true,
        entityType: 'group',
        entityId: 'crew',
        keepFilenames: [],
        replacedFilename: 'group_crew_1775362752696.jpg'
      })
    ).toEqual({
      tidy: true,
      entityType: 'group',
      entityId: 'crew',
      legacyFilenames: [],
      keepFilenames: [],
      replacedFilename: 'group_crew_1775362752696.jpg'
    });
  });

  test('accepts a tidy of the user’s own pictures, which nothing ever deletes (BL-281)', () => {
    expect(
      parseAvatarOwnerDeleteRequest({
        tidy: true,
        entityType: 'user',
        entityId: 'josh',
        keepFilenames: ['user_josh_1775362752696.jpg']
      })
    ).toEqual({
      tidy: true,
      entityType: 'user',
      entityId: 'josh',
      legacyFilenames: [],
      keepFilenames: ['user_josh_1775362752696.jpg'],
      replacedFilename: null
    });
  });

  test('accepts any id `redis.deleteAgent` accepts, however long (a length cap would make such an agent undeletable)', () => {
    const longId = `agent_${'x'.repeat(300)}`;
    expect(parseAvatarOwnerDeleteRequest({ entityType: 'agent', entityId: longId }).entityId).toBe(longId);
  });

  test.each([
    ['no body', undefined],
    ['an unknown owner type', { entityType: 'goon', entityId: 'x' }],
    ['the user (a user is never deleted through here)', { entityType: 'user', entityId: 'josh' }],
    ['a keep list outside a tidy', { entityType: 'agent', entityId: 'bob', keepFilenames: ['agent_bob_1.jpg'] }],
    ['a tidy that names legacy pictures', { tidy: true, entityType: 'agent', entityId: 'bob', legacyFilenames: ['avatar_1.jpg'] }],
    ['a tidy flag that is not true or false', { tidy: 'yes', entityType: 'agent', entityId: 'bob' }],
    ['a tidy of an unknown owner type', { tidy: true, entityType: 'goon', entityId: 'bob' }],
    ['a replaced picture outside a tidy', { entityType: 'agent', entityId: 'bob', replacedFilename: 'agent_bob_1.jpg' }],
    ['another owner’s picture as replaced', { tidy: true, entityType: 'agent', entityId: 'bob', replacedFilename: 'agent_bob_2_1.jpg' }],
    ['a replaced name that is not text', { tidy: true, entityType: 'agent', entityId: 'bob', replacedFilename: 7 }],
    ['keep names that are not a list', { tidy: true, entityType: 'agent', entityId: 'bob', keepFilenames: 'agent_bob_1.jpg' }],
    ['another owner’s picture as keep', { tidy: true, entityType: 'agent', entityId: 'bob', keepFilenames: ['agent_bob_2_1.jpg'] }],
    ['another type’s picture as keep', { tidy: true, entityType: 'agent', entityId: 'bob', keepFilenames: ['subagent_bob_1.jpg'] }],
    ['a legacy flat picture as keep', { tidy: true, entityType: 'agent', entityId: 'bob', keepFilenames: ['avatar_1.jpg'] }],
    [
      'too many keep names',
      {
        tidy: true,
        entityType: 'agent',
        entityId: 'bob',
        keepFilenames: Array.from({ length: 5 }, (_, index) => `agent_bob_${index}.jpg`)
      }
    ],
    ['a missing id', { entityType: 'agent' }],
    ['an empty id', { entityType: 'agent', entityId: '' }],
    ['a glob star', { entityType: 'agent', entityId: 'a*' }],
    ['a glob question mark', { entityType: 'agent', entityId: 'a?' }],
    ['a glob class', { entityType: 'agent', entityId: 'a[b]' }],
    ['a path', { entityType: 'agent', entityId: '../x' }],
    ['a slash', { entityType: 'agent', entityId: 'a/b' }],
    ['a dot', { entityType: 'agent', entityId: 'a.b' }],
    ['surrounding spaces', { entityType: 'agent', entityId: ' bob ' }],
    ['a non-string id', { entityType: 'agent', entityId: 7 }],
    ['legacy names that are not a list', { entityType: 'agent', entityId: 'bob', legacyFilenames: 'avatar_1.jpg' }],
    ['an organized name as legacy', { entityType: 'agent', entityId: 'bob', legacyFilenames: ['agent_bob_1.jpg'] }],
    ['the user avatar as legacy', { entityType: 'agent', entityId: 'bob', legacyFilenames: ['user_josh_1.jpg'] }],
    ['a traversal as legacy', { entityType: 'agent', entityId: 'bob', legacyFilenames: ['../avatar_1.jpg'] }],
    ['a png as legacy', { entityType: 'agent', entityId: 'bob', legacyFilenames: ['avatar_1.png'] }],
    ['a default avatar as legacy', { entityType: 'agent', entityId: 'bob', legacyFilenames: ['default_agent_avatar.png'] }],
    [
      'too many legacy names',
      {
        entityType: 'agent',
        entityId: 'bob',
        legacyFilenames: Array.from({ length: 9 }, (_, index) => `avatar_${index}.jpg`)
      }
    ]
  ])('rejects %s', (_label, body) => {
    expect(() => parseAvatarOwnerDeleteRequest(body)).toThrow(AvatarOwnerDeleteRequestError);
  });
});
