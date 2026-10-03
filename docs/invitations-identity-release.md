# Invitaciones y comparación de identidad sobre 1.1.2

El trabajo experimental completo está conservado en `feature/coturn-futuro`, commit `ff4dcf6`. No se ha publicado esa rama. Los secretos locales permanecen en archivos excluidos del índice y no están en el commit. Volver a esta rama recupera CoTURN, los prototipos MLS y el puente Rust pendiente de compilación.

## Cambios de esta entrega

- Invitaciones de grupo: token aleatorio de 256 bits, solo su hash en PostgreSQL, 24 horas de vigencia, 25 incorporaciones, creación/revocación por administradores, comprobación del rol del creador al aceptar, rechazo de miembros expulsados. La aceptación bloquea las filas del enlace y de la conversación, y es idempotente para miembros existentes. El token viaja en el fragmento de URL y se presenta al API por POST.
- Pantalla de invitación con confirmación y continuación después del login. El administrador puede copiar el enlace o enviarlo por un chat seleccionado usando el cifrado existente.
- Comparación de las identidades de dispositivos en chats directos: QR, lectura de imagen QR y código hexadecimal para comparar por un canal confiable. La identidad propia publicada se contrasta con la llave local. No es el formato de números de seguridad de Signal.
- Llaves de contacto recordadas en IndexedDB, separadas por cuenta/dispositivo, con escrituras transaccionales. Primera observación no equivale a verificación. Cambio posterior bloquea el cifrado saliente y muestra un aviso; aceptar requiere comparar el código. El envío obtiene directorios actualizados, sin recurrir a llaves antiguas si falla la red.

No se cambia el cifrado de los mensajes ni de las llamadas. Los grupos ya envuelven la clave de cada mensaje para sus destinatarios; el nuevo miembro participa en mensajes futuros sin que el servidor reciba claves privadas ni se le entregue automáticamente historial antiguo. No se añade una llave permanente de grupo ni se anuncia MLS/PFS.

## Estado y límites

La migración aditiva `20261003163236_GroupInviteLinks` debe validarse contra PostgreSQL de ensayo antes del despliegue. La aplicación ejecuta migraciones al arrancar; desplegar el backend implica aplicarla. No se ejecutó contra producción.

Las pruebas offline verifican permisos, caducidad, revocación, agotamiento, miembros expulsados, cambios de rol y SQL aditivo. Las pruebas del navegador verifican persistencia y concurrencia de pines, y el bloqueo antes del cifrado. No sustituyen redención concurrente real en PostgreSQL, ni pruebas entre dos dispositivos.

La verificación detecta cambios frente a las llaves guardadas y permite comparación externa. No impide que un dispositivo comprometido lea mensajes; borrar los datos locales borra también estos pines. Los dispositivos nuevos empiezan sin verificaciones. No incluye transparencia de claves ni verificación de grupos.

Antes de publicar: dos cuentas en ensayo, crear/copiar/abrir enlace, login de invitado, aceptar dos veces, aceptar simultáneamente el último uso, revocar, caducar, expulsar y degradar al creador; enviar un mensaje grupal nuevo y confirmar ausencia del historial anterior. Comparar QR en ambos contactos, cambiar/agregar/revocar dispositivo y comprobar bloqueo, cerrar/reabrir la app y comparar de nuevo. Validar apertura del enlace en Android y web. Ningún cambio CoTURN debe entrar en este despliegue.

Sealed Sender no está activo; véase [condiciones de activación](sealed-sender-deployment-gates.md). No se ofrece una garantía de ausencia de metadatos.
