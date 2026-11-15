import { Engine } from 'noa-engine'
import { Entity } from './entity.js'

// Inclusive wall coordinates; height is measured above the ground.
const WORLD_BORDER = {
  minX: -32,
  maxX: 32,
  minZ: -32,
  maxZ: 32,
  height: 16,
  opacity: 0.25, // Use 0 < opacity <= 1; lower values are more transparent.
}

const noa = new Engine({
  debug: false,
  // noa positions are measured at the bottom center of the player.
  playerStart: [0.5, 1.01, 0.5],
  chunkAddDistance: [2, 1],
  chunkRemoveDistance: [3, 2],
})

noa.registry.registerMaterial('ground', { color: [0.3, 0.65, 0.3] })
noa.registry.registerBlock(1, { material: 'ground', solid: true, opaque: true })

// noa takes material opacity as the fourth color component.
noa.registry.registerMaterial('border', { color: [0.4, 0.75, 1, WORLD_BORDER.opacity] })
noa.registry.registerBlock(2, { material: 'border', solid: true, opaque: false })

noa.world.on('worldDataNeeded', (requestID, data, chunkX, chunkY, chunkZ) => {
  const [sizeX, sizeY, sizeZ] = data.shape

  // Solid ground through world Y = 0, with air above it.
  for (let x = 0; x < sizeX; x++) {
    const worldX = chunkX + x
    for (let z = 0; z < sizeZ; z++) {
      const worldZ = chunkZ + z
      const onBorder = (
        ((worldX === WORLD_BORDER.minX || worldX === WORLD_BORDER.maxX)
          && worldZ >= WORLD_BORDER.minZ && worldZ <= WORLD_BORDER.maxZ)
        || ((worldZ === WORLD_BORDER.minZ || worldZ === WORLD_BORDER.maxZ)
          && worldX >= WORLD_BORDER.minX && worldX <= WORLD_BORDER.maxX)
      )

      for (let y = 0; y < sizeY; y++) {
        const worldY = chunkY + y
        let block = worldY <= 0 ? 1 : 0
        if (onBorder && worldY > 0 && worldY <= WORLD_BORDER.height) block = 2
        data.set(x, y, z, block)
      }
    }
  }

  noa.world.setChunkData(requestID, data)
})

// Example: a box that follows the player and stops two blocks away.
// Pass the engine first; omit model to use Entity's default box.
const exampleEntity = new Entity(noa, {
  position: [5, 1.01, 5],
  width: 1,
  height: 1.5,
  color: [0.9, 0.35, 0.2],
  movement: { maxSpeed: 3 },
})

exampleEntity.rigMovement(self => {
  //self.moveToward(noa.playerEntity, 2)
  self.lookAt(noa.playerEntity)
})

document.addEventListener('keydown', event => {
  if (event.code === 'Space') {
    exampleEntity.jump()
  }
  if(event.code === 'KeyR') {
    exampleEntity.moveToward(noa.playerEntity, 2);
  }
  if(event.code === 'KeyF') {
    exampleEntity.stop();
  }

})


const exitButton = document.createElement('button')
exitButton.type = 'button'
exitButton.textContent = 'Exit to Home'
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
  fontSize: '16px',
})
document.body.appendChild(exitButton)

exitButton.addEventListener('mousedown', event => {
  event.stopPropagation()
})

exitButton.addEventListener('click', event => {
  event.stopPropagation()
  if (document.pointerLockElement) document.exitPointerLock()
  window.location.href = '/'
})
