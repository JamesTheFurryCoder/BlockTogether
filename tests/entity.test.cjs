const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { buildSync } = require('../frontend/node_modules/esbuild')

// Bundle the real ESM dependencies as Vite does, then exercise noa's actual
// components/physics with Babylon's headless engine rather than mock entities.
const bundle = buildSync({
  stdin: {
    contents: `
      export { Entity } from './game/entity.js'
      export { enemy as Enemy } from './game/enemyArenaShooter.js'
      export { Entities } from 'noa-engine/src/lib/entities.js'
      export { Physics } from 'voxel-physics-engine'
      export { NullEngine } from '@babylonjs/core/Engines/nullEngine'
      export { Scene } from '@babylonjs/core/scene'
      export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
      export { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
    `,
    resolveDir: path.join(__dirname, '../frontend'),
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
})
const runtime = new Module(__filename + '.runtime', module)
runtime._compile(bundle.outputFiles[0].text, __filename + '.runtime')
const { Entity, Enemy, Entities, Physics, NullEngine, Scene, StandardMaterial, CreateBox } = runtime.exports

function world(t, origin = [0, 0, 0]) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const noa = new EventEmitter()
  const owned = []
  Object.assign(noa, {
    worldOriginOffset: [...origin],
    globalToLocal(position, unused, result) {
      for (let axis = 0; axis < 3; axis++) result[axis] = position[axis] - this.worldOriginOffset[axis]
      return result
    },
    camera: { currentZoom: 10, _localGetPosition: () => [0, 0, 0] },
    inputs: { state: {} },
    getBlock: (x, y, z) => y < 0 ? 1 : 0,
    registry: { getBlockSolidity: id => id === 1 },
    rendering: {
      getScene: () => scene,
      makeStandardMaterial: name => new StandardMaterial(name, scene),
      addMeshToScene() {},
      setMeshVisibility: (mesh, visible) => mesh.setEnabled(visible),
    },
  })
  noa.physics = new Physics({}, (x, y, z) => noa.getBlock(x + origin[0], y + origin[1], z + origin[2]) === 1, () => false)
  noa.entities = noa.ents = new Entities(noa, {})
  const spawn = (options, EntityClass = Entity) => {
    const entity = new EntityClass(noa, options)
    owned.push(entity)
    return entity
  }
  const tick = (count = 1, dt = 1000 / 60) => {
    for (let frame = 0; frame < count; frame++) {
      noa.physics.tick(dt)
      noa.entities.tick(dt)
      noa.emit('tick', dt)
    }
  }
  t.after(() => {
    owned.forEach(entity => entity.destroy())
    scene.dispose()
    engine.dispose()
  })
  return { noa, scene, spawn, tick }
}

test('default box matches its collider and bottom-center mesh offset', t => {
  const { noa, spawn } = world(t)
  const entity = spawn({ position: [3, 4, 5], width: 2, height: 3 })
  assert.deepEqual(entity.position, [3, 4, 5])
  assert.deepEqual(entity.mesh.position.asArray(), [3, 5.5, 5])
  assert.deepEqual(entity.getBounds(), { base: [2, 4, 4], max: [4, 7, 6] })
  assert.equal(noa.entities.hasPhysics(entity.id), true)
  const copy = entity.position
  copy[0] = 99
  assert.equal(entity.position[0], 3)
  entity.setVisible(false)
  assert.equal(entity.mesh.isEnabled(), false)
})

test('custom models and factories accept offsets without physics', t => {
  const { noa, scene, spawn } = world(t)
  const model = CreateBox('custom', {}, scene)
  const material = new StandardMaterial('caller-owned', scene)
  model.material = material
  const entity = spawn({ model, physics: false, meshOffset: [0, 0, 0] })
  assert.equal(entity.mesh, model)
  assert.equal(entity.body, null)
  assert.throws(() => entity.move(1, 0), /physics enabled/)
  assert.throws(() => entity.onTerrainCollision(() => {}), /physics enabled/)
  let context
  const other = spawn({ model: options => { context = options; return CreateBox('factory', {}, scene) } })
  assert.equal(context.noa, noa)
  assert.equal(context.width, 1)
  assert.equal(other.mesh.name, 'factory')
  entity.destroy()
  assert.equal(model.isDisposed(), true)
  assert.ok(scene.materials.includes(material))
})

