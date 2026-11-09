import { Engine } from 'noa-engine'

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'
).replace(/\/$/, '');

// Capture the identity once so pending saves cannot switch users mid-session.
const username = sessionStorage.getItem('blocktogether:username');
if (!username) throw new Error('Please sign in before entering your home.');
let sessionId = null;

async function checkGameplayResponse(response, message) {
  if (response.ok) return;
  const result = await response.json().catch(() => ({}));
  throw new Error(`${message}: ${result.error || `HTTP ${response.status}`}`);
}

async function recordBlockEvent(type, x, y, z) {
  await sessionReady;
  if (sessionId === null) return;

  const response = await fetch(`${API_BASE_URL}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      sessionId,
      events: [{ type, x, y, z }],
    }),
  });

  await checkGameplayResponse(response, `Could not record ${type}`);
}

async function startSession() {
  const response = await fetch(`${API_BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  await checkGameplayResponse(response, 'Could not start session');

  const session = await response.json();
  sessionId = session.sessionId;
}

async function endSession() {
  if (sessionId === null) return;

  const response = await fetch(
    `${API_BASE_URL}/api/sessions/${sessionId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
      keepalive: true,
    }
  );
  await checkGameplayResponse(response, 'Could not end session');

  sessionId = null;
  return response.json();
}

const sessionReady = startSession();
sessionReady.catch(error => {
  console.error('Could not start session:', error);
});

// Keys are chunk coordinates (for example, "0,-1,2"); values are plain block arrays.
const grid = new Map();
const pendingSaves = new Map();
const PENDING_SAVE_KEY = `blocktogether:pending-chunks:${username}`;
const persistedBlocks = new Map();
const CHUNK_SIZE = 24;
function terrainBlock(y) {
  return y > 0 || y < -4 ? 0 : y === 0 ? 1 : y >= -2 ? 2 : 3;
}
function generatedChunk(j) {
  return Array.from({ length: CHUNK_SIZE ** 3 }, (_, index) =>
    terrainBlock(j * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE) % CHUNK_SIZE));
}
let saveQueue = Promise.resolve();

function chunkKey(i, j, k) {
  return `${i},${j},${k}`;
}

async function loadGrid() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/worlds/me/blocks?${new URLSearchParams({ username })}`);
    await checkGameplayResponse(response, 'Could not load saved blocks');
    const { blocks } = await response.json();
    for (const block of blocks) {
      const { x, y, z, blockId } = block;
      persistedBlocks.set(`${x},${y},${z}`, block);
      const [i, j, k] = [x, y, z].map(value => Math.floor(value / CHUNK_SIZE));
      const key = chunkKey(i, j, k);
      if (!grid.has(key)) grid.set(key, generatedChunk(j));
      const index = (x - i * CHUNK_SIZE) * CHUNK_SIZE ** 2
        + (y - j * CHUNK_SIZE) * CHUNK_SIZE + z - k * CHUNK_SIZE;
      grid.get(key)[index] = blockId;
    }
  } catch (error) {
    console.error('Could not load SQLite world:', error);
  }

  // A refresh can interrupt queued requests. Pending edits override older SQLite data.
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_SAVE_KEY) || '[]');
    for (const [key, blocks] of pending) {
      pendingSaves.set(key, blocks);
      grid.set(key, blocks);
      queueChunkSave(key.split(',').map(Number), blocks);
    }
  } catch (error) {
    console.error('Could not restore pending chunk saves:', error);
  }
}

function storePendingSaves() {
  try {
    if (pendingSaves.size) {
      localStorage.setItem(PENDING_SAVE_KEY, JSON.stringify([...pendingSaves]));
    } else {
      localStorage.removeItem(PENDING_SAVE_KEY);
    }
  } catch (error) {
    console.error('Could not back up pending chunk saves:', error);
  }
}

