import { Engine } from 'noa-engine'
import { Entity } from './entity.js'

const BLOCKS = { start: 1, platform: 2, lava: 3, medium: 4, long: 5, fork: 6 }
const PARKOUR = {
  spacing: 16, // Average stride; individual platform starts are offset below.
  baseY: 7,
  lavaY: 0,
  seed: 460,
  walkSpeed: 7,
  sprintSpeed: 11,
  jumpImpulse: 9,
  jumpBuffer: 120, // milliseconds; an early press carries through landing.
  coyoteTime: 100, // milliseconds to jump after leaving an edge.
  chaseDelay: 3000,
}

// Hash the index instead of consuming Math.random() while loading chunks.
// Platforms then regenerate identically regardless of chunk request order.
function platformRandom(index) {
  let value = (index ^ PARKOUR.seed) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return (value ^ (value >>> 15)) >>> 0
}

function platformZ(index) {
  if (index === 0) return 0
  if (index === 1) return 10
  return index * PARKOUR.spacing + (platformRandom(index + 11) % 5) - 2
}

export function getPlatformIndex(worldZ) {
  if (worldZ < 0 || !Number.isFinite(worldZ)) return -1
  // Starts move up to two blocks either side of the average stride. Correct
  // this estimate locally instead of storing or walking the whole course.
  let index = Math.floor(worldZ / PARKOUR.spacing)
  while (platformZ(index) > worldZ) index--
  while (platformZ(index + 1) <= worldZ) index++
  return index
}

function routesAt(index) {
  const routes = []
  function visit(id, parentId, turns) {
    const depth = turns.length
    const forkAt = depth === 0 ? 1 : depth === 1 ? 14 + platformRandom(id) % 7
      : depth === 2 ? 36 + platformRandom(id) % 11 : Infinity
    if (index < forkAt) routes.push({ id, parentId, turns, forkAt })
    else {
      for (const direction of [-1, 1]) {
        visit(id * 2 + (direction === 1 ? 1 : 0), id,
          [...turns, { at: forkAt, direction, slope: [3, 1, 0.5][depth] }])
      }
    }
  }
  // Three genuine forks produce eight independent endless journeys. Keeping
  // a bounded tree avoids generating exponentially many unseen platforms.
  visit(1, null, [])
  return routes
}

function platformShape(index, route) {
  const random = platformRandom(index + route.id * 107)
  const fork = index + 1 === route.forkAt
  const width = index === 0 ? 11 : fork ? 11 : 5 + 2 * ((random >>> 7) % 3)
  // Every turn permanently adds to the route's heading. Sibling routes keep
  // spreading apart; there are no neighboring lanes or scheduled reunions.
  const offset = route.turns.reduce((x, turn) =>
    x + turn.direction * (3 + (index - turn.at) * turn.slope), 0)
  const center = Math.round(offset + Math.sin(index * 0.28) * 1.25) + 0.5
  return {
    index,
    routeId: route.id,
    parentId: route.parentId,
    x: center - width / 2,
    y: PARKOUR.baseY + (index < 3 ? 0 : platformRandom(Math.floor(index / 6) + route.id * 71) % 2),
    z: platformZ(index),
    width,
    fork,
  }
}

export function getPlatforms(index) {
  if (!Number.isSafeInteger(index) || index < 0) return []
  const nextShapes = routesAt(index + 1).map(route => platformShape(index + 1, route))
  return routesAt(index).map(route => {
    const pad = platformShape(index, route)
    const next = nextShapes.filter(target => target.routeId === route.id || target.parentId === route.id)
    const random = platformRandom(index + route.id * 251)
    // A deliberate mix of easy 1-2, medium 3-4 and sprint-only 5-6 block gaps.
    let gap = 1 + (random % 6)
    for (const target of next) {
      const sidewaysGap = Math.max(0, target.x - pad.x - pad.width, pad.x - target.x - target.width)
      // Rising jumps and sharp turns get a shorter gap. Forks also leave room
      // to choose an exit rather than demanding a blind maximum-range leap.
      const budget = target.y > pad.y ? 4.5 : 6.3
      gap = Math.min(gap, Math.max(1, Math.floor(Math.sqrt(Math.max(0, budget ** 2 - sidewaysGap ** 2)))))
    }
    if (pad.fork) gap = Math.min(gap, 3)
    const stride = platformZ(index + 1) - pad.z
    gap = Math.min(gap, stride - 8)
    if (index === 0) gap = 2
    return {
      ...pad,
      gap,
      length: stride - gap,
      block: index === 0 ? BLOCKS.start : pad.fork ? BLOCKS.fork
        : gap >= 5 ? BLOCKS.long : gap >= 3 ? BLOCKS.medium : BLOCKS.platform,
    }
  })
}

