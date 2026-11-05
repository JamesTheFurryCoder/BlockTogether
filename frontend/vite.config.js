const path = require('node:path')
const sharedConfig = require('../vite.config.js')

// Share the world-save API while building both frontend pages.
module.exports = {
  ...sharedConfig,
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        playerhome: path.resolve(__dirname, 'playerhome.html'),
      },
    },
  },
}
