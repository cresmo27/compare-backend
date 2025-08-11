# compare-backend-pro
Backend con **planes (free/pro)**, **cuota diaria** y **resumen opcional**. Compatible con la extensión "multi-ia-extension-pro".

## Variables de entorno (ejemplo barato)
```
PORT=8080

OPENAI_API_KEY=tu_key_openai
OPENAI_MODEL=gpt-4o-mini

GEMINI_API_KEY=tu_key_gemini
GEMINI_MODEL=gemini-2.5-flash-lite

SUMMARY_PROVIDER=gemini
MAX_TOKENS_OUT=350
TEMP=0.3

# Usuarios y planes
USERS_JSON={"demo-free-123":"free","demo-pro-123":"pro"}  # mapea App Keys a planes
FREE_MAX_PROVIDERS=2
FREE_ALLOW_SUMMARY=false
FREE_DAILY_QUOTA=50
```

## Endpoints
- `POST /compare`  → body: `{ prompt, providers:{openai,gemini}, doSummary }`. Cabecera: `x-app-key: TU_APP_KEY`.
- `GET /health`
- `GET /me`        → devuelve `{ plan, remaining }` según tu `x-app-key`.

> Nota: La cuota diaria y los contadores son **en memoria** (MVP). En producción usa Redis o DB.