function queueChunkSave(indexes, blocks) {
  const key = chunkKey(...indexes);
  saveQueue = saveQueue.then(async () => {
    // Only send the latest snapshot if several edits to this chunk are queued.
    if (pendingSaves.get(key) !== blocks) return;

    const edits = [];
    const [i, j, k] = indexes;
    for (let index = 0; index < blocks.length; index++) {
      const x = i * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE ** 2);
      const y = j * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE) % CHUNK_SIZE;
      const z = k * CHUNK_SIZE + index % CHUNK_SIZE;
      const blockId = blocks[index];
      if (blockId !== terrainBlock(y) || persistedBlocks.has(`${x},${y},${z}`)) {
        edits.push({ x, y, z, blockId });
      }
    }
    for (let offset = 0; offset < edits.length; offset += 1000) {
      const batch = edits.slice(offset, offset + 1000);
      const response = await fetch(`${API_BASE_URL}/api/worlds/me/blocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, blocks: batch }),
      });
      await checkGameplayResponse(response, 'Could not save world blocks');
      for (const block of batch) persistedBlocks.set(`${block.x},${block.y},${block.z}`, block);
    }

    // An older response must not clear a newer edit's backup.
    if (pendingSaves.get(key) === blocks) {
      pendingSaves.delete(key);
      storePendingSaves();
    }
  }).catch(error => {
    console.error('Could not save SQLite world:', error);
  });
}

function saveChunk(chunk) {
  // Copy after the edit so the saved data survives the chunk unloading.
  const indexes = [chunk.i, chunk.j, chunk.k];
  const blocks = Array.from(chunk.voxels.data);
  const key = chunkKey(...indexes);
  grid.set(key, blocks);
  pendingSaves.set(key, blocks);
  // This synchronous backup survives refresh even before a request is sent.
  storePendingSaves();
  queueChunkSave(indexes, blocks);
}

const gridReady = loadGrid();

const GRASS = 1
const DIRT = 2
const STONE = 3
const GROUND_LEVEL = 0
const UNDERGROUND_DEPTH = 4

const noa = new Engine({
  debug: false,
  playerStart: [0, 3, 0],
  chunkAddDistance: [1, 1],
  chunkRemoveDistance: [2, 2],
})

noa.registry.registerMaterial('grass', { color: [0.35, 0.68, 0.28] })
noa.registry.registerMaterial('dirt', { color: [0.48, 0.31, 0.18] })
noa.registry.registerMaterial('stone', { color: [0.52, 0.54, 0.56] })

noa.registry.registerBlock(GRASS, {
  material: 'grass',
  solid: true,
  opaque: true,
})
noa.registry.registerBlock(DIRT, {
  material: 'dirt',
  solid: true,
  opaque: true,
})
noa.registry.registerBlock(STONE, {
  material: 'stone',
  solid: true,
  opaque: true,
})

noa.world.on('worldDataNeeded', async (requestID, data, chunkX, chunkY, chunkZ) => {
  await gridReady;
  const [sizeX, sizeY, sizeZ] = data.shape
  const key = chunkKey(chunkX / sizeX, chunkY / sizeY, chunkZ / sizeZ);

  if (grid.has(key)) {
    // Replace the entire chunk's block data instead of generating terrain.
    data.data.set(grid.get(key));
    noa.world.setChunkData(requestID, data);
    return;
  }

  for (let x = 0; x < sizeX; x += 1) {
    for (let y = 0; y < sizeY; y += 1) {
      const worldY = chunkY + y
      if (worldY > GROUND_LEVEL || worldY < GROUND_LEVEL - UNDERGROUND_DEPTH) {
        continue
      }

      const blockID = worldY === GROUND_LEVEL
        ? GRASS
        : worldY >= GROUND_LEVEL - 2
          ? DIRT
          : STONE

      for (let z = 0; z < sizeZ; z += 1) {
        data.set(x, y, z, blockID)
      }
    }
  }

  noa.world.setChunkData(requestID, data)
})


// Only edit while the mouse is captured, so clicking to enter the game is safe.
noa.inputs.down.on('fire', () => {
  if (!noa.container.hasPointerLock || !noa.targetedBlock) return
  const [x, y, z] = noa.targetedBlock.position
  const chunk = noa.world._getChunkByCoords(x, y, z)
  if (!chunk) return // chunk isn't loaded

  console.log('Chunk:', chunk)
  // Use chunk indexes to identify this chunk in the map.
  console.log('Chunk indexes:', [chunk.i, chunk.j, chunk.k])
  console.log('World origin:', chunk.pos)
  console.log('All block data:', chunk.voxels)

  // Read a block using coordinates local to this chunk:
  const blockID = chunk.voxels.get(
    x - chunk.x,
    y - chunk.y,
    z - chunk.z
  )
  console.log('Target block:', blockID)

  noa.setBlock(0, [x, y, z])
  saveChunk(chunk);
  recordBlockEvent('block_broken', x, y, z).catch(console.error);
})

noa.inputs.down.on('alt-fire', () => {
  if (!noa.container.hasPointerLock || !noa.targetedBlock) return

  const [x, y, z] = noa.targetedBlock.adjacent
  const chunk = noa.world._getChunkByCoords(x, y, z)
  if (!chunk) return // chunk isn't loaded

  console.log('Chunk:', chunk)
  // Use chunk indexes to identify this chunk in the map.
  console.log('Chunk indexes:', [chunk.i, chunk.j, chunk.k])
  console.log('World origin:', chunk.pos)
  console.log('All block data:', chunk.voxels)

  const position = noa.targetedBlock.adjacent
  if (noa.getBlock(position) !== 0) return

  // addBlock checks entity collisions so we cannot build inside the player.
  if (noa.addBlock(GRASS, position) === GRASS) {
    saveChunk(chunk);

    recordBlockEvent('block_placed', x, y, z).catch(console.error);
  }
})


window.addEventListener('pagehide', () => {
  endSession().catch(error => {
    console.error('Could not end session:', error);
  });
});

// End the session before returning home.
const exitButton = document.createElement('button');
exitButton.textContent = 'Exit to Home';

Object.assign(exitButton.style, {
  position: 'fixed',
  right: '20px',
  bottom: '20px',
  zIndex: '1000',
  padding: '12px 20px',
  background: '#284c32',
  color: 'white',
  border: '1px solid white',
  borderRadius: '8px',
  cursor: 'pointer',
  fontSize: '16px'
});

document.body.appendChild(exitButton);

exitButton.addEventListener('mousedown', event => {
  event.stopPropagation();
});

exitButton.addEventListener('click', async event => {
  event.stopPropagation();
  exitButton.disabled = true;
  exitButton.textContent = 'Ending session…';

  try {
    if (sessionId === null) {
      throw new Error('No active session. Check the backend connection.');
    }

    await saveQueue;
    await endSession();

    window.location.href = '/';
  } catch (error) {
    console.error('Could not exit:', error);
    exitButton.disabled = false;
    exitButton.textContent = 'Retry Exit to Home';
  }
});

export default noa
