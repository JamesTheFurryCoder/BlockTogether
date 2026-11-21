const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ndarray = require('ndarray');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frontend', 'game', 'player-home', 'playerHome.js'), 'utf8')
  .replace("import { Engine } from 'noa-engine'", '')
  .replace('import.meta.env.VITE_API_BASE_URL', '""')
  .replace('export default noa',
    'globalThis.game = {noa, grid, gridReady, generatedChunk, generateblocksfromAIoutput, waitForSaves: () => saveQueue}');
const backupKey = 'blocktogether:pending-chunks:James';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t, initialSave = {}) {
  const saved = structuredClone(initialSave);
  const storage = new Map();
  let generateChunk;
  return {
    useGenerator: generator => { generateChunk = generator; },
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
          saved[i][j][k] ??= Array.from(generateChunk(j));
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
  const documentHandlers = new Map();
  const materials = new Map();
  const blockTypes = new Map();
  const elements = [];
  const aiElements = new Map(['aiPrompt', 'generateBlocks', 'aiPromptHelp'].map(id =>
    [id, { value: '', setAttribute() {}, addEventListener() {} }]));
  const chunks = new Map();
  const deliveries = new Map();
  const getChunk = pos => chunks.get(pos.map(n => Math.floor(n / 24)).join(','));
  const localPosition = (pos, chunk) => pos.map((n, axis) => n - chunk.pos[axis]);
  class Engine {
    constructor() {
      this.registry = {
        registerMaterial: (name, options) => materials.set(name, options),
        registerBlock: (id, options) => blockTypes.set(id, options),
      };
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
    document: {
      getElementById: id => aiElements.get(id),
      createElement: () => ({ style: {}, children: [], addEventListener() {},
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this[name] = value; } }),
      addEventListener: (name, handler) => documentHandlers.set(name, handler),
      body: { appendChild: element => elements.push(element) },
    },
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(source, context);
  store.useGenerator(context.game.generatedChunk);
  return Object.assign(context.game, {
    materials, blockTypes,
    palette: elements.find(element => element.className === 'block-palette'),
    pressKey(key, options = {}) {
      const event = { key, preventDefault() { this.defaultPrevented = true; }, ...options };
      documentHandlers.get('keydown')(event);
      return event;
    },
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
  assert.equal(restored.voxels.get(2, 1, 0), 4);
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

test('number keys place both color sets, including glass, and all types survive reload', async t => {
  const store = await setup(t);
  const game = startGame(store);
  const chunk = await game.load(0, 0, 0);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  assert.equal(game.blockTypes.size, 20);
  for (let set = 0; set < 2; set++) {
    for (let slot = 0; slot < keys.length; slot++) {
      assert.equal(game.pressKey(keys[slot]).defaultPrevented, true);
      const x = set * 10 + slot;
      game.placeBlock([x, 1, 0]);
      assert.equal(chunk.voxels.get(x, 1, 0), 4 + x);
      assert.match(game.palette.children[0].textContent, new RegExp(`Set ${set + 1}/2`));
      assert.match(game.palette.children[1].children[slot].className, /selected/);
    }
    game.pressKey('Tab');
  }
  assert.match(game.palette.children[0].textContent, /Set 1\/2 · Pink/);
  const glass = game.blockTypes.get(23);
  assert.equal(glass.solid, true);
  assert.equal(glass.opaque, false);
  assert.equal(game.materials.get(glass.material).color[3], 0.3);
  await game.waitForSaves();
  const reloaded = await startGame(store).load(0, 0, 0);
  for (let x = 0; x < 20; x++) assert.equal(reloaded.voxels.get(x, 1, 0), 4 + x);
});

test('palette switching ignores held keys and respects released pointer lock and shortcuts', async t => {
  const game = startGame(await setup(t));
  const label = () => game.palette.children[0].textContent;
  assert.match(label(), /Set 1\/2 · Red/);
  game.pressKey('Tab');
  assert.match(label(), /Set 2\/2 · White/);
  assert.equal(game.pressKey('Tab', { repeat: true }).defaultPrevented, true);
  assert.match(label(), /Set 2\/2 · White/);
  game.pressKey('0');
  assert.match(label(), /Glass/);
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(game.pressKey('1', { [modifier]: true }).defaultPrevented, undefined);
    assert.match(label(), /Glass/);
  }
  game.noa.container.hasPointerLock = false;
  assert.equal(game.pressKey('Tab').defaultPrevented, undefined);
  game.pressKey('1');
  assert.match(label(), /Set 2\/2 · Glass/);
  game.noa.container.hasPointerLock = true;
  assert.equal(game.pressKey('w').defaultPrevented, undefined);
  game.pressKey('Tab');
  assert.match(label(), /Set 1\/2 · Pink/);
});

test('generated terrain uses three palette colors in layers and survives saving at negative coordinates', async t => {
  const store = await setup(t);
  const game = startGame(store);
  const chunk = await game.load(-1, 0, -1);
  for (let x = 0; x < 24; x++) for (let z = 0; z < 24; z++) {
    assert.equal(chunk.voxels.get(x, 0, z), 8);
    assert.equal(chunk.voxels.get(x, 1, z), 0);
  }
  const underground = await game.load(-1, -1, -1);
  for (let x = 0; x < 24; x++) for (let z = 0; z < 24; z++) {
    for (let y = 0; y < 20; y++) assert.equal(underground.voxels.get(x, y, z), 0);
    assert.equal(underground.voxels.get(x, 20, z), 16);
    assert.equal(underground.voxels.get(x, 21, z), 16);
    assert.equal(underground.voxels.get(x, 22, z), 18);
    assert.equal(underground.voxels.get(x, 23, z), 18);
  }
  game.breakBlock([-24, 0, -24]);
  game.pressKey('Tab');
  game.pressKey('0');
  game.placeBlock([-24, 1, -24]);
  await game.waitForSaves();
  const refreshed = startGame(store);
  const restored = await refreshed.load(-1, 0, -1);
  assert.deepEqual(Array.from(restored.voxels.data), Array.from(chunk.voxels.data));
  assert.deepEqual(Array.from((await refreshed.load(-1, -1, -1)).voxels.data), Array.from(underground.voxels.data));
});

test('legacy terrain IDs load as palette colors from saved blocks and pending chunk backups', async t => {
  const legacy = Array(24 ** 3).fill(0);
  legacy[0] = 1;
  legacy[1] = 2;
  legacy[2] = 3;
  legacy[3] = 23;
  const store = await setup(t, { 0: { 0: { 0: legacy } } });
  const fromDisk = await startGame(store).load(0, 0, 0);
  assert.deepEqual(Array.from(fromDisk.voxels.data).slice(0, 5), [8, 18, 16, 23, 0]);
  store.localStorage.setItem(backupKey, JSON.stringify([['0,0,0', legacy]]));
  const resumed = startGame(store);
  const fromBackup = await resumed.load(0, 0, 0);
  assert.deepEqual(Array.from(fromBackup.voxels.data).slice(0, 5), [8, 18, 16, 23, 0]);
  await resumed.waitForSaves();
  assert.deepEqual(store.readSave()['0']['0']['0'].slice(0, 5), [8, 18, 16, 23, 0]);
});

test('AI output saves loaded and distant chunks while preserving existing edits and terrain', async t => {
  const store = await setup(t);
  const game = startGame(store);
  await game.load(0, 0, 0);
  await game.load(10, 0, -11);
  game.placeBlock([241, 1, -241]);
  await game.waitForSaves();
  // Start a new page so that the distant saved chunk is outside NOA's loaded radius.
  const page = startGame(store);
  const loaded = await page.load(0, 0, 0);
  const count = await page.generateblocksfromAIoutput('```diff\n0,1,0,4\n0,1,0,5\n-1,1,-1,23\n240,1,-241,14\n240,0,-241,0\n```');
  assert.equal(count, 4);
  assert.equal(loaded.voxels.get(0, 1, 0), 5);
  // A later manual edit of the same loaded chunk must not overwrite AI blocks.
  page.placeBlock([1, 1, 0]);
  await page.waitForSaves();
  assert.equal(store.localStorage.getItem(backupKey), null);

  const refreshed = startGame(store);
  const near = await refreshed.load(0, 0, 0);
  assert.equal(near.voxels.get(0, 1, 0), 5);
  assert.equal(near.voxels.get(1, 1, 0), 4);
  assert.equal(near.voxels.get(0, 0, 0), 8);
  assert.equal((await refreshed.load(-1, 0, -1)).voxels.get(23, 1, 23), 23);
  const far = await refreshed.load(10, 0, -11);
  assert.equal(far.voxels.get(0, 1, 23), 14);
  assert.equal(far.voxels.get(1, 1, 23), 4);
  assert.equal(far.voxels.get(0, 0, 23), 0);
  assert.equal(far.voxels.get(1, 0, 23), 8);
});

test('AI validation rejects an entire malformed response before modifying the world', async t => {
  const store = await setup(t);
  const game = startGame(store);
  const chunk = await game.load(0, 0, 0);
  for (const invalid of ['', '```text\n```', 'words', '0,1,0,4\n1,1,0,99',
    '0,1,0,4\n1.5,1,0,4', '0,1,0,4\n9007199254740992,1,0,4', '0,1,0,4\n1,1,,4']) {
    await assert.rejects(game.generateblocksfromAIoutput(invalid));
    assert.equal(chunk.voxels.get(0, 1, 0), 0);
    assert.equal(store.localStorage.getItem(backupKey), null);
    assert.deepEqual(store.readSave(), {});
  }
});

test('AI blocks outside loaded chunks recover on refresh after failed server saves', async t => {
  const store = await setup(t);
  const page = startGame(store, (url, options) => options
    ? Promise.resolve({ ok: false, status: 500 }) : store.fetch(url));
  await assert.rejects(page.generateblocksfromAIoutput('240,1,-241,4\n-240,1,240,5'), /Could not save/);
  assert.equal(JSON.parse(store.localStorage.getItem(backupKey)).length, 2);
  const refreshed = startGame(store);
  assert.equal((await refreshed.load(10, 0, -11)).voxels.get(0, 1, 23), 4);
  assert.equal((await refreshed.load(-10, 0, 10)).voxels.get(0, 1, 0), 5);
  await refreshed.waitForSaves();
  assert.equal(store.localStorage.getItem(backupKey), null);
});
