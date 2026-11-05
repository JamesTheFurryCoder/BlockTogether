const fs = require('node:fs')
const path = require('node:path')

// Vite runs this file in Node, so this API can read and write a local save file.
// GET loads the world; POST updates one chunk in that world.
const savePath = path.join(__dirname, 'playerSaveData', 'world.json')
const blocksPerChunk = 24 ** 3
const maxRequestLength = 1024 * 1024
fs.mkdirSync(path.dirname(savePath), { recursive: true })

function sendJson(res, status, data) {
  res.statusCode = status
  res.end(JSON.stringify(data))
}

function readWorld() {
  if (!fs.existsSync(savePath)) fs.writeFileSync(savePath, '{}\n')
  return JSON.parse(fs.readFileSync(savePath, 'utf8'))
}

function isValidChunk(edit) {
  const { indexes, blocks } = edit ?? {}

  // Each chunk has three integer coordinates and a full array of block IDs (0–3).
  const validIndexes = Array.isArray(indexes)
    && indexes.length === 3
    && indexes.every(Number.isSafeInteger)
  const validBlocks = Array.isArray(blocks)
    && blocks.length === blocksPerChunk
    && blocks.every(value => Number.isInteger(value) && value >= 0 && value <= 3)

  return validIndexes && validBlocks
}

function saveChunk({ indexes, blocks }) {
  const chunks = readWorld()
  const [i, j, k] = indexes

  // The save file groups chunks by coordinate: chunks[i][j][k].
  chunks[i] ??= {}
  chunks[i][j] ??= {}
  chunks[i][j][k] = blocks

  // Finish writing a temporary file before replacing the previous save.
  fs.writeFileSync(`${savePath}.tmp`, JSON.stringify(chunks, null, 2) + '\n')
  fs.renameSync(`${savePath}.tmp`, savePath)
}

function playerSaveMiddleware(req, res, next) {
  // Let Vite handle every other URL. Ignore query parameters when matching.
  if (req.url?.split('?')[0] !== '/api/player-save') return next()

  res.setHeader('Content-Type', 'application/json')
  // Always load the latest save instead of a cached response.
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    try {
      sendJson(res, 200, readWorld())
    } catch (error) {
      console.error('Could not read playerSaveData/world.json:', error)
      sendJson(res, 500, { error: 'Could not read save file' })
    }
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return sendJson(res, 405, { error: 'Method not allowed' })
  }

  // Node receives the POST body in pieces. Parse it once all pieces arrive.
  let body = ''
  req.on('data', chunk => {
    body += chunk
    if (body.length > maxRequestLength) req.destroy()
  })
  req.on('end', () => {
    let edit
    try {
      edit = JSON.parse(body)
      if (!isValidChunk(edit)) throw new Error('Invalid chunk data')
    } catch {
      return sendJson(res, 400, { error: 'Invalid block edit' })
    }

    try {
      saveChunk(edit)
      sendJson(res, 200, { saved: true })
    } catch (error) {
      console.error('Could not write playerSaveData/world.json:', error)
      sendJson(res, 500, { error: 'Could not write save file' })
    }
  })
}

module.exports = {
  server: {
    // Saving must not trigger a page refresh.
    watch: { ignored: ['**/playerSaveData/**'] },
  },
  plugins: [{
    name: 'player-save',
    // Register the API for both the development server and local build preview.
    configureServer(server) { server.middlewares.use(playerSaveMiddleware) },
    configurePreviewServer(server) { server.middlewares.use(playerSaveMiddleware) },
  }],
}
