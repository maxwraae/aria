# Aria

Autonomous objective engine. SQLite-backed tree of objectives, each with an inbox, agent turns, and status lifecycle. Surface is a React SPA served statically by the engine.

## Project structure

- `engine/` — TypeScript server + CLI + agent engine
- `surface/` — React frontend (Vite)

## Running

```bash
# Development (watch mode, auto-rebuilds on changes)
cd engine && npm run dev

# Production
cd engine && npm run build && npm start
# or just: aria up
```

Port 8080. Tailscale HTTPS auto-starts on boot.

## Building the surface

```bash
cd surface && npm run build
```

Produces `surface/dist/` which the engine serves statically.

## Key commands

```bash
aria up              # start engine (production)
aria tree            # show objective tree
aria find "query"    # search objectives
aria show <id>       # show objective details
```
