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
const GROUND_LEVEL = 0;
const UNDERGROUND_DEPTH = 4;
const TERRAIN_BLOCKS = { surface: 8, middle: 18, bottom: 16 };
function terrainBlock(y) {
  if (y > GROUND_LEVEL || y < GROUND_LEVEL - UNDERGROUND_DEPTH) return 0;
  if (y === GROUND_LEVEL) return TERRAIN_BLOCKS.surface;
  return y >= GROUND_LEVEL - 2 ? TERRAIN_BLOCKS.middle : TERRAIN_BLOCKS.bottom;
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
      const { x, y, z } = block;
      const blockId = replaceLegacyBlockId(block.blockId);
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
    for (const [key, savedBlocks] of pending) {
      const blocks = savedBlocks.map(replaceLegacyBlockId);
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

// Keep palette IDs stable: saved worlds store these numbers.
const blockSets = [
  [
    { id: 4, name: 'Red', color: '#e53935' },
    { id: 5, name: 'Orange', color: '#fb8c00' },
    { id: 6, name: 'Yellow', color: '#fdd835' },
    { id: 7, name: 'Lime', color: '#a3d93b' },
    { id: 8, name: 'Green', color: '#43a047' },
    { id: 9, name: 'Cyan', color: '#26c6da' },
    { id: 10, name: 'Sky Blue', color: '#64b5f6' },
    { id: 11, name: 'Blue', color: '#3949db' },
    { id: 12, name: 'Purple', color: '#8e24aa' },
    { id: 13, name: 'Pink', color: '#f48fb1' },
  ],
  [
    { id: 14, name: 'White', color: '#f5f5f5' },
    { id: 15, name: 'Light Gray', color: '#bdbdbd' },
    { id: 16, name: 'Gray', color: '#616161' },
    { id: 17, name: 'Black', color: '#212121' },
    { id: 18, name: 'Brown', color: '#795548' },
    { id: 19, name: 'Tan', color: '#d7b58c' },
    { id: 20, name: 'Navy', color: '#1a2c64' },
    { id: 21, name: 'Teal', color: '#00897b' },
    { id: 22, name: 'Magenta', color: '#d81b91' },
    { id: 23, name: 'Glass', color: '#c4e8f5', glass: true },
  ],
]
const placeableBlocks = blockSets.flat()
// Load old grass, dirt, and stone saves as their closest palette colors.
function replaceLegacyBlockId(id) {
  return ({ 1: TERRAIN_BLOCKS.surface, 2: TERRAIN_BLOCKS.middle, 3: TERRAIN_BLOCKS.bottom })[id] ?? id
}
const slotKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
let activeSet = 0
let selectedSlot = 0

const gridReady = loadGrid();

const noa = new Engine({
  debug: false,
  playerStart: [0, 3, 0],
  chunkAddDistance: [1, 1],
  chunkRemoveDistance: [2, 2],
})

for (const block of placeableBlocks) {
  const material = `palette-${block.id}`
  const color = block.color.match(/[0-9a-f]{2}/gi).map(hex => parseInt(hex, 16) / 255)
  // noa-engine reads a fourth color component as material transparency.
  if (block.glass) color.push(0.3)
  noa.registry.registerMaterial(material, { color })
  noa.registry.registerBlock(block.id, {
    material,
    solid: true,
    opaque: !block.glass,
  })
}

const palette = document.createElement('div')
palette.className = 'block-palette'
const paletteLabel = document.createElement('div')
paletteLabel.className = 'palette-label'
paletteLabel.setAttribute('role', 'status')
palette.appendChild(paletteLabel)
const paletteSlots = document.createElement('div')
paletteSlots.className = 'palette-slots'
palette.appendChild(paletteSlots)
const swatches = slotKeys.map(key => {
  const swatch = document.createElement('div')
  swatch.className = 'palette-slot'
  const keyLabel = document.createElement('span')
  keyLabel.textContent = key
  swatch.appendChild(keyLabel)
  paletteSlots.appendChild(swatch)
  return swatch
})
document.body.appendChild(palette)

function updatePalette() {
  const blocks = blockSets[activeSet]
  paletteLabel.textContent = `Set ${activeSet + 1}/2 · ${blocks[selectedSlot].name} · Tab: switch set`
  swatches.forEach((swatch, index) => {
    const block = blocks[index]
    swatch.className = `palette-slot${index === selectedSlot ? ' selected' : ''}${block.glass ? ' glass' : ''}`
    swatch.style.backgroundColor = block.glass ? 'rgb(196 232 245 / 30%)' : block.color
    swatch.title = `${slotKeys[index]}: ${block.name}`
    swatch.setAttribute('aria-label', swatch.title)
  })
}

function keyboardEvent(event) {
  if (!noa.container.hasPointerLock || event.ctrlKey || event.altKey || event.metaKey) return
  const slot = slotKeys.indexOf(event.key)
  if (event.key !== 'Tab' && slot === -1) return
  // Keep Tab in the game while playing; allow normal focus navigation after Esc.
  event.preventDefault()
  if (event.repeat) return
  if (event.key === 'Tab') {
    activeSet = (activeSet + 1) % blockSets.length
  } else {
    selectedSlot = slot
  }
  updatePalette()
}

document.addEventListener('keydown', keyboardEvent)
updatePalette()

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

      for (let z = 0; z < sizeZ; z += 1) {
        data.set(x, y, z, terrainBlock(worldY))
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
  const selectedBlock = blockSets[activeSet][selectedSlot].id
  if (noa.addBlock(selectedBlock, position) === selectedBlock) {
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