test('names stay synchronized with Babylon and collision IDs resolve per engine', t => {
  const { noa, scene, spawn, tick } = world(t)
  const entity = spawn({ entityName: 'bullet', physics: false })
  const enemy = spawn({
    entityName: 'enemy', physics: false, model: CreateBox('original', {}, scene),
  })
  assert.equal(scene.getMeshByName('bullet'), entity.mesh)
  assert.equal(enemy.mesh.name, 'enemy')
  entity.entityName = 'player-bullet'
  assert.equal(entity.mesh.name, 'player-bullet')
  enemy.mesh.name = 'boss'
  let hitName
  entity.onCollision(id => { hitName = Entity.fromId(noa, id)?.entityName })
  tick()
  assert.equal(hitName, 'boss')
  assert.equal(Entity.fromId(world(t).noa, entity.id), undefined)
  assert.throws(() => { entity.entityName = ' ' }, /nonempty string/)
  assert.throws(() => new Entity(noa, { entityName: 123 }), /nonempty string/)
  enemy.destroy()
  assert.equal(Entity.fromId(noa, enemy.id), undefined)
  const raw = noa.entities.add([10, 2, 0], 1, 1)
  assert.equal(Entity.fromId(noa, raw), undefined)
  noa.entities.deleteEntity(raw)
})

// Run the arena's actual spawn function with real Entity/physics, while replacing
// browser startup with a headless world, as in the maze integration tests.
function arena(t, random = () => 0.5) {
  const state = world(t)
  const { noa, spawn } = state
  noa.registry.registerMaterial = () => {}
  noa.registry.registerBlock = () => {}
  noa.world = { on() {} }
  // Like the actual engine, the player is a raw noa entity, not an Entity wrapper.
  noa.playerEntity = noa.entities.add([0.5, 1.01, 0.5], 0.6, 1.8)
  noa.entities.addComponent(noa.playerEntity, noa.entities.names.collideEntities)
  t.after(() => noa.entities.deleteEntity(noa.playerEntity))
  noa.getBlock = (x, y, z) => y <= 0 ? 1 : 0
  noa.camera.getTargetPosition = () => {
    const position = [...noa.entities.getPosition(noa.playerEntity)]
    position[1] += 1.62
    return position
  }
  noa.camera.getDirection = () => [1, 0, 0]
  const source = fs.readFileSync(path.join(__dirname, '../frontend/game/arenashooter.js'), 'utf8')
    .replace("import { Engine } from 'noa-engine'", '')
    .replace("import { Entity } from './entity.js'", '')
    .replace("import { enemy } from './enemyArenaShooter.js'", '')
    .replace('export function spawnBullet', 'function spawnBullet')
  const ArenaEntity = function (engine, options) { assert.equal(engine, noa); return spawn(options) }
  ArenaEntity.fromId = Entity.fromId
  const ArenaEnemy = function (engine, options) { assert.equal(engine, noa); return spawn(options, Enemy) }
  ArenaEnemy.prototype = Enemy.prototype
  const events = new Map()
  const context = vm.createContext({
    Engine: function () { return noa },
    Entity: ArenaEntity,
    enemy: ArenaEnemy,
    Math: Object.assign(Object.create(Math), { random }),
    setTimeout,
    clearTimeout,
    document: {
      createElement: () => ({ style: {}, addEventListener() {} }),
      addEventListener: (name, callback) => events.set(name, callback),
      body: { appendChild() {} },
    },
  })
  vm.runInContext(source + `
    globalThis.game = {
      spawnBullet, enemies, bullets, enemyHit, arenaHud,
      get wave() { return wave },
      get pendingEnemies() { return pendingEnemies },
      get playerHealth() { return playerHealth },
      get gameOver() { return gameOver },
    }
  `, context)
  t.after(() => {
    for (const timer of context.game.bullets.values()) clearTimeout(timer)
  })
  return { ...state, ...context.game, game: context.game, events }
}

