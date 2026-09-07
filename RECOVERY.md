# Recuperación de COME SAYULA

## Qué se respalda

El servidor crea una copia consistente de SQLite aproximadamente cinco segundos después de iniciar y después cada 24 horas. Los archivos se guardan en DATA_DIR/backups y se valida integrity_check antes de considerarlos correctos. De forma predeterminada se conservan los siete respaldos más recientes; BACKUP_RETENTION_COUNT permite conservar entre 2 y 90.

La base, los respaldos, las imágenes y los comprobantes deben vivir en el disco persistente montado en /var/data. Además del respaldo local, el propietario debe copiar periódicamente una copia cifrada fuera de Render.

## Comprobación segura

Nunca pruebes una restauración encima de producción. Descarga o copia un respaldo a un equipo controlado y ejecuta:

    $env:BACKUP_FILE='C:\ruta\segura\come_sayula-fecha.db'
    npm run test:restore

La prueba crea otra carpeta temporal, copia allí el respaldo, abre la copia en modo de sólo lectura, ejecuta integrity_check, confirma las tablas esenciales y elimina únicamente esa copia temporal.

También puedes indicar una carpeta y se elegirá el respaldo más reciente:

    $env:BACKUP_DIR='C:\ruta\segura\backups'
    npm run test:restore

## Recuperación durante una incidencia

1. Detén temporalmente el servicio para impedir nuevas escrituras.
2. Conserva una copia separada de la base dañada y de sus archivos -wal y -shm; no los publiques ni los envíes por canales inseguros.
3. Selecciona el respaldo correcto y valida una copia con npm run test:restore.
4. Crea un directorio de recuperación nuevo y copia allí el respaldo validado con el nombre come_sayula.db.
5. Inicia una instancia de prueba apuntando DATA_DIR y DB_FILE a ese directorio nuevo.
6. Comprueba acceso, pedidos, historial, inventario, caja y conciliación.
7. Sólo después de la aprobación del propietario, sustituye la base del servicio detenido y vuelve a iniciarlo.
8. Verifica /api/health, confirma que database sea ok, revisa el último pedido y registra la incidencia.

Si no existe una copia válida, no sobrescribas producción: conserva todos los archivos y solicita recuperación especializada.
