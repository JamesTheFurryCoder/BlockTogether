const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { buildSync } = require('../frontend/node_modules/esbuild')

// Use the real noa entity systems, voxel collision solver and Babylon meshes.
// Only the browser/window and chunk transport are replaced for headless tests.
const bundle = buildSync({
  stdin: {
    contents: `
      export { Entity } from './game/entity.js'
      export { Entities } from 'noa-engine/src/lib/entities.js'
      export { Physics } from 'voxel-physics-engine'
      export { NullEngine } from '@babylonjs/core/Engines/nullEngine'
      export { Scene } from '@babylonjs/core/scene'
      export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
    `,
    resolveDir: path.join(__dirname, '../frontend'),
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
})
const runtime = new Module(__filename + '.runtime', module)
runtime._compile(bundle.outputFiles[0].text, __filename + '.runtime')
const { Entity, Entities, Physics, NullEngine, Scene, StandardMaterial } = runtime.exports

function assertPosition(actual, expected, message) {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 0.001, message))
}

const source = fs.readFileSync(path.join(__dirname, '../frontend/game/platformrunner.js'), 'utf8')
  .replace("import { Engine } from 'noa-engine'", '')
  .replace("import { Entity } from './entity.js'", '')
  .replaceAll('export function ', 'function ')
  .replace('export const chaser', 'const chaser')
  .replace('export default noa', 'globalThis.game = { noa, getPlatform, getPlatforms, getPlatformIndex, getNextPlatforms, chaser }')

function startGame(t) {
  const handlers = new Map()
  const documentHandlers = new Map()
  const windowHandlers = new Map()
  const blocks = new Map()
  const materials = new Map()
  const deliveries = new Map()
  const elements = []
  let context
  const renderEngine = new NullEngine()
  const scene = new Scene(renderEngine)
  class Engine extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.worldOriginOffset = [0, 0, 0]
      this.globalToLocal = (position, unused, result) => {
        for (let axis = 0; axis < 3; axis++) result[axis] = position[axis]
        return result
      }
      this.camera = { heading: 0, pitch: 0, currentZoom: 0, _localGetPosition: () => [0, 0, 0] }
      this.inputs = { state: {} }
      this.container = { hasPointerLock: true, isFocused: true }
      this.rendering = {
        getScene: () => scene,
        makeStandardMaterial: name => new StandardMaterial(name, scene),
        addMeshToScene() {},
        setMeshVisibility: (mesh, visible) => mesh.setEnabled(visible),
      }
      this.getBlock = (x, y, z) => {
        if (y <= 0) return 3
        const pads = context.game?.getPlatforms(context.game.getPlatformIndex(z)) ?? []
        const pad = pads.find(pad => x >= pad.x && x < pad.x + pad.width
          && z >= pad.z && z < pad.z + pad.length && y === pad.y)
        return pad?.block ?? 0
      }
      this.physics = new Physics({}, (x, y, z) => this.getBlock(x, y, z) !== 0, () => false)
      this.entities = this.ents = new Entities(this, {})
      this.playerEntity = this.entities.add([...options.playerStart], 0.6, 1.8, null, null, true, false)
      for (const name of ['movement', 'receivesInputs', 'collideEntities']) {
        this.entities.addComponent(this.playerEntity, this.entities.names[name])
      }
      this.registry = {
        registerMaterial: (name, options) => materials.set(name, options),
        registerBlock: (id, options) => {
          assert.ok(materials.has(options.material))
          blocks.set(id, options)
        },
      }
      this.world = {
        on: (event, listener) => {
          assert.equal(blocks.size, 6, 'blocks must be registered before generation')
          handlers.set(event, listener)
        },
        setChunkData: (id, data) => deliveries.set(id, data),
      }
    }
  }
  context = vm.createContext({
    Engine, Entity,
    document: {
      addEventListener: (event, listener) => documentHandlers.set(event, listener),
      createElement: () => ({ style: {} }),
      body: { appendChild: element => elements.push(element) },
    },
    window: { addEventListener: (event, listener) => windowHandlers.set(event, listener) },
  })
  vm.runInContext(source, context)
  const { noa, chaser } = context.game
  t.after(() => {
    chaser.destroy()
    scene.dispose()
    renderEngine.dispose()
  })

  function chunk(origin, shape = [24, 24, 24]) {
    const values = new Uint16Array(shape[0] * shape[1] * shape[2]).fill(99)
    const index = (x, y, z) => (x * shape[1] + y) * shape[2] + z
    const data = {
      shape,
      set: (x, y, z, block) => { values[index(x, y, z)] = block },
      get: (x, y, z) => values[index(x, y, z)],
      values,
    }
    const id = origin.join(',')
    handlers.get('worldDataNeeded')(id, data, ...origin)
    assert.equal(deliveries.get(id), data)
    return data
  }
  return {
    ...context.game, chunk,
    body: noa.entities.getPhysicsBody(noa.playerEntity),
    tick: (count = 1, dt = 1000 / 30) => {
      for (let frame = 0; frame < count; frame++) {
        noa.physics.tick(dt)
        noa.entities.tick(dt)
        noa.emit('tick', dt)
      }
    },
    key: (type, code) => documentHandlers.get(type)({ type, code }),
    blur: () => windowHandlers.get('blur')(),
    unlock: () => documentHandlers.get('pointerlockchange')(),
    hud: () => elements[0].textContent,
  }
}

