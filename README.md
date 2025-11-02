# Multi-IA Compare — Backend v1.8.1
Endpoints:
- GET /health → { ok, tag }
- GET /v1/health → { ok, tag }
- GET /v1/debug-routes → listado de rutas (debug)
- POST /v1/compare-multi → { ok, openai, gemini, claude } // simulado

Render:
- Build Command: (vacío)
- Start Command: node server.js
- Node: 18+
- CORS: habilitado en server.js