test('arena waves wait for loaded ground and grow after all enemies are cleared', t => {
  let index = 0
  const { noa, game, tick } = arena(t, () => ((index++ * 0.137) + 0.1) % 1)
  noa.getBlock = () => 0
  tick(90)
  assert.equal(game.wave, 1)
  assert.equal(game.enemies.size, 0)
  assert.equal(game.pendingEnemies, 3)
  noa.getBlock = (x, y, z) => y <= 0 ? 1 : 0
  tick(60)
  assert.equal(game.enemies.size, 3)
  assert.equal(game.pendingEnemies, 0)
  assert.ok([...game.enemies.keys()].every(target => target.health === 100))
  tick(30)
  assert.equal(game.wave, 1, 'a live enemy prevents wave advancement')
  for (const target of game.enemies.keys()) target.destroy()
  for (const bullet of game.bullets.keys()) bullet.destroy()
  noa.emit('tick', 3900)
  assert.equal(game.wave, 1, 'intermission should last four seconds')
  noa.emit('tick', 100)
  assert.equal(game.wave, 2)
  assert.equal(game.enemies.size + game.pendingEnemies, 5)
})

test('arena enemies choose chase/roam targets, move, and aim bullets at the player', t => {
  let random = 0.25
  const { noa, game, tick } = arena(t, () => random)
  tick(91)
  const [target, ai] = game.enemies.entries().next().value
  assert.equal(ai.chasePlayer, true)
  assert.equal(target.movement.running, true)
  const initial = target.position
  tick(30)
  assert.ok(target.distanceTo(initial) > 0.1)
  random = 0.9
  ai.decisionIn = 0
  ai.shootIn = 0
  noa.emit('tick', 16)
  assert.equal(ai.chasePlayer, false)
  const bullet = [...game.bullets.keys()].find(bullet => bullet.entityName === 'enemy-bullet')
  assert.ok(bullet)
  const direction = noa.camera.getTargetPosition().map((value, axis) => value - target.position[axis] - (axis === 1 ? 1.1 : 0))
  const length = Math.hypot(...direction)
  direction.forEach((value, axis) => assert.ok(Math.abs(bullet.body.velocity[axis] - value / length * 12) < 0.001))
  assert.equal(target.health, 100, 'enemy shots should not damage their shooter')
})

test('arena hits consume bullets once, reduce health, and kill enemies at zero', t => {
  const { game, spawnBullet, tick } = arena(t)
  tick(91)
  const target = game.enemies.keys().next().value
  target.health = 10
  const bullet = spawnBullet(target.position, [0, 1, 0], 0, 'player-bullet')
  tick()
  assert.equal(target.health, 0)
  assert.equal(target.destroyed, true)
  assert.equal(bullet.destroyed, true)
  assert.equal(game.playerHealth, 100)
})

test('restored right-click bullet filter ignores the player and other player bullets', t => {
  const { noa, game, spawnBullet, events } = arena(t)
  events.get('mousedown')({ button: 2, preventDefault() {} })
  const bullet = [...game.bullets.keys()].find(shot => shot.entityName === 'player-bullet')
  const friendly = spawnBullet(bullet.position, [1, 0, 0], 0, 'player-bullet')
  noa.entities.tick(0)
  assert.equal(bullet.destroyed, false)
  assert.equal(friendly.destroyed, false)
  assert.equal(game.playerHealth, 100)
  const raw = noa.entities.add(bullet.position, 1, 1)
  noa.entities.addComponent(raw, noa.entities.names.collideEntities)
  noa.entities.tick(0)
  assert.equal(bullet.destroyed, true, 'other entities consume the player shot')
  noa.entities.deleteEntity(raw)
})