function jumpBetween(game, pad, target, { sprint = pad.gap >= 4, fromRest = false } = {}) {
  const { noa, body, tick, key } = game
  noa.container.hasPointerLock = false
  noa.inputs.state.forward = false
  noa.inputs.state.jump = false
  const x = Math.max(pad.x + 0.7, Math.min(pad.x + pad.width - 0.7, target.x + target.width / 2))
  noa.entities.setPosition(1, [x, pad.y + 1.01, pad.z + pad.length - 0.35])
  body.velocity.fill(0)
  tick(4)
  const targetX = Math.max(target.x + 0.7, Math.min(target.x + target.width - 0.7, x))
  const heading = Math.atan2(targetX - x, target.z + 0.8 - noa.entities.getPosition(1)[2])
  noa.camera.heading = heading
  key(sprint ? 'keydown' : 'keyup', 'ShiftLeft')
  if (!fromRest) {
    body.velocity[0] = Math.sin(heading) * (sprint ? 11 : 7)
    body.velocity[2] = Math.cos(heading) * (sprint ? 11 : 7)
  }
  noa.inputs.state.forward = true
  noa.inputs.state.jump = true
  for (let frame = 0; frame < 40; frame++) {
    tick()
    noa.inputs.state.jump = false
    const position = noa.entities.getPosition(1)
    if (body.atRestY() < 0 && position[2] >= target.z
        && position[2] < target.z + target.length
        && position[0] >= target.x && position[0] < target.x + target.width
        && Math.abs(position[1] - target.y - 1) < 0.1) return true
    if (position[1] < 7) return false
    // Steer into the landing, then straighten instead of drifting past its side.
    noa.camera.heading = Math.atan2(targetX - position[0], Math.max(1, target.z + 0.8 - position[2]))
  }
  return false
}

test('spawn is above the registered start platform with air for the player', t => {
  const { noa, chunk } = startGame(t)
  const [x, y, z] = noa.options.playerStart.map(Math.floor)
  const data = chunk([-12, 0, 0])
  assert.equal(data.get(x + 12, y - 1, z), 1)
  assert.equal(data.get(x + 12, y, z), 0)
  assert.equal(data.get(x + 12, y + 1, z), 0)
})

