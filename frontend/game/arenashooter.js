import { Engine } from 'noa-engine'
import { Entity } from './entity.js'
import { enemy } from './enemyArenaShooter.js'

const PLAYER_BULLET_SPEED = 20
// Times are in milliseconds; speeds are in world units per second.
const ARENA = {
  firstWaveEnemies: 3,
  extraEnemiesPerWave: 2,
  waveBreak: 4000,
  spawnInterval: 400,
  enemyHealth: 100,
  enemySpeed: 3,
  enemyBulletSpeed: 12,
  bulletDamage: 10,
  bulletLifetime: 3000, // Remove every bullet after 3 seconds, even if it misses.
  groundY: 1.01, // Bottom-center height just above the flat ground.
  fallResetY: 0, // Recover enemies that fall through an unloaded chunk.
}

// Inclusive wall coordinates; height is measured above the ground.
const WORLD_BORDER = {
  minX: -100,
  maxX: 100,
  minZ: -100,
  maxZ: 100,
  height: 16,
  opacity: 0.25, // Use 0 < opacity <= 1; lower values are more transparent.
}

const noa = new Engine({
  debug: false,
  // noa positions are measured at the bottom center of the player.
  playerStart: [0.5, ARENA.groundY, 0.5],
  chunkAddDistance: [2, 1],
  chunkRemoveDistance: [3, 2],
})

// noa creates the player directly, so it has no Entity wrapper to hold its name.
const player = {
  id: noa.playerEntity,
  entityName: 'player',
}

let playerHealth = 100
let wave = 0
let pendingEnemies = 0
let nextWaveIn = 1500
let nextSpawnIn = 0
let gameOver = false
// Keep AI state here so the enemy subclass only needs its health field.
const enemies = new Map()
const bullets = new Map()

/**
 * Spawn a small bullet at a bottom-center [x, y, z] position.
 * directionVector is a nonzero [x, y, z] array (or Babylon Vector3).
 * speed is in world units per second; the direction is normalized automatically.
 * Returns an Entity for collision handlers or destroy(). Impacts or the lifetime timer remove it.
 *
 * const bullet = spawnBullet([0, 3, 0], [1, 0, 0], 20, 'player-bullet')
 * bullet.onCollision(otherId => {
 *   const other = Entity.fromId(noa, otherId)
 *   console.log(other?.entityName)
 * })
 */
export function spawnBullet(position, directionVector, speed, entityName = 'bullet') {
  const direction = typeof directionVector?.asArray === 'function'
    ? directionVector.asArray() : directionVector
  if (!direction || direction.length !== 3 || !Array.from(direction).every(Number.isFinite)) {
    throw new TypeError('directionVector must contain three finite numbers.')
  }
  const length = Math.hypot(...direction)
  if (length === 0 || !Number.isFinite(length)) {
    throw new RangeError('directionVector must have a finite, nonzero length.')
  }
  if (!Number.isFinite(speed) || speed < 0) {
    throw new RangeError('speed must be a finite, nonnegative number.')
  }

  const bullet = new Entity(noa, {
    entityName,
    position,
    width: 0.15,
    height: 0.15,
    color: entityName === 'enemy-bullet' ? [1, 0.2, 0.3] : [1, 0.85, 0.2],
    gravityMultiplier: 0,
    movement: { standingFriction: 0 },
  })
  bullet.body.airDrag = 0
  bullet.body.fluidDrag = 0
  bullet.body.friction = 0
  bullet.setVelocity(Array.from(direction, component => (component / length) * speed))
  bullet.onTerrainCollision(() => bullet.destroy())
  bullet.onCollision(bulletHit)
  const expirationTimer = setTimeout(() => {
    bullet.destroy()
    bullets.delete(bullet)
  }, ARENA.bulletLifetime)
  bullets.set(bullet, expirationTimer)
  return bullet
}

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