export function getPlatform(index, routeId) {
  const platforms = getPlatforms(index)
  return (routeId === undefined ? platforms[0] : platforms.find(pad => pad.routeId === routeId)) ?? null
}

export function getNextPlatforms(platform) {
  return getPlatforms(platform.index + 1).filter(pad =>
    pad.routeId === platform.routeId || pad.parentId === platform.routeId)
}

function platformSpawn(platform) {
  // noa positions are the bottom center of the player.
  return [platform.x + platform.width / 2, platform.y + 1.01, platform.z + platform.length / 2]
}

const noa = new Engine({
  debug: false,
  playerStart: platformSpawn(getPlatform(0)),
  chunkAddDistance: [2, 1],
  chunkRemoveDistance: [3, 2],
})

// Register every material and block before requesting any world data.
for (const [name, color] of Object.entries({
  start: [0.2, 0.8, 0.35],
  platform: [0.25, 0.65, 0.95],
  lava: [1, 0.25, 0.02],
  medium: [0.7, 0.4, 0.95],
  long: [1, 0.65, 0.1],
  fork: [0.2, 0.8, 0.7],
})) {
  const material = `parkour-${name}`
  noa.registry.registerMaterial(material, { color })
  noa.registry.registerBlock(BLOCKS[name], { material, solid: true, opaque: true })
}

const movement = noa.entities.getMovement(noa.playerEntity)
Object.assign(movement, {
  maxSpeed: PARKOUR.walkSpeed,
  moveForce: 100,
  responsiveness: 24,
  airMoveMult: 0.8,
  runningFriction: 0,
  standingFriction: 6,
  // Jump timing is handled below for buffering and coyote time. Disable noa's
  // additional jump forces so taps and held jumps follow the same arc.
  jumpImpulse: 0,
  jumpForce: 0,
  jumpTime: 0,
  airJumps: 0,
})
const playerBody = noa.entities.getPhysicsBody(noa.playerEntity)
Object.assign(playerBody, { gravityMultiplier: 2.4, airDrag: 0.02, autoStep: false, restitution: 0 })

let jumpBuffer = 0
let coyoteTime = 0

function updatePlayerMovement(dt) {
  const grounded = playerBody.atRestY() < 0
  coyoteTime = grounded ? PARKOUR.coyoteTime : Math.max(0, coyoteTime - dt)
  jumpBuffer = noa.inputs.state.jump ? PARKOUR.jumpBuffer : Math.max(0, jumpBuffer - dt)
  if (jumpBuffer > 0 && coyoteTime > 0) {
    playerBody.velocity[1] = Math.max(0, playerBody.velocity[1])
    playerBody.applyImpulse([0, PARKOUR.jumpImpulse, 0])
    jumpBuffer = 0
    coyoteTime = 0
  }
  // Friction handles ground stops; this brake also lets players release W
  // or reverse direction in midair without sliding uncontrollably off a pad.
  if (!grounded && !movement.running) {
    playerBody.applyForce([-playerBody.velocity[0] * 10, 0, -playerBody.velocity[2] * 10])
  }
}

const heldShiftKeys = new Set()

function updateSprint(event) {
  if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') return
  if (event.type === 'keydown') heldShiftKeys.add(event.code)
  else heldShiftKeys.delete(event.code)
  movement.maxSpeed = heldShiftKeys.size > 0 ? PARKOUR.sprintSpeed : PARKOUR.walkSpeed
}

function stopSprinting() {
  heldShiftKeys.clear()
  movement.maxSpeed = PARKOUR.walkSpeed
  jumpBuffer = 0
}

document.addEventListener('keydown', updateSprint)
document.addEventListener('keyup', updateSprint)
// A key release can be missed when switching tabs or releasing the mouse.
window.addEventListener('blur', stopSprinting)
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) stopSprinting()
})

export function worldPlatformAlgorithm(requestID, data, chunkX, chunkY, chunkZ) {
  const [sizeX, sizeY, sizeZ] = data.shape

  // Locate variable platform starts by world coordinate, including gaps and
  // chunk seams; no ever-growing platform list is needed.
  for (let z = 0; z < sizeZ; z++) {
    const worldZ = chunkZ + z
    const platforms = getPlatforms(getPlatformIndex(worldZ))
    for (let x = 0; x < sizeX; x++) {
      const worldX = chunkX + x
      const columnPlatforms = platforms.filter(pad => worldZ >= pad.z && worldZ < pad.z + pad.length
        && worldX >= pad.x && worldX < pad.x + pad.width)

      for (let y = 0; y < sizeY; y++) {
        const worldY = chunkY + y
        let block = worldY <= PARKOUR.lavaY ? BLOCKS.lava : 0
        const platform = columnPlatforms.find(pad => worldY === pad.y)
        if (platform) block = platform.block
        data.set(x, y, z, block)
      }
    }
  }

  noa.world.setChunkData(requestID, data)
}

