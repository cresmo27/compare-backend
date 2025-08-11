# compare-backend (low-cost)
Backend con límites de tokens y resumen opcional para comparar OpenAI y Gemini a bajo coste.

## Variables de entorno recomendadas
```
PORT=8080
OPENAI_API_KEY=tu_clave_openai
OPENAI_MODEL=gpt-4o-mini

GEMINI_API_KEY=tu_clave_gemini
GEMINI_MODEL=gemini-2.5-flash-lite

# Opcional
SUMMARY_PROVIDER=gemini     # "gemini" (barato) o "openai"
MAX_TOKENS_OUT=250
TEMP=0.3
```