function enemyHit(otherId, self) {
  const other = otherId === player.id ? player : Entity.fromId(noa, otherId)
  if (gameOver || self.destroyed || other?.entityName !== 'player-bullet') {
    return
  }
  //console.log(other?.entityName)
  self.health = Math.max(0, self.health - ARENA.bulletDamage)
  other.destroy() // One bullet can only deal damage once.
  if (self.health === 0) self.destroy()
}

function bulletHit(otherId, self) {
  if (gameOver || self.destroyed) return
  const other = otherId === player.id ? player : Entity.fromId(noa, otherId)
  if (self.entityName === 'enemy-bullet' && other === player) {
    playerHealth = Math.max(0, playerHealth - ARENA.bulletDamage)
    self.destroy()
    if (playerHealth === 0) {
      gameOver = true
      for (const target of enemies.keys()) {
        if (!target.destroyed) target.stop()
      }
      for (const [bullet, expirationTimer] of bullets) {
        clearTimeout(expirationTimer)
        bullet.destroy()
      }
      bullets.clear()
    }
    updateHud()
  }
  // Ignore the shooter, friendly units, and other bullets.
}

document.addEventListener('keydown', event => {
  if (gameOver && event.code === 'Enter') {
    window.location.reload()
  }
})

function checkIfOnlyCollidingPlayer(otherId, self) {
  if (gameOver || self.destroyed) return
  const other = otherId === player.id ? player : Entity.fromId(noa, otherId)
  // Both exclusions must hold; using || here would also destroy friendly shots.
  if (other?.entityName !== 'player-bullet' && other?.entityName !== 'player') {
    // Either side's callback can run first. Deal damage before removing the shot.
    if (other instanceof enemy) enemyHit(self.id, other)
    self.destroy()
  }
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min)
}

document.addEventListener('mousedown', event => {
  if (event.button !== 2) return
  event.preventDefault()
  if (gameOver) return
  const bullet = spawnBullet(
    noa.camera.getTargetPosition(), // Player's eye position in world coordinates.
    noa.camera.getDirection(),
    PLAYER_BULLET_SPEED,
    'player-bullet',
  )
  bullet.onCollision(checkIfOnlyCollidingPlayer)
})

function arenaPosition(x, z) {
  return [
    Math.max(WORLD_BORDER.minX + 2, Math.min(WORLD_BORDER.maxX - 2, x)),
    ARENA.groundY,
    Math.max(WORLD_BORDER.minZ + 2, Math.min(WORLD_BORDER.maxZ - 2, z)),
  ]
}

function spawnEnemy(playerPosition) {
  // Spawn near the player, on loaded ground, with space between enemies.
  for (let attempt = 0; attempt < 20; attempt++) {
    const angle = randomBetween(0, Math.PI * 2)
    const radius = randomBetween(14, 22)
    const position = arenaPosition(
      playerPosition[0] + Math.cos(angle) * radius,
      playerPosition[2] + Math.sin(angle) * radius,
    )
    if (Math.hypot(position[0] - playerPosition[0], position[2] - playerPosition[2]) < 10) continue
    if (noa.getBlock(Math.floor(position[0]), 0, Math.floor(position[2])) !== 1) continue
    if ([...enemies.keys()].some(target => !target.destroyed && target.distanceTo(position) < 2)) continue
    // Reuse the original example enemy setup for every enemy spawned by a wave.
    const exampleEntity = new enemy(noa, {
      entityName: 'enemy',
      position,
      health: ARENA.enemyHealth,
      width: 1,
      height: 1.5,
      color: [0.9, 0.35, 0.2],
      movement: { maxSpeed: ARENA.enemySpeed },
    })
    exampleEntity.rigMovement(self => {
      self.lookAt(noa.playerEntity)
    })
    exampleEntity.onCollision(enemyHit)

    enemies.set(exampleEntity, {
      decisionIn: 0,
      shootIn: randomBetween(1000, 2500),
      chasePlayer: false,
      destination: position,
    })
    return true
  }
  return false // Retry when chunks have loaded or space becomes available.
}