noa.world.on('worldDataNeeded', worldPlatformAlgorithm)

function chaserSpawn() {
  const start = platformSpawn(getPlatform(0))
  return [start[0], start[1] + 0.2, start[2] - 18]
}

// A hovering pursuer can follow any chosen route without getting stuck in lava.
// Use the shared Entity wrapper for its model, bounds, and noa position.
export const chaser = new Entity(noa, {
  entityName: 'parkour-chaser',
  position: chaserSpawn(),
  width: 1.2,
  height: 1.6,
  color: [1, 0.15, 0.25],
  physics: false,
})

const guide = document.createElement('div')
Object.assign(guide.style, {
  position: 'fixed',
  top: '16px',
  left: '16px',
  zIndex: '1000',
  padding: '10px 14px',
  background: 'rgb(15 23 42 / 85%)',
  color: 'white',
  borderRadius: '8px',
  font: '14px/1.5 "Segoe UI", sans-serif',
  whiteSpace: 'pre-line',
  pointerEvents: 'none',
})
document.body.appendChild(guide)

let bestPlatform = 0
let falls = 0
let catches = 0
let chaseDelay = PARKOUR.chaseDelay
let chaseStarted = false
let lastReset = 'Choose a direction at teal forks. Each route leads away into its own journey.'

function resetRun(reason) {
  noa.entities.setPosition(noa.playerEntity, platformSpawn(getPlatform(0)))
  playerBody.velocity.fill(0)
  playerBody.applyImpulse([0, 0, 0])
  movement.running = false
  movement.jumping = false
  jumpBuffer = 0
  coyoteTime = 0
  noa.camera.heading = 0
  noa.camera.pitch = 0
  chaser.setPosition(chaserSpawn())
  chaseDelay = PARKOUR.chaseDelay
  chaseStarted = false
  if (reason === 'lava') falls++
  else catches++
  lastReset = reason === 'lava' ? 'Lava! Back to the beginning.' : 'Caught! Back to the beginning.'
  updateGuide()
}

function updateGuide() {
  const distance = Math.floor(chaser.distanceTo(noa.playerEntity))
  const chaseStatus = !chaseStarted ? 'Move to start the chase'
    : chaseDelay > 0 ? `Head start: ${Math.ceil(chaseDelay / 1000)}s` : `Chaser: ${distance} blocks away`
  const message = `Endless Parkour | Best platform: ${bestPlatform} | Falls: ${falls} | Caught: ${catches}\n`
    + 'WASD: move | Mouse: look | Space: jump (hold to repeat) | Hold Shift: sprint\n'
    + 'Blue: short hop | Purple: medium jump | Gold: sprint jump | Teal: fork | Esc: release mouse\n'
    + `${chaseStatus}. Lava or getting caught restarts the run.\n${lastReset}`
  if (guide.textContent !== message) guide.textContent = message
}
updateGuide()

noa.on('tick', dt => {
  const position = noa.entities.getPosition(noa.playerEntity)
  const body = noa.entities.getPhysicsBody(noa.playerEntity)

  // Also catches falls below the lava if a chunk has not finished loading.
  if (position[1] <= PARKOUR.lavaY + 1.05) {
    resetRun('lava')
    return
  }

  updatePlayerMovement(dt)

  // Count progress only after actually landing, never while flying over it.
  const platform = getPlatforms(getPlatformIndex(position[2])).find(pad =>
    Math.abs(position[1] - (pad.y + 1)) < 0.1
    && position[0] >= pad.x && position[0] < pad.x + pad.width
    && position[2] >= pad.z && position[2] < pad.z + pad.length)
  if (platform && body.atRestY() < 0) {
    if (platform.index > bestPlatform) {
      bestPlatform = platform.index
      updateGuide()
    }
  }

  // Releasing the mouse or switching apps gives the player time to pause.
  if (!noa.container.hasPointerLock || !noa.container.isFocused) return
  if (movement.running) chaseStarted = true
  if (chaseStarted) {
    if (chaseDelay > 0) chaseDelay = Math.max(0, chaseDelay - dt)
    else {
      const origin = chaser.position
      const target = [position[0], position[1] + 0.2, position[2]]
      const distance = Math.hypot(...target.map((value, axis) => value - origin[axis]))
      // A nearby chaser is slower than walking. Farther away it closes the
      // distance gradually, with no teleporting and a speed below sprinting.
      const speed = Math.min(9, 5.5 + Math.max(0, distance - 12) * 0.14)
      const step = Math.min(distance, speed * dt / 1000)
      if (distance > 0) {
        chaser.setPosition(origin.map((value, axis) => value + (target[axis] - value) / distance * step))
      }
      chaser.lookAt(noa.playerEntity)
      if (chaser.collidesWith(noa.playerEntity)) {
        resetRun('caught')
        return
      }
    }
  }
  updateGuide()
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

export default noa
