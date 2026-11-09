const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ndarray = require('ndarray');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frontend', 'playerHome.js'), 'utf8')
  .replace("import { Engine } from 'noa-engine'", '')
  .replace('import.meta.env.VITE_API_BASE_URL', '""')
  .replace('export default noa',
    'globalThis.game = {noa, grid, gridReady, waitForSaves: () => saveQueue}');
const backupKey = 'blocktogether:pending-chunks:James';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t, initialSave = {}) {
  const saved = structuredClone(initialSave);
  const storage = new Map();
  return {
    readSave: () => structuredClone(saved),
    fetch: async (url, options) => {
      const target = new URL(url);
      assert.equal(options ? JSON.parse(options.body).username : target.searchParams.get('username'), 'James');
      if (options) assert.equal(target.searchParams.has('username'), false);
      assert.equal(target.pathname, '/api/worlds/me/blocks');
      if (options) {
        for (const { x, y, z, blockId } of JSON.parse(options.body).blocks) {
          const [i, j, k] = [x, y, z].map(n => Math.floor(n / 24));
          saved[i] ??= {}; saved[i][j] ??= {};
          saved[i][j][k] ??= Array.from({ length: 24 ** 3 }, (_, index) => {
            const height = j * 24 + Math.floor(index / 24) % 24;
            return height > 0 || height < -4 ? 0 : height === 0 ? 1 : height >= -2 ? 2 : 3;
          });
          saved[i][j][k][(x - i * 24) * 24 ** 2 + (y - j * 24) * 24 + z - k * 24] = blockId;
        }
        return { ok: true };
      }
      const blocks = [];
      for (const [i, rows] of Object.entries(saved)) for (const [j, columns] of Object.entries(rows)) {
        for (const [k, values] of Object.entries(columns)) values.forEach((blockId, index) => {
          blocks.push({ x: +i * 24 + Math.floor(index / 24 ** 2),
            y: +j * 24 + Math.floor(index / 24) % 24, z: +k * 24 + index % 24, blockId });
        });
      }
      return { ok: true, json: async () => ({ blocks }) };
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  };
}

function startGame(store, fetchImpl = store.fetch) {
  const inputHandlers = new Map();
  const worldHandlers = new Map();
  const chunks = new Map();
  const deliveries = new Map();
  const getChunk = pos => chunks.get(pos.map(n => Math.floor(n / 24)).join(','));
  const localPosition = (pos, chunk) => pos.map((n, axis) => n - chunk.pos[axis]);
  class Engine {
    constructor() {
      this.registry = { registerMaterial() {}, registerBlock() {} };
      this.container = { hasPointerLock: true };
      this.inputs = { down: { on: (name, handler) => inputHandlers.set(name, handler) } };
      this.world = {
        on: (name, handler) => worldHandlers.set(name, handler),
        setChunkData: (id, data) => deliveries.set(id, data),
        _getChunkByCoords: (...pos) => getChunk(pos),
      };
    }
    getBlock(pos) {
      const chunk = getChunk(pos);
      return chunk.voxels.get(...localPosition(pos, chunk));
    }
    setBlock(id, pos) {
      const chunk = getChunk(pos);
      chunk.voxels.set(...localPosition(pos, chunk), id);
    }
    addBlock(id, pos) {
      if (this.blocked) return;
      this.setBlock(id, pos);
      return id;
    }
  }
  const context = {
    Engine, fetch: async (url, options) => {
      const target = new URL(url);
      assert.equal(options ? JSON.parse(options.body).username : target.searchParams.get('username'), 'James');
      if (options) assert.equal(target.searchParams.has('username'), false);
      if (target.pathname === '/api/sessions') return { ok: true, json: async () => ({ sessionId: 1 }) };
      if (target.pathname.startsWith('/api/sessions/') || target.pathname === '/api/events') return { ok: true, json: async () => ({}) };
      return fetchImpl(url, options);
    }, localStorage: store.localStorage,
    URLSearchParams, sessionStorage: { getItem: () => 'James' },
    window: { addEventListener() {}, location: {} },
    document: { createElement: () => ({ style: {}, addEventListener() {} }), body: { appendChild() {} } },
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(source, context);
  return Object.assign(context.game, {
    async load(i, j, k) {
      const key = [i, j, k].join(',');
      const data = ndarray(new Uint16Array(24 ** 3), [24, 24, 24]);
      await worldHandlers.get('worldDataNeeded')(key, data, i * 24, j * 24, k * 24);
      assert.equal(deliveries.get(key), data);
      const chunk = { i, j, k, x: i * 24, y: j * 24, z: k * 24, pos: [i * 24, j * 24, k * 24], voxels: data };
      chunks.set(key, chunk);
      return chunk;
    },
    breakBlock(pos) {
      context.game.noa.targetedBlock = { position: pos };
      inputHandlers.get('fire')();
    },
    placeBlock(pos) {
      context.game.noa.targetedBlock = { adjacent: pos };
      inputHandlers.get('alt-fire')();
    },
  });
}

test('refresh recovers all queued chunk edits before SQLite writes finish', async t => {
  const untouched = Array(24 ** 3).fill(3);
  const oldGround = Array(24 ** 3).fill(0);
  for (let x = 0; x < 24; x++) {
    for (let z = 0; z < 24; z++) oldGround[x * 24 * 24 + z] = 1;
  }
  const store = await setup(t, { 0: { 0: { 0: oldGround } }, 8: { 0: { 0: untouched } } });
  // The old page loses its JavaScript queue while its first request is pending.
  const oldPage = startGame(store, (url, options) => options
    ? new Promise(() => {})
    : store.fetch(url));
  await oldPage.load(0, 0, 0);
  await oldPage.load(1, 0, 0);
  await oldPage.load(-1, -1, 0);
  oldPage.breakBlock([0, 0, 0]);
  oldPage.breakBlock([1, 0, 0]);
  oldPage.breakBlock([24, 0, 0]);
  oldPage.breakBlock([-24, -1, 0]);
  oldPage.placeBlock([2, 1, 0]);
  assert.equal(JSON.parse(store.localStorage.getItem(backupKey)).length, 3);

  const resumeSaves = deferred();
  const refreshed = startGame(store, async (url, options) => {
    if (options) await resumeSaves.promise;
    return store.fetch(url, options);
  });
  const restored = await refreshed.load(0, 0, 0);
  assert.equal(restored.voxels.get(0, 0, 0), 0);
  assert.equal(restored.voxels.get(1, 0, 0), 0);
  assert.equal(restored.voxels.get(2, 1, 0), 1);
  assert.equal((await refreshed.load(1, 0, 0)).voxels.get(0, 0, 0), 0);
  assert.equal((await refreshed.load(-1, -1, 0)).voxels.get(0, 23, 0), 0);
  resumeSaves.resolve();
  await refreshed.waitForSaves();
  assert.equal(store.localStorage.getItem(backupKey), null);
  assert.deepEqual(store.readSave()['8']['0']['0'], untouched);

  // With no browser backup left, another reload must restore from SQLite alone.
  const fromDisk = startGame(store);
  const diskChunk = await fromDisk.load(0, 0, 0);
  assert.deepEqual(Array.from(diskChunk.voxels.data), Array.from(restored.voxels.data));
  assert.equal((await fromDisk.load(1, 0, 0)).voxels.get(0, 0, 0), 0);
  assert.equal((await fromDisk.load(-1, -1, 0)).voxels.get(0, 23, 0), 0);
});

test('older save acknowledgments keep newer pending edits and coalesce queued snapshots', async t => {
  const store = await setup(t);
  const firstSent = deferred();
  const secondSent = deferred();
  const firstResponse = deferred();
  const secondResponse = deferred();
  let requests = 0;
  const game = startGame(store, async (url, options) => {
    if (options) {
      requests++;
      if (requests === 1) {
        firstSent.resolve();
        await firstResponse.promise;
      } else {
        secondSent.resolve();
        await secondResponse.promise;
      }
    }
    return store.fetch(url, options);
  });
  const chunk = await game.load(0, 0, 0);
  game.breakBlock([0, 0, 0]);
  await firstSent.promise;
  game.breakBlock([1, 0, 0]);
  game.breakBlock([2, 0, 0]);
  firstResponse.resolve();
  await secondSent.promise;
  const pendingBlocks = JSON.parse(store.localStorage.getItem(backupKey))[0][1];
  assert.equal(pendingBlocks[chunk.voxels.index(2, 0, 0)], 0);
  secondResponse.resolve();
  await game.waitForSaves();
  assert.equal(requests, 2);
  assert.equal(store.localStorage.getItem(backupKey), null);
  assert.deepEqual(store.readSave()['0']['0']['0'], Array.from(chunk.voxels.data));
});

test('failed saves remain recoverable and blocked placement does not create a save', async t => {
  const store = await setup(t);
  const game = startGame(store, (url, options) => options
    ? Promise.resolve({ ok: false, status: 500 })
    : store.fetch(url));
  await game.load(0, 0, 0);
  game.noa.blocked = true;
  game.placeBlock([0, 1, 0]);
  assert.equal(store.localStorage.getItem(backupKey), null);
  game.breakBlock([3, 0, 0]);
  await game.waitForSaves();
  assert.notEqual(store.localStorage.getItem(backupKey), null);
  assert.deepEqual(store.readSave(), {});

  const refreshed = startGame(store);
  assert.equal((await refreshed.load(0, 0, 0)).voxels.get(3, 0, 0), 0);
  await refreshed.waitForSaves();
  assert.equal(store.localStorage.getItem(backupKey), null);
  assert.equal(store.readSave()['0']['0']['0'][3 * 24 * 24], 0);
});
