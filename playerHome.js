import { Engine } from 'noa-engine'

// Keys are chunk coordinates (for example, "0,-1,2"); values are plain block arrays.
const grid = new Map();
const pendingSaves = new Map();
const PENDING_SAVE_KEY = 'blocktogether:pending-chunks';
let saveQueue = Promise.resolve();

function chunkKey(i, j, k) {
  return `${i},${j},${k}`;
}

async function loadGrid() {
  try {
    const response = await fetch('/api/player-save');
    if (!response.ok) throw new Error('Could not load chunk data');
    const chunks = await response.json();

    // The JSON file stores chunks as chunks[i][j][k].
    for (const [i, rows] of Object.entries(chunks)) {
      for (const [j, columns] of Object.entries(rows)) {
        for (const [k, blocks] of Object.entries(columns)) {
          grid.set(chunkKey(i, j, k), blocks);
        }
      }
    }
  } catch (error) {
    console.error('Could not load playerSaveData/world.json:', error);
  }

  // A refresh can interrupt queued requests. Pending edits override older JSON data.
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

    const response = await fetch('/api/player-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indexes, blocks }),
    });
    if (!response.ok) throw new Error('Could not save chunk data');

    // An older response must not clear a newer edit's backup.
    if (pendingSaves.get(key) === blocks) {
      pendingSaves.delete(key);
      storePendingSaves();
    }
  }).catch(error => {
    console.error('Could not save playerSaveData/world.json:', error);
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
  }
})

export default noa
