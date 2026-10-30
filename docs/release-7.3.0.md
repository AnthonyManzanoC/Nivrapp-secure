# Nivra 7.3.0 — recuperación local de historial

Android build 45. Cambios de cliente compatibles con la API 7.0 y el protocolo de llamadas 2. No se requieren migraciones de base de datos.

## Correcciones y experiencia

Un mensaje protegido guardado en la caché puede necesitar descargar su paquete cifrado original por ID. Antes, un fallo de red de esa descarga no tenía recuperación automática si todavía no existía una solicitud de transferencia de llaves. El refresco manual también podía limitarse a las páginas recientes. La nueva comprobación vuelve a intentar los IDs pendientes con las llaves locales, tanto al recuperar la conexión como mediante «Comprobar ahora».

- Hasta tres reintentos automáticos adicionales por ciclo de fallo transitorio, con espera progresiva. Al volver al primer plano o recuperar conexión puede comenzar un nuevo ciclo. No se ejecutan reintentos mientras la app está oculta o sin conexión conocida.
- Una comprobación válida que aún no puede recuperar una copia deja de repetirse automáticamente. La ausencia de una llave original sigue siendo distinta de un fallo de red.
- El listado de dispositivos dispone de una espera breve, limitada a 750 ms, antes de crear una solicitud nueva de vinculación. Si confirma que sólo existe el equipo actual, no se crea una solicitud imposible de aprobar. Las transferencias ya aprobadas no esperan ese listado.
- Los estados de comprobación local, descarga pendiente y llave original no disponible tienen avisos distintos. Una transferencia inactiva ya no se presenta como prueba de que todo el historial está al día. Los chats disponibles siguen utilizándose durante la comprobación.
- Se evita volver a probar la misma identidad criptográfica después del intento inicial con la llave actual. Los controles nuevos se adaptan a 320 píxeles, teclado, escritorio y temas claro/oscuro.

## Seguridad y validación

La recuperación conserva las comprobaciones de usuario, dispositivo, generación de sesión, permisos, expiración y borrado. Usa el servicio de cifrado existente; no crea, sustituye ni publica llaves, no aprueba transferencias automáticamente y no rebaja la verificación de contactos. Las respuestas tardías y los temporizadores de otra cuenta no alteran la cuenta activa.

La suite general contiene 1.416 pruebas aprobadas. Incluye recuperación después de HTTP 503 y desconexión, límite de reintentos, rechazo HTTP 403, aislamiento entre cuentas, directorio lento, dispositivo único y pruebas con ECDH/AES-GCM reales usando llaves correctas e incorrectas. También pasan las dos pruebas WebRTC ejecutadas por separado y las 48 pruebas de Windows: 1.466 comprobaciones funcionales en total. Se revisan visualmente los componentes reales en Chromium a 320, 390 y 1.200 píxeles, en temas claro y oscuro.

Los paquetes se construyen en producción y se verifican por versión, contenido, certificado Android y SHA-256. La comprobación adicional en emulador sigue limitada por el espacio libre del equipo anfitrión; no se afirma validación en teléfonos físicos.

## Límites

El contenido cifrado con una llave original perdida necesita esa llave para recuperarse. Un solo dispositivo registrado no prueba que todos los mensajes antiguos se cifraron con su llave actual. La app conserva los mensajes protegidos y explica esta situación.

El bloqueo de subidas por cuota de Supabase es independiente de esta mejora y necesita resolverse en el proveedor.
