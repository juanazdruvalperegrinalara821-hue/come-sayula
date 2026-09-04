# Preparación de COME SAYULA para producción

## Cuenta administrativa inicial

Antes del primer arranque define `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 12 caracteres). El servidor crea una sola cuenta administrativa si todavía no existe una. Después entra en `/auth.html` como **Administrador** y elimina esas variables del entorno. Restaurantes y repartidores se crean en `/admin.html`, quedan pendientes y sólo pueden iniciar sesión después de ser aprobados.

## Servicios externos pendientes

- Configurar un proveedor transaccional de correo o SMS para entregar los enlaces de recuperación. Nunca activar `DEV_SHOW_RESET_TOKEN=1` en producción.
- Contratar una pasarela de pago. La transferencia actual es conciliación manual: permanece como `awaiting_confirmation` hasta que el restaurante comprueba el depósito.
- Publicar detrás de un proxy HTTPS, definir `NODE_ENV=production`, `JWT_SECRET` con al menos 48 bytes aleatorios y `TRUST_PROXY=1` únicamente si existe un proxy confiable.
- Sustituir el servicio público de rutas OSRM por uno contratado o propio antes de aumentar tráfico.

## Operación y seguridad

- `/api/health` sirve para monitoreo. Conectar este endpoint y los registros del proceso a alertas centralizadas.
- Las limitaciones de tráfico se guardan en SQLite y sobreviven reinicios. En despliegues con varias instancias deben migrarse a Redis u otro almacén compartido.
- Los respaldos se crean cada 24 horas en `backups/`, nunca se eliminan automáticamente y deben copiarse cifrados a una ubicación externa. Define una política de conservación antes de limpiar archivos antiguos.
- Ejecutar `node test-flows.js` después de cambios. Ejecutar `node test-restore.js` para validar el respaldo más reciente.
- Revisar regularmente `audit_logs`, accesos administrativos, transferencias confirmadas y cambios de estado.

## Lista de salida

1. Completar los datos legales y de soporte en `/legal.html`.
2. Obtener consentimiento explícito para ubicación y definir su plazo de conservación.
3. Documentar reembolsos, cancelaciones, disputas, fraude y conciliación diaria.
4. Probar correo/SMS, pagos, HTTPS, restauración y alertas desde teléfonos reales.
5. Ejecutar una revisión de seguridad independiente antes de procesar tarjetas o datos sensibles.
