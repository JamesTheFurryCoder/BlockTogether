# BlockTogether

BlockTogether includes a React player statistics frontend, a Vite voxel game, and an Express API.

## Run locally

In one terminal, start the API:

```sh
cd backend
npm install
npm start
```

The API runs at `http://localhost:3001`. In another terminal, start the React frontend:

```sh
cd frontend
npm install
npm start
```

Open the Vite URL shown in the terminal. The React page requests `GET http://localhost:3001/api/users/me/stats` and shows loading, error, playtime, session, world, and break-reminder states. Set `VITE_API_BASE_URL` when the backend is hosted somewhere other than `http://localhost:3001`.

The API routes and payload details are documented in [backend/README.md](./backend/README.md).

## Build and tests

```sh
cd frontend
npm run build
```

The landing page and voxel game run on the same frontend server. Click **Enter my home** to open `/game/player-home/playerhome.html`; its game script is `frontend/game/player-home/playerHome.js`. The game saves each player's blocks through the backend SQLite API and keeps pending edits in local storage. The shared Vite config also retains the legacy `/api/player-save` endpoint for `playerSaveData/world.json`. You can also start the frontend from the repository root with `npm start`. Run the tests from the repository root with `npm test`. Generated `dist/` output and installed `node_modules/` directories are excluded from source submissions.

## Frontend organization

```text
frontend/
  index.html                      Website HTML entry
  website/
    main.jsx                      React startup, page navigation, and stats loading
    pages/
      home/                       LandingPageView.jsx and LandingPage.css
      login/                      Login.jsx and login.css
      minigames/                  MinigamesPage.jsx (game selection page)
      stats/                      PlayerStatsView.jsx
    styles/
      website.css                 Shared website and statistics styles
  game/
    player-home/
      playerhome.html             Playable voxel world HTML entry
      playerHome.js               Game engine, blocks, controls, and saves
      playerHome.css              Game canvas, help, crosshair, and palette
  package.json
  vite.config.js                  Builds the website and game HTML entries
```

Keep website screens and navigation in `website/`, with page-specific styles next to their components. Put playable game code and its UI in `game/`. The minigames selection page belongs to the website; future playable minigames should have their own folders under `game/`. Navigation and statistics loading stay together in `main.jsx`, while `PlayerStatsView.jsx` renders the results.
