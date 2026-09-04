# COME SAYULA

Aplicación móvil instalable para pedidos, restaurantes y repartidores locales.

## Render

- Tipo: Web Service de Node.js.
- Construcción: `npm ci`.
- Inicio: `npm start`.
- Salud: `/api/health`.
- Disco persistente: montar en `/var/data`.
- Variables: usar las claves documentadas en `.env.example`; configurarlas como secretos en Render.

La base SQLite, imágenes subidas y respaldos se guardan exclusivamente bajo `/var/data`. No desplegar sin disco persistente.
