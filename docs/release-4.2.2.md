# Nivra 4.2.2

Corrección de la recuperación autorizada del historial entre teléfono y web y de la apertura del historial cifrado Android. Android versionCode 31; protocolo de llamadas 2.

## Android

La comprobación de la contraseña de SQLite puede cerrar las conexiones nativas. Ahora la reconciliación con el registro JavaScript ocurre después de comprobar el secreto, para que la aplicación no reutilice una conexión que ya no existe. Si el complemento no pudo inicializarse al arrancar por un fallo transitorio del almacén seguro, un reintento acotado vuelve a inicializar el complemento registrado. No cambia secretos ni elimina la base.

## Recuperación entre dispositivos

La consulta de la respuesta autorizada se realiza independientemente del listado de solicitudes de otros dispositivos. Las operaciones del protocolo tienen un plazo máximo; una petición bloqueada deja de mantener el botón ocupado indefinidamente.

Si las claves ya llegaron pero falla la actualización de mensajes, la recuperación puede repetirse automáticamente con esas claves mediante reintentos acotados. Los mensajes eliminados o caducados dejan de formar parte de la cola pendiente y no vuelven a introducirse al recuperar claves.

## Chats

La lista conserva nombres, fotos y vistas previas legibles. Las vistas previas todavía cifradas muestran siluetas durante el trabajo de recuperación; la espera de una autorización conserva un estado pendiente sin animación permanente. Los avisos transitorios desaparecen y los errores locales reales conservan su acción de recuperación.

Los filtros tienen una presentación compacta sin la barra de desplazamiento decorativa visible, y las filas ocupan menos espacio en móvil y escritorio. Se mantienen navegación, menús de conversación, temas y reducción de movimiento.

## Validación

Pasaron 172 pruebas focalizadas de Angular, 28 comprobaciones de seguridad del historial en .NET, 32 pruebas unitarias Android y 2 pruebas del registro compartido del puente nativo. Incluyen Web Crypto real para la transferencia autorizada, reintentos acotados, respuestas múltiples, preservación de claves, el wrapper SQLite real con los efectos laterales Android y lecturas simultáneas al borrado de conversaciones.

La compilación web de producción terminó correctamente. Mantiene el aviso del presupuesto inicial de 2 MB: el bundle inicial ocupa 3,06 MB. No se añadieron dependencias ni se elevó el presupuesto. La suite Angular general no llegó a ejecutar casos por problemas del perfil/captura y conexión de Chrome; la suite focalizada se ejecutó después con perfil aislado.

La validación visual interactiva no pudo completarse: el navegador integrado agotó el tiempo de espera en sus intentos de conexión. No hay teléfono conectado por ADB, por lo que no se afirma haber reproducido la corrección en el dispositivo físico afectado.

El APK usa `com.nivra.app`, versión 4.2.2, build 31 y la misma firma v2 de las versiones anteriores. Se prepararon también el ZIP web, el paquete portátil Windows y su instalador; este último conserva la distribución sin firma Authenticode. La verificación de paquetes comparó por SHA-256 los 1430 recursos web de Windows y su ZIP, los 1429 incluidos en Android y los 1430 del ZIP web independiente. Se generaron checksums y el manifiesto de actualización a partir de los binarios finales.

La validación y los artefactos de esta versión se registran en `artifacts/release-422-*`. Las pruebas locales utilizan datos ficticios. Compilar o generar un APK no publica automáticamente la actualización web ni el canal de descargas.
