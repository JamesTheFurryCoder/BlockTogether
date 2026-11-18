import { Engine } from 'noa-engine'

// Cells are addressed as maze[row][column]: 0 = path, 1 = wall,
// 2 = start, and 3 = end. Odd dimensions leave a solid outer wall.
export function generateMaze(rows = 21, columns = 21) {
  if (!Number.isInteger(rows) || !Number.isInteger(columns)
      || rows < 5 || columns < 5 || rows % 2 === 0 || columns % 2 === 0) {
    throw new RangeError('Maze dimensions must be odd integers of at least 5.')
  }

  const maze = Array.from({ length: rows }, () => Array(columns).fill(1))
  const stack = [[1, 1]]
  const directions = [[-2, 0], [2, 0], [0, -2], [0, 2]]
  maze[1][1] = 0

  // Iterative depth-first search carves a connected maze without recursion.
  while (stack.length > 0) {
    const [row, column] = stack[stack.length - 1]
    const neighbors = directions
      .map(([dr, dc]) => [row + dr, column + dc])
      .filter(([nextRow, nextColumn]) =>
        nextRow > 0 && nextRow < rows - 1
        && nextColumn > 0 && nextColumn < columns - 1
        && maze[nextRow][nextColumn] === 1)

    if (neighbors.length === 0) {
      stack.pop()
      continue
    }

    const [nextRow, nextColumn] = neighbors[Math.floor(Math.random() * neighbors.length)]
    maze[(row + nextRow) / 2][(column + nextColumn) / 2] = 0
    maze[nextRow][nextColumn] = 0
    stack.push([nextRow, nextColumn])
  }

  maze[1][1] = 2
  maze[rows - 2][columns - 2] = 3
  return maze
}

export const maze = generateMaze(55, 55)

const CELL_SIZE = 3
const FLOOR_Y = 0
const WALL_HEIGHT = 8
const BLOCKS = { wall: 1, start: 2, end: 3, floor: 4 }

const startRow = maze.findIndex(row => row.includes(2))
const startColumn = maze[startRow].indexOf(2)

const noa = new Engine({
  debug: false,
  // noa positions are measured at the bottom center of the player.
  playerStart: [
    (startColumn + 0.5) * CELL_SIZE,
    FLOOR_Y + 1.01,
    (startRow + 0.5) * CELL_SIZE,
  ],
  chunkAddDistance: [2, 1],
  chunkRemoveDistance: [3, 2],
})

const move = noa.entities.getMovement(noa.playerEntity)

// Adjust the jump strength (default is typically around 10)
move.jumpImpulse = 5

for (const [name, color] of Object.entries({
  wall: [0.35, 0.4, 0.45],
  start: [0.2, 0.8, 0.3],
  end: [0.9, 0.2, 0.2],
  floor: [0.75, 0.7, 0.6],
})) {
  const material = `maze-${name}`
  noa.registry.registerMaterial(material, { color })
  noa.registry.registerBlock(BLOCKS[name], { material, solid: true, opaque: true })
}

noa.world.on('worldDataNeeded', (requestID, data, chunkX, chunkY, chunkZ) => {
  const [sizeX, sizeY, sizeZ] = data.shape

  for (let x = 0; x < sizeX; x++) {
    const column = Math.floor((chunkX + x) / CELL_SIZE)
    for (let z = 0; z < sizeZ; z++) {
      const row = Math.floor((chunkZ + z) / CELL_SIZE)
      const cell = maze[row]?.[column]

      for (let y = 0; y < sizeY; y++) {
        const worldY = chunkY + y
        let block = 0 // Air above paths and outside the maze.

        if (cell !== undefined) {
          if (worldY === FLOOR_Y) {
            block = cell === 2 ? BLOCKS.start : cell === 3 ? BLOCKS.end : BLOCKS.floor
          } else if (cell === 1 && worldY > FLOOR_Y && worldY <= FLOOR_Y + WALL_HEIGHT) {
            block = BLOCKS.wall
          }
        }

        data.set(x, y, z, block)
      }
    }
  }

  noa.world.setChunkData(requestID, data)
})

const guide = document.createElement('div')
guide.textContent = 'Look for the red floor tile to win the game!\nClick the world to play. WASD: move · Mouse: look · Space: jump\nPress Esc to release the mouse and use Exit to Home.'
Object.assign(guide.style, {
  position: 'fixed',
  top: '16px',
  left: '16px',
  right: '16px',
  width: 'fit-content',
  zIndex: '1000',
  padding: '10px 14px',
  background: 'rgb(23 37 28 / 85%)',
  color: 'white',
  border: '1px solid rgb(255 255 255 / 20%)',
  borderRadius: '8px',
  font: '14px/1.5 "Segoe UI", sans-serif',
  whiteSpace: 'pre-line',
  pointerEvents: 'none',
})
document.body.appendChild(guide)

let triggered = false;
const winState = document.createElement("div");
winState.setAttribute('role', 'status');
winState.textContent = 'Congratulations, you won the game!';
Object.assign(winState.style, {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: '1001',
  boxSizing: 'border-box',
  width: 'min(400px, calc(100% - 32px))',
  padding: '24px',
  background: '#17251c',
  color: 'white',
  border: '1px solid white',
  borderRadius: '12px',
  boxShadow: '0 8px 32px rgb(0 0 0 / 50%)',
  font: '20px/1.5 "Segoe UI", sans-serif',
  textAlign: 'center',
});

const restartButton = document.createElement('button');
restartButton.type = 'button';
restartButton.textContent = 'Play again';
Object.assign(restartButton.style, {
  display: 'block',
  margin: '16px auto 0',
  padding: '10px 20px',
  background: '#284c32',
  color: 'white',
  border: '1px solid white',
  borderRadius: '8px',
  cursor: 'pointer',
  font: 'inherit',
});
restartButton.addEventListener('click', event => {
  event.stopPropagation();
  window.location.reload();
});
winState.appendChild(restartButton);
winState.addEventListener('mousedown', event => event.stopPropagation());

noa.on('tick', () => {
    if (triggered) return;

    const playerPosition = noa.entities.getPosition(noa.playerEntity);
    const column = Math.floor(playerPosition[0] / CELL_SIZE);
    const row = Math.floor(playerPosition[2] / CELL_SIZE);
    const mazePositionId = maze[row]?.[column];
    if (mazePositionId === 3) {
      triggered = true;
      document.body.appendChild(winState);
      if (document.pointerLockElement) document.exitPointerLock();
      restartButton.focus();
      console.log("you won");
    }
});

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
