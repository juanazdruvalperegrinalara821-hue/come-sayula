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

## Asistente de IA

- Configura `OPENAI_API_KEY` como secreto únicamente en Render; nunca lo guardes en GitHub.
- `OPENAI_MODEL` usa `gpt-5-mini` por defecto y puede cambiarse desde Render.
- El asistente usa contexto limitado por rol y elimina nombres, teléfonos, domicilios y coordenadas antes de enviar contexto operativo.
- Tiene moderación, límite de 20 mensajes por hora e historial de auditoría.
- La primera versión es de consulta: no puede modificar pagos, cuentas, pedidos, productos ni código.

