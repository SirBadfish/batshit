const { createGoonCustomAssetMaintenance } = require('../goonCustomAssetMaintenance');

function fixture(options) {
  let marker = null;
  const done = new Set();
  const client = {
    get: jest.fn(async () => marker),
    eval: jest.fn(async (script, { keys, arguments: [token] }) => {
      if (script.includes('-- BEGIN_GOON_ASSET_RESTORE')) {
        if (done.has(keys[1])) return marker ? 'CLOSED_ACTIVE' : 'CLOSED_IDLE';
        if (marker) return marker === token ? 'EXISTING' : 'CONFLICT';
        marker = token;
        return 'CREATED';
      }
      if (script.includes('-- END_GOON_ASSET_RESTORE')) {
        if (marker && marker !== token) return 'CONFLICT';
        const state = marker ? 'RELEASED' : 'ABSENT';
        marker = null;
        done.add(keys[1]);
        return state;
      }
      throw new Error('Unexpected maintenance script');
    })
  };
  return {
    client,
    maintenance: createGoonCustomAssetMaintenance(() => client, options),
    done,
    get marker() { return marker; },
    set marker(value) { marker = value; }
  };
}

const token = '00000000-0000-4000-8000-000000000001';
const otherToken = '00000000-0000-4000-8000-000000000002';

test('begin blocks new work synchronously and waits for the entire entered operation', async () => {
  const state = fixture();
  const release = await state.maintenance.enter();
  let settled = false;
  const beginning = state.maintenance.begin(token).then((result) => {
    settled = true;
    return result;
  });
  await expect(state.maintenance.enter()).rejects.toMatchObject({ statusCode: 409 });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(state.marker).toBe(token);
  release();
  expect(await beginning).toEqual({ token, state: 'created', activeOperations: 0 });
  await expect(state.maintenance.enter()).rejects.toMatchObject({ statusCode: 409 });
  expect(await state.maintenance.end(token)).toEqual({ token, state: 'released' });
  const after = await state.maintenance.enter();
  after();
});

test('a restarted file service refuses work while a durable restore marker exists', async () => {
  const state = fixture();
  state.marker = token;
  await expect(state.maintenance.enter()).rejects.toMatchObject({ statusCode: 409 });
  expect(await state.maintenance.begin(token)).toEqual({ token, state: 'existing', activeOperations: 0 });
  await expect(state.maintenance.begin(otherToken)).rejects.toMatchObject({ statusCode: 409 });
  await expect(state.maintenance.end(otherToken)).rejects.toMatchObject({ statusCode: 409 });
  expect(state.marker).toBe(token);
  expect(await state.maintenance.end(token)).toEqual({ token, state: 'released' });
  expect(await state.maintenance.end(token)).toEqual({ token, state: 'absent' });
});

test('drain timeout preserves the marker and a later matching end still drains', async () => {
  const state = fixture({ drainTimeoutMs: 5 });
  const release = await state.maintenance.enter();
  await expect(state.maintenance.begin(token)).rejects.toMatchObject({ statusCode: 503 });
  expect(state.marker).toBe(token);
  await expect(state.maintenance.enter()).rejects.toMatchObject({ statusCode: 409 });
  const ending = state.maintenance.end(token);
  release();
  expect(await ending).toEqual({ token, state: 'released' });
  expect(state.marker).toBeNull();
});

test('uncertain Redis end never clears the local block', async () => {
  const state = fixture();
  await state.maintenance.begin(token);
  state.client.eval.mockImplementationOnce(async () => { throw new Error('lost Redis reply'); });
  await expect(state.maintenance.end(token)).rejects.toThrow('lost Redis reply');
  await expect(state.maintenance.enter()).rejects.toMatchObject({ statusCode: 409 });
  expect(await state.maintenance.end(token)).toEqual({ token, state: 'released' });
});

test('a delayed begin after an absent end cannot reopen maintenance or strand the service', async () => {
  const state = fixture();
  expect(await state.maintenance.end(token)).toEqual({ token, state: 'absent' });
  expect(state.done.has(`goon_asset_restore_done:${token}`)).toBe(true);
  await expect(state.maintenance.begin(token)).rejects.toMatchObject({ statusCode: 409 });
  expect(state.marker).toBeNull();
  const release = await state.maintenance.enter();
  release();
});

test('a completed old token stays closed across a later restore', async () => {
  const state = fixture();
  await state.maintenance.begin(token);
  await state.maintenance.end(token);
  await state.maintenance.begin(otherToken);
  await expect(state.maintenance.begin(token)).rejects.toMatchObject({ statusCode: 409 });
  expect(state.marker).toBe(otherToken);
  await state.maintenance.end(otherToken);
  await expect(state.maintenance.begin(token)).rejects.toMatchObject({ statusCode: 409 });
  const release = await state.maintenance.enter();
  release();
});
