# Preparación de COME SAYULA para producción

## Cuenta administrativa inicial

Antes del primer arranque define `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 12 caracteres). El servidor crea una sola cuenta administrativa si todavía no existe una. Después entra en `/auth.html` como **Administrador** y elimina esas variables del entorno. Restaurantes y repartidores se crean en `/admin.html`, quedan pendientes y sólo pueden iniciar sesión después de ser aprobados.

## Servicios externos pendientes

- Generar una pareja VAPID una sola vez y guardar `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` como secretos de Render. La clave privada nunca debe subirse al repositorio. Mantener las mismas claves evita invalidar los teléfonos ya suscritos. Definir también `SUPPORT_EMAIL`, que identifica al responsable del servicio de avisos.
- Las notificaciones Web Push no requieren Firebase: usan el estándar del navegador y funcionan en Android al conceder permiso. En iPhone es necesario instalar primero la PWA en la pantalla de inicio. Probar la recepción con la aplicación cerrada en teléfonos reales antes del piloto.
- Configurar un proveedor transaccional de correo o SMS para entregar los enlaces de recuperación. Nunca activar `DEV_SHOW_RESET_TOKEN=1` en producción.
- El enlace enviado por ese proveedor debe usar `/reset-password.html?token=TOKEN`. Al cambiar la contraseña, el enlace queda inutilizado y se cierran las sesiones anteriores. Mientras no exista proveedor, un administrador puede verificar manualmente correo o teléfono desde el panel; esto no sustituye la verificación real para una apertura pública. Activar `ACCOUNT_MESSAGE_PROVIDER_ENABLED=1` únicamente después de probar el proveedor.
- Contratar una pasarela de pago. La transferencia actual es conciliación manual: permanece como `awaiting_confirmation` hasta que el restaurante comprueba el depósito.
- Mantener `PAYMENT_PROVIDER_ENABLED=0` mientras no exista una pasarela formal. La API rechaza campos con número de tarjeta, vencimiento o código de seguridad tanto en pedidos como en el punto de venta.
- Publicar detrás de un proxy HTTPS, definir `NODE_ENV=production`, `JWT_SECRET` con al menos 48 bytes aleatorios y `TRUST_PROXY=1` únicamente si existe un proxy confiable.
- Sustituir el servicio público de rutas OSRM por uno contratado o propio antes de aumentar tráfico.

## Operación y seguridad

- `/api/health` sirve para monitoreo. Conectar este endpoint y los registros del proceso a alertas centralizadas.
- Las limitaciones de tráfico se guardan en SQLite y sobreviven reinicios. En despliegues con varias instancias deben migrarse a Redis u otro almacén compartido.
- Los respaldos se crean al iniciar y cada 24 horas en `DATA_DIR/backups/`. Cada copia pasa `integrity_check` y se conservan las siete más recientes de forma predeterminada. Ajusta `BACKUP_RETENTION_COUNT` según el espacio disponible y copia respaldos cifrados a una ubicación externa.
- Ejecutar `npm test` después de cambios. Para validar una copia concreta sin tocar producción, define `BACKUP_FILE` o `BACKUP_DIR` y ejecuta `npm run test:restore`. El procedimiento completo está en `RECOVERY.md`.
- En `/api/health`, `persistentStorageConfigured` debe ser `true` en Render y `lastBackupAt` debe mostrar una fecha reciente. El panel administrativo de almacenamiento también muestra cantidad de respaldos y retención configurada.
- Revisar regularmente `audit_logs`, accesos administrativos, transferencias confirmadas y cambios de estado.
- El panel administrativo permite consultar los registros recientes de auditoría. El procedimiento diario, cancelaciones, reembolsos y escalamiento está en `OPERATIONS.md`.
- Completar y revisar localmente `/legal.html`; sólo después de aprobación jurídica y de configurar datos reales puede establecerse `LEGAL_DOCUMENTS_APPROVED=1`.

## Lista de salida

1. Completar los datos legales y de soporte en `/legal.html`.
2. Obtener consentimiento explícito para ubicación y definir su plazo de conservación.
3. Documentar reembolsos, cancelaciones, disputas, fraude y conciliación diaria.
4. Probar correo/SMS, pagos, HTTPS, restauración y alertas desde teléfonos reales.
5. Ejecutar una revisión de seguridad independiente antes de procesar tarjetas o datos sensibles.
