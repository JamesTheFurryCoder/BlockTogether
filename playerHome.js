import { Engine } from 'noa-engine'

function create3DArray(x, y, z, initialValue = 0) {
  return Array.from({ length: x }, () =>
    Array.from({ length: y }, () =>
      Array(z).fill(initialValue)
    )
  );
}

const x = 100;
const y = 100;
const z = 100;

// in the future, we will use this to serialize and save into playerSaveData.
const grid = create3DArray(x, y, z);

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

noa.world.on('worldDataNeeded', (requestID, data, chunkX, chunkY, chunkZ) => {
  const [sizeX, sizeY, sizeZ] = data.shape

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
  // use chunk index to save into our array we made at initialization of game
  console.log('Chunk indexes:', [chunk.i, chunk.j, chunk.k])
  console.log('World origin:', chunk.pos)
  // we use this actual data from to do grid[x][y][z] = chunk.voxels
  console.log('All block data:', chunk.voxels)

  // store data into grid array.
  grid[chunk.i][chunk.j][chunk.z] = chunk.voxels;

  // Read a block using coordinates local to this chunk:
  const blockID = chunk.voxels.get(
    x - chunk.x,
    y - chunk.y,
    z - chunk.z
  )
  console.log('Target block:', blockID)

  noa.setBlock(0, [x, y, z])
})

noa.inputs.down.on('alt-fire', () => {
  if (!noa.container.hasPointerLock || !noa.targetedBlock) return

  const [x, y, z] = noa.targetedBlock.adjacent
  const chunk = noa.world._getChunkByCoords(x, y, z)
  if (!chunk) return // chunk isn't loaded

  console.log('Chunk:', chunk)
  // use chunk index to save into our array we made at initialization of game
  console.log('Chunk indexes:', [chunk.i, chunk.j, chunk.k])
  console.log('World origin:', chunk.pos)
  // we use this actual data from to do grid[x][y][z] = chunk.voxels
  console.log('All block data:', chunk.voxels)

  // store data into grid array.
  grid[chunk.i][chunk.j][chunk.z] = chunk.voxels;

  const position = noa.targetedBlock.adjacent
  if (noa.getBlock(position) !== 0) return

  // addBlock checks entity collisions so we cannot build inside the player.
  noa.addBlock(GRASS, position)
})

export default noa