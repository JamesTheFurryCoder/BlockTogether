const fs = require('node:fs')
const path = require('node:path')

const savePath = path.join(__dirname, 'playerSaveData.json')

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
      console.error('Could not read playerSaveData.json:', error)
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
    if (body.length > 4096) req.destroy()
  })
  req.on('end', () => {
    let edit
    try {
      edit = JSON.parse(body)
      const { chunkKey, localKey, blockID } = edit
      const coordinates = /^-?\d+,-?\d+,-?\d+$/
      if (typeof chunkKey !== 'string' || !coordinates.test(chunkKey)
        || !chunkKey.split(',').every(value => Number.isSafeInteger(+value) && +value % 24 === 0)
        || typeof localKey !== 'string' || !coordinates.test(localKey)
        || !localKey.split(',').every(value => +value >= 0 && +value < 24)
        || !Number.isInteger(blockID) || blockID < 0 || blockID > 3) {
        throw new Error('Invalid block edit')
      }
    } catch {
      res.statusCode = 400
      return res.end(JSON.stringify({ error: 'Invalid block edit' }))
    }

    try {
      const chunks = fs.existsSync(savePath)
        ? JSON.parse(fs.readFileSync(savePath, 'utf8'))
        : {}
      chunks[edit.chunkKey] ??= {}
      chunks[edit.chunkKey][edit.localKey] = edit.blockID
      // Replace the file only after the complete save has been written.
      fs.writeFileSync(`${savePath}.tmp`, JSON.stringify(chunks, null, 2) + '\n')
      fs.renameSync(`${savePath}.tmp`, savePath)
      res.end(JSON.stringify({ saved: true }))
    } catch (error) {
      console.error('Could not write playerSaveData.json:', error)
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'Could not write save file' }))
    }
  })
}

module.exports = {
  server: {
    // Saving must not trigger a page refresh.
    watch: { ignored: ['**/playerSaveData.json', '**/playerSaveData.json.tmp'] },
  },
  plugins: [{
    name: 'player-save',
    configureServer(server) { server.middlewares.use(playerSaveMiddleware) },
    configurePreviewServer(server) { server.middlewares.use(playerSaveMiddleware) },
  }],
}
