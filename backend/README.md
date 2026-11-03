# BlockTogether Backend (Express)

## Run
```
cd backend
npm install
npm start
```
Server runs at http://localhost:3001. Data is stored in `data/db.json` (demo data; a real database comes in Phase III).

## Endpoints
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/health | Check the server is running |
| GET | /api/worlds/me/blocks | Load saved world blocks |
| POST | /api/worlds/me/blocks | Save block edits (blockId 0 removes a block) |
| POST | /api/sessions | Start a play session |
| PATCH | /api/sessions/:id | End a session and record its duration |
| POST | /api/events | Save gameplay events (position, block_placed, block_broken, entity_kill) |
| GET | /api/users/me/stats | Playtime statistics and break reminder |

## Test with curl
```
curl localhost:3001/api/users/me/stats
curl -X POST localhost:3001/api/worlds/me/blocks -H "Content-Type: application/json" -d '{"blocks":[{"x":3,"y":1,"z":0,"blockId":2}]}'
```
Invalid requests return JSON like `{"error": "..."}` with status 400, 404, or 409.