function shootAtPlayer(target, playerEyes) {
  const origin = target.position
  origin[1] += 1.1
  const direction = playerEyes.map((value, axis) => value - origin[axis])
  const length = Math.hypot(...direction)
  if (length < 0.001) return
  // Start just outside the enemy's body, aimed at the player's current position.
  const muzzle = origin.map((value, axis) => value + direction[axis] / length * 0.75)
  spawnBullet(muzzle, direction, ARENA.enemyBulletSpeed, 'enemy-bullet')
}

const arenaHud = document.createElement('div')
Object.assign(arenaHud.style, {
  position: 'fixed',
  left: '20px',
  top: '20px',
  zIndex: '1000',
  padding: '12px 16px',
  background: 'rgba(0, 0, 0, 0.65)',
  color: 'white',
  borderRadius: '8px',
  font: '16px sans-serif',
  whiteSpace: 'pre-line',
  pointerEvents: 'none',
})
document.body.appendChild(arenaHud)

function updateHud() {
  const alive = [...enemies.keys()].filter(target => !target.destroyed).length
  let message = `Health: ${playerHealth} | Wave: ${wave} | Enemies: ${alive + pendingEnemies}\nright click to shoot`
  if (gameOver) message += '\nGame over — press Enter to restart'
  else if (alive === 0 && pendingEnemies === 0) {
    message += `\nWave ${wave + 1} in ${Math.ceil(nextWaveIn / 1000)}s`
  }
  if (arenaHud.textContent !== message) arenaHud.textContent = message
}
updateHud()

noa.on('tick', dt => {
  // noa supplies a fixed tick duration in milliseconds.
  if (gameOver) return
  for (const [bullet, expirationTimer] of bullets) {
    if (bullet.destroyed) {
      clearTimeout(expirationTimer)
      bullets.delete(bullet)
    }
  }

  for (const target of enemies.keys()) {
    if (target.destroyed) {
      enemies.delete(target)
      continue
    }
    const position = target.position
    if (position[1] < ARENA.fallResetY) {
      position[1] = ARENA.groundY
      target.setPosition(position, true)
      target.body.velocity[1] = 0 // Keep horizontal movement, cancel the fall.
    }
  }
  const playerPosition = noa.entities.getPosition(player.id)
  if (enemies.size === 0 && pendingEnemies === 0) {
    nextWaveIn = Math.max(0, nextWaveIn - dt)
    if (nextWaveIn === 0) {
      wave++
      pendingEnemies = ARENA.firstWaveEnemies + (wave - 1) * ARENA.extraEnemiesPerWave
      nextSpawnIn = 0
      nextWaveIn = ARENA.waveBreak
    }
  }

  if (pendingEnemies > 0) {
    nextSpawnIn -= dt
    if (nextSpawnIn <= 0 && spawnEnemy(playerPosition)) {
      pendingEnemies--
      nextSpawnIn = ARENA.spawnInterval
    }
  }

  const playerEyes = noa.camera.getTargetPosition()
  for (const [target, ai] of enemies) {
    ai.decisionIn -= dt
    ai.shootIn -= dt
    if (ai.decisionIn <= 0) {
      ai.chasePlayer = Math.random() < 0.55
      const position = target.position
      ai.destination = arenaPosition(position[0] + randomBetween(-10, 10), position[2] + randomBetween(-10, 10))
      ai.decisionIn = randomBetween(1000, 3000)
    }
    target.moveToward(ai.chasePlayer ? playerPosition : ai.destination, ai.chasePlayer ? 8 : 0.5)
    if (ai.shootIn <= 0) {
      shootAtPlayer(target, playerEyes)
      ai.shootIn = randomBetween(1400, 2400)
    }
  }
  updateHud()
})

// Keep the browser menu from interrupting right-click shooting.
document.addEventListener('contextmenu', event => event.preventDefault())


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
