const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('../frontend/node_modules/esbuild')

// Bundle the real ESM dependencies as Vite does, then exercise noa's actual
// components/physics with Babylon's headless engine rather than mock entities.
const bundle = buildSync({
  stdin: {
    contents: `
      export { Entity } from './game/entity.js'
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
const { Entity, Entities, Physics, NullEngine, Scene, StandardMaterial, CreateBox } = runtime.exports

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
  const spawn = options => {
    const entity = new Entity(noa, options)
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