test('routes fork into separate journeys with short hops and sprint gaps, without merging', t => {
  const { getPlatform, getPlatforms, getPlatformIndex, getNextPlatforms } = startGame(t)
  const gaps = new Set()
  const widths = new Set()
  const lengths = new Set()
  for (const start of [0, 1000000]) {
    for (let index = start; index < start + 100; index++) {
      const current = getPlatform(index)
      const next = getPlatform(index + 1)
      widths.add(current.width)
      lengths.add(current.length)
      assert.equal(getPlatformIndex(current.z), index)
      assert.equal(getPlatformIndex(next.z - 0.01), index)
      for (const pad of getPlatforms(index)) {
        gaps.add(pad.gap)
        assert.ok(pad.gap >= 1 && pad.gap <= 6)
        assert.ok(pad.length >= 8)
        const targets = getNextPlatforms(pad)
        assert.ok(targets.length === 1 || targets.length === 2)
        for (const target of targets) {
          assert.ok(Math.abs(target.y - pad.y) <= 1)
          assert.equal(target.z - pad.z - pad.length, pad.gap)
          const parents = getPlatforms(index).filter(parent => getNextPlatforms(parent)
            .some(child => child.routeId === target.routeId))
          assert.equal(parents.length, 1, 'a fork must never merge different journeys')
        }
      }
    }
  }
  assert.deepEqual([...gaps].sort(), [1, 2, 3, 4, 5, 6])
  assert.ok(widths.size >= 3)
  assert.ok(lengths.size >= 5)
  assert.equal(getPlatforms(0).length, 1)
  assert.equal(getPlatforms(1).length, 2)
  const journeys = getPlatforms(200)
  assert.equal(journeys.length, 8)
  for (let path = 1; path < journeys.length; path++) {
    assert.ok(journeys[path].x - journeys[path - 1].x - journeys[path - 1].width > 60,
      'distant journeys should be outside one another\'s nearby chunks')
  }
  assert.equal(getPlatform(-1), null)
  assert.equal(getPlatformIndex(-0.01), -1)
})

test('chunk seams, reloads and request order preserve platforms and lava', t => {
  const { chunk, getPlatforms, noa } = startGame(t)
  const origin = [-12, -4, 14]
  const whole = chunk(origin, [24, 20, 28])
  // Request the second half first, including platforms crossing chunk edges.
  const second = chunk([-12, -4, 28], [24, 20, 14])
  const first = chunk(origin, [24, 20, 14])
  for (let x = 0; x < 24; x++) {
    for (let y = 0; y < 20; y++) {
      for (let z = 0; z < 28; z++) {
        assert.equal(whole.get(x, y, z), z < 14 ? first.get(x, y, z) : second.get(x, y, z - 14))
        if (y <= 4) assert.equal(whole.get(x, y, z), 3)
        else assert.ok([0, 2, 4, 5, 6].includes(whole.get(x, y, z)))
      }
    }
  }
  assert.ok(whole.values.some(block => block > 0 && block !== 3))
  assert.equal(getPlatforms(1).length, 2)
  assert.ok(getPlatforms(1).every(pad => pad.length >= 7))
  assert.deepEqual(chunk(origin, [24, 20, 28]).values, whole.values)
  assert.ok(chunk([0, 24, 0]).values.every(block => block === 0))
  assert.ok(chunk([0, -24, -24]).values.every(block => block === 3))
  assert.ok(chunk([100, 1, -24]).values.every(block => block === 0))
  // Rendered chunk voxels must match the terrain used by the jump tests,
  // including places where two fork exits overlap at different heights.
  for (const row of [1, 16, 20, 39, 44, 60]) {
    for (const pad of getPlatforms(row)) {
      const origin = [pad.x - 2, 0, pad.z]
      const data = chunk(origin, [pad.width + 4, 12, 20])
      for (let x = 0; x < data.shape[0]; x++) {
        for (let y = 0; y < data.shape[1]; y++) {
          for (let z = 0; z < data.shape[2]; z++) {
            assert.equal(data.get(x, y, z), noa.getBlock(origin[0] + x, y, origin[2] + z))
          }
        }
      }
    }
  }
})