test('restored enemy and player bullet callbacks deal damage once in either creation order', t => {
  for (const bulletFirst of [true, false]) {
    const { noa, game, events, tick } = arena(t)
    const fire = () => {
      events.get('mousedown')({ button: 2, preventDefault() {} })
      const bullet = [...game.bullets.keys()].find(shot => shot.entityName === 'player-bullet')
      bullet.setPosition([50, 10, 50]).setVelocity([0, 0, 0])
      return bullet
    }
    let bullet = bulletFirst ? fire() : null
    tick(91)
    if (!bulletFirst) bullet = fire()
    const target = game.enemies.keys().next().value
    bullet.setPosition(target.position)
    noa.entities.tick(0)
    assert.equal(target.health, 90)
    assert.equal(bullet.destroyed, true)
    noa.entities.tick(0)
    assert.equal(target.health, 90, 'overlapping callbacks must not double-count a hit')
    // The backup's look-at controller is attached to the actual wave enemy.
    noa.emit('tick', 16)
    const [px, , pz] = noa.entities.getPosition(noa.playerEntity)
    const [x, , z] = target.position
    assert.equal(target.mesh.rotation.y, Math.atan2(px - x, pz - z))
  }
})

test('arena repeatedly recovers falling enemies while their ground chunk is unloaded', t => {
  const { noa, game, tick } = arena(t)
  tick(91)
  const [target, ai] = game.enemies.entries().next().value
  ai.shootIn = Infinity
  target.health = 70
  noa.getBlock = () => 0 // Simulate unloaded terrain for the real physics engine.
  target.setPosition([25, -12, 25]).setVelocity([2, -20, 3])
  noa.emit('tick', 16)
  assert.equal(target.position[0], 25)
  assert.equal(target.position[2], 25)
  assert.ok(Math.abs(target.position[1] - 1.01) < 1e-6)
  assert.deepEqual(Array.from(target.body.velocity), [2, 0, 3])
  let recoveries = 0
  for (let frame = 0; frame < 180; frame++) {
    tick()
    assert.ok(target.position[1] >= 0, 'enemy should never remain below the reset height')
    if (Math.abs(target.position[1] - 1.01) < 1e-6) recoveries++
  }
  assert.ok(recoveries > 1, 'recovery must repeat until terrain is loaded again')
  assert.equal(target.health, 70)
  assert.equal(target.destroyed, false)
})

test('enemy bullets damage the player and stop combat at game over', t => {
  const { noa, game, spawnBullet, tick, events } = arena(t)
  tick(91)
  for (let hit = 0; hit < 10; hit++) {
    const bullet = spawnBullet(noa.entities.getPosition(noa.playerEntity), [1, 0, 0], 0, 'enemy-bullet')
    tick()
    assert.equal(bullet.destroyed, true)
    assert.equal(game.playerHealth, 100 - (hit + 1) * 10)
  }
  assert.equal(game.gameOver, true)
  assert.equal(game.bullets.size, 0)
  assert.match(game.arenaHud.textContent, /Game over/)
  assert.ok([...game.enemies.keys()].every(target => !target.movement.running))
  const previousWave = game.wave
  events.get('mousedown')({ button: 2, preventDefault() {} })
  noa.emit('tick', 10000)
  assert.equal(game.bullets.size, 0)
  assert.equal(game.wave, previousWave)
})

test('player and enemy projectiles expire after three seconds without collisions or game ticks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { spawnBullet, game } = arena(t)
  const shots = ['player-bullet', 'enemy-bullet'].map(name =>
    spawnBullet([0, 50, 0], [0, 1, 0], 10, name))
  t.mock.timers.tick(2999)
  assert.ok(shots.every(bullet => !bullet.destroyed))
  t.mock.timers.tick(1)
  for (const bullet of shots) {
    assert.equal(bullet.destroyed, true)
    assert.equal(bullet.mesh.isDisposed(), true)
    assert.equal(game.bullets.has(bullet), false)
  }
})

