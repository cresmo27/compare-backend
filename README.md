# compare-backend
Backend mínimo para comparar respuestas de varias IA (OpenAI + Gemini).

## Requisitos
- Node 18+ (trae `fetch` global)
- API keys: `OPENAI_API_KEY` y `GEMINI_API_KEY`

## Uso local
```bash
npm install
cp .env.sample .env   # edita tus claves
npm start
# prueba: http://localhost:8080/health
```

## Variables de entorno
```
PORT=8080
OPENAI_API_KEY=tu_clave_openai
OPENAI_MODEL=gpt-4o-mini
GEMINI_API_KEY=tu_clave_gemini
GEMINI_MODEL=gemini-2.5-flash
```

## Deploy en Render (rápido)
1. Sube esta carpeta a un repo nuevo en GitHub (p.ej. `compare-backend`).
2. En Render → New Web Service → conecta el repo.
3. Runtime: Node 18+.
4. Start command: `npm start`.
5. Añade las variables de entorno de `.env.sample`.
6. Deploy y comprueba `/health`.