test('lava resets velocity and returns to the beginning after progressing far away', t => {
  const { noa, getPlatform, chaser, body, tick } = startGame(t)
  const chaserStart = chaser.position
  const platform = getPlatform(1000)
  const landing = [platform.x + 2, platform.y + 1.01, platform.z + 2]
  noa.entities.setPosition(1, landing)
  tick()
  chaser.setPosition([0, 8, 9000])
  noa.entities.setPosition(1, [100, 1, 100])
  body.velocity = [4, -12, 7]
  tick()
  const respawn = Array.from(noa.entities.getPosition(1))
  assertPosition(respawn, noa.options.playerStart)
  assert.deepEqual(Array.from(body.velocity), [0, 0, 0])
  assertPosition(chaser.position, chaserStart)
})

test('ground friction stops a sprint quickly and a standing jump still clears the next gap', t => {
  const game = startGame(t)
  const { noa, body, tick, getPlatform, getNextPlatforms } = game
  noa.container.hasPointerLock = false
  tick(3)
  body.velocity[2] = 11
  const before = noa.entities.getPosition(1)[2]
  tick(6)
  assert.ok(Math.abs(body.velocity[2]) < 0.1)
  assert.ok(noa.entities.getPosition(1)[2] - before < 0.8)

  const pad = Array.from({ length: 20 }, (_, index) => getPlatform(index)).find(pad => pad.gap <= 2)
  assert.ok(jumpBetween(game, pad, getNextPlatforms(pad)[0], { fromRest: true }),
    'a short hop should be reachable from a stop')
})

test('jump buffering and coyote time forgive slightly early and late jump input', t => {
  const { noa, body, tick } = startGame(t)
  noa.container.hasPointerLock = false
  tick(3)
  noa.entities.setPosition(1, [0.5, 8.12, 4])
  body.velocity[1] = -2
  noa.inputs.state.jump = true
  tick()
  noa.inputs.state.jump = false
  tick(3)
  assert.ok(body.velocity[1] > 0, 'an early jump press should fire upon landing')

  noa.entities.setPosition(1, [0.5, 8.01, 4])
  body.velocity.fill(0)
  tick(4)
  noa.entities.setPosition(1, [0.5, 8.01, 8.35])
  noa.inputs.state.jump = true
  tick(2)
  assert.ok(body.velocity[1] > 0, 'a jump just past the edge should still work')
})

test('chaser waits for movement, honors the head start, pauses and resets the run on capture', t => {
  const { noa, chaser, tick, hud } = startGame(t)
  const chaserStart = chaser.position
  tick(120)
  assertPosition(chaser.position, chaserStart)
  noa.inputs.state.forward = true
  tick()
  noa.inputs.state.forward = false
  tick(60)
  assertPosition(chaser.position, chaserStart, 'head start must protect the player')
  noa.container.hasPointerLock = false
  tick(120)
  assertPosition(chaser.position, chaserStart, 'pursuit must pause without pointer lock')
  noa.container.hasPointerLock = true
  for (let frame = 0; frame < 300 && !hud().includes('Caught: 1'); frame++) tick()
  assert.ok(hud().includes('Caught: 1'))
  assertPosition(chaser.position, chaserStart)
  const position = noa.entities.getPosition(1)
  assertPosition(position, noa.options.playerStart)
  // Capture should not repeatedly kill the player on their new spawn.
  tick(120)
  assert.ok(hud().includes('Caught: 1'))
})

test('all fork exits and journey jumps are reachable with the actual physics solver', t => {
  const game = startGame(t)
  for (let index = 0; index < 65; index++) {
    for (const pad of game.getPlatforms(index)) {
      for (const target of game.getNextPlatforms(pad)) {
        assert.ok(jumpBetween(game, pad, target),
          `row ${index}, route ${pad.routeId} -> ${target.routeId}, gap ${pad.gap} must be reachable`)
      }
    }
  }
})