test('arena bullets normalize 3D direction and maintain speed without gravity or drag', t => {
  const { noa, spawnBullet, tick } = arena(t)
  const position = [0, 10, 0]
  const direction = [3, 4, 0]
  const bullet = spawnBullet(position, direction, 10, 'player-bullet')
  assert.deepEqual(bullet.position, position)
  assert.equal(bullet.entityName, 'player-bullet')
  assert.equal(noa.rendering.getScene().getMeshByName('player-bullet'), bullet.mesh)
  tick(60)
  assert.ok(Math.abs(bullet.position[0] - 6) < 0.01)
  assert.ok(Math.abs(bullet.position[1] - 18) < 0.01)
  assert.deepEqual(Array.from(bullet.body.velocity), [6, 8, 0])
  assert.deepEqual(position, [0, 10, 0])
  assert.deepEqual(direction, [3, 4, 0])
  const vectorBullet = spawnBullet([0, 5, 0], { asArray: () => [0, 0, -2] }, 5)
  assert.deepEqual(Array.from(vectorBullet.body.velocity), [0, 0, -5])
})

test('arena bullets clean up on terrain impact and reject invalid trajectories', t => {
  const { noa, spawnBullet, tick } = arena(t)
  const bullet = spawnBullet([0, 2, 0], [0, -1, 0], 10, 'downward-bullet')
  tick(30)
  assert.equal(bullet.destroyed, true)
  assert.equal(Entity.fromId(noa, bullet.id), undefined)
  assert.ok(bullet.mesh.isDisposed())
  assert.throws(() => spawnBullet([0, 2, 0], [0, 0, 0], 10), /nonzero length/)
  assert.throws(() => spawnBullet([0, 2, 0], [NaN, 1, 0], 10), /three finite/)
  assert.throws(() => spawnBullet([0, 2, 0], [1, 0, 0], -1), /nonnegative/)
  assert.throws(() => spawnBullet([0, 2, 0], [1, 0, 0], Infinity), /nonnegative/)
})

test('movement follows targets and stops without cancelling vertical velocity', t => {
  const { spawn, tick } = world(t)
  const entity = spawn({ position: [0, 0.001, 0], movement: { maxSpeed: 3 } })
  tick(30)
  entity.move(1, 0)
  tick(90)
  assert.ok(entity.position[0] > 2, 'noa movement should advance along +X')
  assert.ok(Math.abs(entity.position[2]) < 0.01)
  entity.setVelocity([3, -2, 4]).stop()
  assert.deepEqual(Array.from(entity.body.velocity), [0, -2, 0])
  const target = spawn({ position: [8, 0, 0], physics: false })
  entity.moveToward(target, 1)
  assert.equal(entity.movement.running, true)
  entity.setPosition([8, 0, 0]).moveToward(target.id, 1)
  assert.equal(entity.movement.running, false)
  assert.equal(entity.distanceTo([8, 3, 4]), 5)
  entity.lookAt([9, 0, 0])
  assert.equal(entity.mesh.rotation.y, Math.PI / 2)
})

test('physics lands on terrain, reports impacts, jumps, and wakes after teleport', t => {
  const { spawn, tick } = world(t)
  const entity = spawn({ position: [0, 3, 0] })
  let impacts = 0
  const unsubscribe = entity.onTerrainCollision((impulse, self) => {
    assert.equal(self, entity)
    assert.equal(impulse.length, 3)
    impacts++
  })
  assert.equal(entity.jump(), false)
  tick(120)
  assert.ok(entity.grounded)
  assert.ok(impacts > 0)
  assert.ok(Math.abs(entity.position[1]) < 0.01)
  assert.equal(entity.jump(6), true)
  tick(5)
  assert.ok(entity.position[1] > 0.1)
  assert.equal(entity.jump(), false)
  unsubscribe()
  tick(180)
  const count = impacts
  entity.setPosition([0, 4, 0])
  tick(30)
  assert.ok(entity.position[1] < 4)
  tick(120)
  assert.equal(impacts, count)
})

