const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../frontend/game/player-home/mazegame.js'), 'utf8')
  .replace("import { Engine } from 'noa-engine'", '')
  .replace('export function generateMaze', 'function generateMaze')
  .replace('export const maze', 'const maze')
  .replace('export default noa', 'globalThis.game = { noa, maze }')

function startGame() {
  const handlers = new Map()
  const deliveries = new Map()
  const blocks = new Map()
  const materials = new Map()
  class Engine {
    constructor(options) {
      this.options = options
      this.registry = {
        registerMaterial: (name, options) => materials.set(name, options),
        registerBlock: (id, options) => blocks.set(id, options),
      }
      this.world = {
        on: (event, listener) => handlers.set(event, listener),
        setChunkData: (id, data) => deliveries.set(id, data),
      }
    }
  }
  const context = vm.createContext({
    Engine,
    document: {
      createElement: () => ({ style: {}, addEventListener() {} }),
      body: { appendChild() {} },
    },
  })
  vm.runInContext(source, context)
  function chunk(origin, shape = [24, 24, 24]) {
    // Nonzero initial values also verify that empty space is cleared.
    const values = new Uint16Array(shape[0] * shape[1] * shape[2]).fill(99)
    const index = (x, y, z) => (x * shape[1] + y) * shape[2] + z
    const data = {
      shape,
      set: (x, y, z, value) => { values[index(x, y, z)] = value },
      get: (x, y, z) => values[index(x, y, z)],
      values,
    }
    const id = origin.join(',')
    handlers.get('worldDataNeeded')(id, data, ...origin)
    assert.equal(deliveries.get(id), data)
    return data
  }
  return { ...context.game, chunk, blocks, materials }
}

test('player spawns over the start floor with room for their body', () => {
  const { noa, maze, chunk } = startGame()
  const [x, y, z] = noa.options.playerStart
  assert.equal(maze[Math.floor(z / 3)][Math.floor(x / 3)], 2)
  assert.equal(x, 4.5)
  assert.equal(z, 4.5)
  assert.ok(y > 1 && y < 1.1)
  const data = chunk([0, 0, 0])
  assert.equal(data.get(4, 0, 4), 2)
  for (let height = 1; height <= 3; height++) assert.equal(data.get(4, height, 4), 0)
})

test('chunk generation follows maze cells across chunk boundaries', () => {
  const { maze, chunk, blocks, materials } = startGame()
  for (const id of [1, 2, 3, 4]) {
    assert.equal(blocks.get(id).solid, true)
    assert.ok(materials.has(blocks.get(id).material))
  }
  for (const chunkX of [0, 24, 48]) {
    for (const chunkZ of [0, 24, 48]) {
      const data = chunk([chunkX, 0, chunkZ])
      for (let x = 0; x < 24; x++) {
        for (let z = 0; z < 24; z++) {
          const cell = maze[Math.floor((chunkZ + z) / 3)]?.[Math.floor((chunkX + x) / 3)]
          const floor = cell === undefined ? 0 : cell === 2 || cell === 3 ? cell : 4
          assert.equal(data.get(x, 0, z), floor)
          for (let y = 1; y <= 4; y++) assert.equal(data.get(x, y, z), cell === 1 ? 1 : 0)
          assert.equal(data.get(x, 5, z), 0)
        }
      }
    }
  }
  // End cell is centered at world (58.5, 58.5), in chunk (48, 0, 48).
  const end = chunk([48, 0, 48])
  assert.equal(end.get(10, 0, 10), 3)
  assert.equal(end.get(10, 1, 10), 0)
})

test('chunks outside the maze or above and below it are empty', () => {
  const { chunk } = startGame()
  for (const origin of [[-24, 0, 0], [0, 0, -24], [72, 0, 0], [0, 0, 72], [0, -24, 0], [0, 24, 0]]) {
    assert.ok(chunk(origin).values.every(value => value === 0))
  }
})

test('requesting a chunk again preserves the generated maze', () => {
  const { chunk } = startGame()
  const first = chunk([24, 0, 24]).values
  assert.deepEqual(chunk([24, 0, 24]).values, first)
})