test('six-block jumps require sprinting while short hops remain walkable', t => {
  const game = startGame(t)
  const pads = Array.from({ length: 60 }, (_, index) => game.getPlatforms(index)).flat()
  const hard = pads.find(pad => pad.gap === 6)
  const target = game.getNextPlatforms(hard)[0]
  assert.equal(jumpBetween(game, hard, target, { sprint: false }), false)
  assert.equal(jumpBetween(game, hard, target, { sprint: true }), true)
  for (const pad of pads.filter(pad => pad.gap <= 2).slice(0, 20)) {
    for (const next of game.getNextPlatforms(pad)) {
      assert.ok(jumpBetween(game, pad, next, { sprint: false }))
    }
  }
})

test('a player can keep holding forward while steering through a divergent journey', t => {
  const game = startGame(t)
  const { noa, body, tick, key, getPlatforms, getPlatformIndex, getNextPlatforms } = game
  noa.container.hasPointerLock = false
  key('keydown', 'ShiftLeft')
  noa.inputs.state.forward = true
  let pad = game.getPlatform(0)
  let target = getNextPlatforms(pad)[0]
  let jumping = false
  let landingX = 0
  for (let frame = 0; frame < 4000 && pad.index < 50; frame++) {
    const position = noa.entities.getPosition(1)
    if (body.atRestY() < 0) {
      const landed = getPlatforms(getPlatformIndex(position[2])).find(candidate =>
        position[0] >= candidate.x && position[0] < candidate.x + candidate.width
        && position[2] >= candidate.z && position[2] < candidate.z + candidate.length
        && Math.abs(position[1] - candidate.y - 1) < 0.1)
      if (landed && landed.index > pad.index) {
        pad = landed
        // Turn right at the later fork to check that the initial choice is
        // not silently funneling the player back onto a central corridor.
        const choices = getNextPlatforms(pad)
        target = choices[pad.index > 10 ? choices.length - 1 : 0]
        jumping = false
      }
    }
    const takeoffX = Math.max(pad.x + 0.7, Math.min(pad.x + pad.width - 0.7, target.x + target.width / 2))
    noa.inputs.state.jump = false
    if (!jumping) {
      noa.camera.heading = Math.atan2(takeoffX - position[0], Math.max(0.8, pad.z + pad.length - 0.2 - position[2]))
      const threshold = pad.gap >= 5 ? 0.65 : 1.2
      if (body.atRestY() < 0 && pad.z + pad.length - position[2] < threshold) {
        jumping = true
        noa.inputs.state.jump = true
        landingX = Math.max(target.x + 0.7, Math.min(target.x + target.width - 0.7, takeoffX))
      }
    }
    if (jumping) {
      noa.camera.heading = Math.atan2(landingX - position[0], Math.max(1, target.z + 0.8 - position[2]))
    }
    tick()
    assert.ok(noa.entities.getPosition(1)[1] > 7,
      `fell on row ${pad.index}, route ${pad.routeId}, gap ${pad.gap}, frame ${frame}`)
  }
  assert.ok(pad.index >= 50)
  assert.ok(Math.abs(noa.entities.getPosition(1)[0]) > 100)
})

test('holding either Shift key sprints until both are released or focus is lost', t => {
  const { noa, key, blur, unlock } = startGame(t)
  const movement = noa.entities.getMovement(1)
  assert.equal(movement.maxSpeed, 7)
  key('keydown', 'ShiftLeft')
  key('keydown', 'ShiftLeft') // Key repeat must not require extra releases.
  assert.equal(movement.maxSpeed, 11)
  key('keydown', 'ShiftRight')
  key('keyup', 'ShiftLeft')
  assert.equal(movement.maxSpeed, 11)
  key('keyup', 'ShiftRight')
  assert.equal(movement.maxSpeed, 7)
  key('keydown', 'KeyW')
  assert.equal(movement.maxSpeed, 7)
  key('keydown', 'ShiftLeft')
  blur()
  assert.equal(movement.maxSpeed, 7)
  key('keydown', 'ShiftRight')
  unlock()
  assert.equal(movement.maxSpeed, 7)
})
