# Nivra 9.3.1

15 de noviembre de 2026. Android build 60.

## Cambios

- Web y Windows empiezan con una barra lateral blanca de 68 px. El botón bajo el escudo abre el panel verde de 188 px con etiquetas y contador; la transición dura 200 ms y la preferencia se guarda en localStorage. La navegación inferior nativa permanece independiente.
- En móvil, el desplazamiento recoge historias, buscador y filtros de Chats y los recupera al subir. La selección, la búsqueda y los gestos laterales conservan sus controles. Los ajustes de altura de la lista no se confunden con un cambio de dirección del usuario.
- Bóveda, Llamadas y Cuenta tienen un fondo superior opaco al desplazarse, como Mundo. La bienvenida de Chats se adapta a un panel estrecho al expandir la navegación.
- La verificación de contactos mejora su contraste oscuro y vuelve a comprobar las llaves al recuperar conexión o regresar a la app. La continuidad automática conserva la distinción frente a comparar personalmente un QR o código y sigue bloqueando cambios de identidad sin autenticar.
- La recuperación de identidad conserva el estado HTTP y Retry-After de los errores temporales. La cola reintenta cuando faltan temporalmente llaves del destinatario y muestra el motivo del pendiente. Los bloqueos antiguos cuyo error perdió el estado reciben una nueva comprobación, conservando el identificador del mensaje y los controles de identidad y permisos.
- La guía incorpora búsqueda, dieciséis funciones, estados de entrega y lectura, recuperación y explicaciones de los automatismos y sus límites.

## Validación

El código funcional pasó 289 pruebas Angular de navegación, Chats, verificación, cola durable, preparación de envíos y recuperación de sincronización. La preparación de publicación añadió 20 controles offline del feed, 12 pruebas Node del feed y de las descargas, y 18 controles de autenticación. Las compilaciones Web de producción 9.3.1 y API Release terminaron correctamente; Web mantiene avisos de tamaño y deprecaciones ya presentes. Se verificaron visualmente ambos estados de la barra y el acordeón móvil con datos ficticios; las capturas están en `artifacts/navigation-improvements/`.

Durante el diagnóstico, las dos API operativas respondieron HTTP 200 en `/health/ready`. Esto no demuestra disponibilidad de cuota de Supabase ni identifica la causa de un mensaje concreto. No se enviaron mensajes reales a otros usuarios para esta comprobación. La validación en teléfonos físicos permanece pendiente.

La evidencia de empaquetado, firma, hashes y publicación de esta versión se guarda en `artifacts/release-9.3.1/`. `tools/verify-release.ps1` comprobó 1.452 recursos Web en Windows y ZIP y 1.451 en APK (Android omite `.well-known/assetlinks.json`), con igualdad exacta respecto de la compilación Web 9.3.1. También verificó el certificado fijado del APK, build 60, la ausencia de depuración y las versiones del EXE y del instalador.

Los entregables verificados son `Nivra-9.3.1-debug.apk` (nombre histórico; es un APK release firmado), `Nivra-9.3.1-Setup.exe` y `Nivra-9.3.1-win32-x64.zip`. El pipeline generó los hashes SHA256 y el manifiesto de actualización después de comprobarlos. El instalador Windows conserva la limitación de no contar con firma Authenticode.
