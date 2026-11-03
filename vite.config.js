const fs = require('node:fs')
const path = require('node:path')

const savePath = path.join(__dirname, 'playerSaveData', 'world.json')
fs.mkdirSync(path.dirname(savePath), { recursive: true })

// Runs in Node through Vite, allowing the game to save to a project file.
function playerSaveMiddleware(req, res, next) {
  if (req.url?.split('?')[0] !== '/api/player-save') return next()

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    try {
      if (!fs.existsSync(savePath)) fs.writeFileSync(savePath, '{}\n')
      const chunks = JSON.parse(fs.readFileSync(savePath, 'utf8'))
      res.end(JSON.stringify(chunks))
    } catch (error) {
      console.error('Could not read playerSaveData/world.json:', error)
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'Could not read save file' }))
    }
    return
  }

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, POST')
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }

  let body = ''
  req.on('data', chunk => {
    body += chunk
    if (body.length > 1024 * 1024) req.destroy()
  })
  req.on('end', () => {
    let edit
    try {
      edit = JSON.parse(body)
      const { indexes, blocks } = edit
      if (!Array.isArray(indexes) || indexes.length !== 3
        || !indexes.every(Number.isSafeInteger)
        || !Array.isArray(blocks) || blocks.length !== 24 ** 3
        || !blocks.every(value => Number.isInteger(value) && value >= 0 && value <= 3)) {
        throw new Error('Invalid chunk data')
      }
    } catch {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: 'Invalid block edit' }))
    }

    try {
      const chunks = fs.existsSync(savePath)
        ? JSON.parse(fs.readFileSync(savePath, 'utf8'))
        : {}
      const [i, j, k] = edit.indexes
      chunks[i] ??= {}
      chunks[i][j] ??= {}
      chunks[i][j][k] = edit.blocks
      // Replace the file only after the complete save has been written.
      fs.writeFileSync(`${savePath}.tmp`, JSON.stringify(chunks, null, 2) + '\n')
      fs.renameSync(`${savePath}.tmp`, savePath)
      res.end(JSON.stringify({ saved: true }))
    } catch (error) {
      console.error('Could not write playerSaveData/world.json:', error)
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'Could not write save file' }))
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
    configureServer(server) { server.middlewares.use(playerSaveMiddleware) },
    configurePreviewServer(server) { server.middlewares.use(playerSaveMiddleware) },
  }],
}
