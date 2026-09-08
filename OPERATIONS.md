# Operación del piloto de COME SAYULA

## Mercado Pago en pruebas

- El cliente sale a Checkout Pro; COME SAYULA no solicita ni almacena números de tarjeta.
- Mientras el pago diga `awaiting_online_payment`, el restaurante no ve ni puede procesar el pedido.
- La página de retorno y el webhook consultan la API de Mercado Pago y comparan estado aprobado, referencia, moneda MXN y total exacto antes de liberar el pedido.
- Las credenciales de prueba no deben sustituirse por producción ni debe activarse `PAYMENT_PROVIDER_ENABLED` sin autorización del propietario.

Responsable operativo: Juan Azdruval Peregrina Lara. Soporte: juanazdruvalperegrinalara821@gmail.com y +52 312 112 4003, de lunes a sábado de 9:00 a 20:00 (hora de Sayula, Jalisco). El primer seguimiento debe proporcionarse en un máximo de dos días hábiles; incidentes de seguridad, cargos desconocidos o riesgo físico se priorizan de inmediato.

## Cancelaciones

- El cliente solicita ayuda desde el centro de problemas e indica el folio del pedido.
- Antes de que el restaurante comience a preparar, soporte confirma con el restaurante y registra la cancelación y su motivo.
- Después de comenzar la preparación, soporte revisa el caso con ambas partes; no promete una devolución automática.
- Un pedido entregado no se cancela: se abre una incidencia y se conserva su historial.
- Todo cambio de estado, conciliación o resolución debe quedar asociado a una cuenta identificada en la auditoría.

## Reembolsos y disputas

- Transferencia: permanece como pago por confirmar hasta que el restaurante compruebe el depósito. Una devolución se realiza por un medio acordado y se registra con fecha, importe, referencia y responsable.
- Efectivo o tarjeta al recibir: soporte documenta el reclamo; el restaurante confirma si hubo cobro y cómo se devolvió el importe.
- Cobro en línea: no debe activarse hasta contratar un proveedor formal. La pasarela será responsable de recibir número de tarjeta, vencimiento y código de seguridad; COME SAYULA no debe recibirlos ni almacenarlos.
- Los comprobantes sólo deben contener la información indispensable. Nunca se solicitan contraseñas, NIP, CVV ni códigos de verificación.

## Atención y escalamiento

1. Registrar folio, pedido, categoría, descripción y canal de contacto autorizado.
2. Acusar recibo y comunicar un plazo realista de respuesta.
3. Escalar de inmediato incidentes de seguridad, cargos desconocidos, riesgo físico o exposición de datos al responsable del servicio.
4. Registrar resolución y cerrar el caso únicamente después de comunicarla al usuario.
5. Revisar diariamente pedidos sin respuesta, transferencias pendientes, cancelaciones, incidencias y alertas de respaldo.

## Lista de apertura y cierre

- Al abrir: comprobar salud del servidor, respaldo reciente, restaurante y repartidores disponibles, zonas activas, notificaciones y canal de soporte.
- Durante el turno: revisar pedidos programados próximos o atrasados y pedidos sin respuesta.
- Al cerrar: conciliar transferencias y cortes, revisar auditoría administrativa, incidencias abiertas y alertas de almacenamiento.
- Ante una falla: detener nuevos pedidos si no puede garantizarse el servicio, conservar evidencia y seguir `RECOVERY.md`; nunca restaurar directamente sobre producción.
