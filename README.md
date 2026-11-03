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

The voxel game and its tests are run from the repository root with `npm start` and `npm test`. Generated `dist/` output and installed `node_modules/` directories are excluded from source submissions.