test('collisions include raw noa entities; masks filter notifications', t => {
  const { noa, spawn, tick } = world(t)
  const entity = spawn({ physics: false, collideBits: 1, collideMask: 2 })
  const other = spawn({ physics: false, collideBits: 2, collideMask: 0 })
  const raw = noa.entities.add([0, 2, 0], 1, 1)
  assert.ok(entity.collidesWith(other))
  assert.ok(entity.collidesWith(raw))
  assert.equal(entity.collidesWith(entity), false)
  assert.ok(entity.getCollisions().includes(raw))
  const hits = []
  const unsubscribe = entity.onCollision(id => hits.push(id))
  tick()
  assert.deepEqual(hits, [other.id])
  unsubscribe()
  tick()
  assert.equal(hits.length, 1)
  other.setPosition([10, 2, 0])
  assert.equal(entity.collidesWith(other), false)
  noa.entities.deleteEntity(raw)
})

test('terrain checks handle face contact, negative coordinates, and global origins', t => {
  const { noa, spawn } = world(t, [1000, 0, -1000])
  const entity = spawn({ position: [1000, 0, -1000], physics: false })
  assert.deepEqual(entity.mesh.position.asArray(), [0, 0.5, 0])
  assert.equal(entity.collidesWithTerrain(), false)
  assert.equal(entity.collidesWithTerrain([1000, -0.1, -1000]), true)
  const other = spawn({ position: [1000, 0, -1000], physics: false })
  assert.ok(entity.collidesWith(other))
  entity.setPosition([1002, 1, -1000])
  assert.deepEqual(entity.position, [1002, 1, -1000])
  assert.equal(entity.collidesWith(other), false)
  assert.ok(noa.entities.hasPosition(entity.id))
})

test('controllers share a listener and clean up on replacement, detach, and destroy', t => {
  const { noa, spawn } = world(t)
  const entities = Array.from({ length: 20 }, () => spawn())
  let calls = 0
  entities.forEach(entity => entity.rigMovement((self, dt) => {
    assert.ok(self instanceof Entity)
    assert.equal(dt, 0.02)
    calls++
  }))
  assert.equal(noa.listenerCount('tick'), 1)
  noa.emit('tick', 20)
  assert.equal(calls, 20)
  entities[0].rigMovement(() => { calls += 100 })
  noa.emit('tick', 20)
  assert.equal(calls, 139)
  entities[0].unrigMovement()
  noa.emit('tick', 20)
  assert.equal(calls, 158)
  const model = entities[0].mesh
  const material = model.material
  entities.forEach(entity => entity.destroy())
  assert.equal(noa.listenerCount('tick'), 0)
  assert.ok(model.isDisposed())
  assert.equal(noa.entities.hasPosition(entities[0].id), false)
  assert.equal(noa.entities.hasPhysics(entities[0].id), false)
  assert.ok(!noa.rendering.getScene().materials.includes(material))
  assert.throws(() => entities[0].setPosition([0, 0, 0]), /destroyed/)
})

test('invalid coordinates and cross-engine targets fail clearly', t => {
  const { noa, spawn } = world(t)
  const otherWorld = world(t)
  const entity = spawn()
  const foreign = otherWorld.spawn()
  assert.throws(() => new Entity(noa, { width: 0 }), /greater than zero/)
  assert.throws(() => new Entity(noa, { position: [NaN, 0, 0] }), /three finite/)
  assert.throws(() => entity.setVelocity([Infinity, 0, 0]), /three finite/)
  assert.throws(() => entity.moveToward(foreign), /different noa engine/)
  assert.equal(entity.collidesWith(foreign), false)
})
