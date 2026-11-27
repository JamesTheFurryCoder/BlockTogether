const path = require('node:path')
const sharedConfig = require('../vite.config.js')

// Share the world-save API while building the frontend pages.
module.exports = {
  ...sharedConfig,
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        playerhome: path.resolve(__dirname, 'game/player-home/playerhome.html'),
        mazegame: path.resolve(__dirname, 'game/mazegame.html'),
        arenashooter: path.resolve(__dirname, 'game/arenashooter.html'),
        platformrunner: path.resolve(__dirname, 'game/platformrunner.html'),
      },
    },
  },
}
