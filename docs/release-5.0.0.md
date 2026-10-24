# Nivra 5.0.0

Versión del cliente y del backend: **5.0.0**. Android mantiene el paquete `com.nivra.app` y usa **versionCode 32**. El protocolo de llamadas permanece en 2.

Esta versión aborda dos causas distintas de un historial pendiente: una instalación que conserva credenciales de otro dispositivo y un almacén local cuya apertura falla. Incorpora recuperación de identidad, validación de la clave SQLite retenida y diagnósticos que permiten distinguir esos fallos. La comprobación en el teléfono afectado y la sincronización contra el servicio publicado siguen pendientes.

## Identidad independiente por instalación

Antes de recuperar o publicar claves, el cliente comprueba la cuenta, el dispositivo autorizado, su identificador de instalación y la identidad publicada. Puede encontrar la clave exacta en registros de la misma cuenta, incluso después de cambiar el alias o importar un historial autorizado. Una coincidencia de alias no acredita la propiedad de una clave.

Si una vinculación QR antigua copió las credenciales del teléfono, el cliente prepara y guarda una identidad propia antes de solicitar una sesión independiente mediante `POST /auth/repair-device`. El backend conserva el dispositivo fuente y sus claves. Un destinatario existente sólo se puede reutilizar cuando coincide su identidad y consta el vínculo original de reparación con su secreto de reintento; copiar su clave pública y su identificador de instalación no permite obtener su sesión. Los dispositivos revocados o de otra cuenta se rechazan.

El cliente comprueba la identidad publicada del destinatario y guarda sus claves antes de adoptar la nueva sesión. Las operaciones concurrentes se comparten y los cambios de cuenta o de sesión invalidan resultados antiguos. Si el servidor no admite la reparación o existe un conflicto, la interfaz permite volver a vincular el equipo sin borrar su historial local. Una clave privada existente que no se pueda desbloquear no se sustituye por otra durante esa lectura.

## Historial local y diagnóstico

Android puede conservar una contraseña válida de SQLCipher aunque el protector independiente de Nivra esté inaccesible o no coincida. En ese caso se prueba exclusivamente la base ya existente con una conexión de sólo lectura. Se comprueban las tablas y columnas necesarias antes de permitir su uso normal. No se acepta una base vacía creada como sustituto ni se cambia la contraseña para aparentar una recuperación.

La reconciliación de conexiones continúa realizándose después de comprobar el secreto, porque esa comprobación cierra conexiones nativas en el complemento SQLite. Un fallo transitorio de inicialización del complemento dispone de recuperación acotada y se comprueba primero que el complemento no esté ya disponible.

La apertura publica una etapa y un código de causa permitidos, junto con el intento y la posibilidad de reintento. Distingue, entre otros, protector incompleto, clave de Android ausente o invalidada, base ilegible con la clave retenida, estructura incompatible y falta de espacio. Los mensajes y diagnósticos no incluyen secretos, contenido de conversaciones, SQL recibido ni rutas privadas. Una inspección de la cabecera puede identificar el formato SQLite anterior sin convertir ni reemplazar el archivo.

Las lecturas de secretos existentes usan `create: false` en Android y Windows. Android conserva los fragmentos de un protector incompleto y no genera una clave Keystore al intentar leer un sobre existente. La creación se serializa y su escritura se confirma antes de devolver el secreto. Windows conserva los archivos protegidos ilegibles y evita sobrescribir el secreto que otra operación haya creado. Un puente Windows antiguo que no admite la lectura sin creación se rechaza para ese recorrido.

## Recuperación autorizada y continuidad de los chats

La entrega de una respuesta autorizada no espera al listado de solicitudes de otros equipos. Las peticiones de transferencia tienen un plazo máximo y los fallos transitorios posteriores a importar claves disponen de reintentos acotados. La aprobación sigue requiriendo comparar y confirmar el código en ambos dispositivos. Recibir el paquete no marca por sí solo el historial como completo: se vuelven a leer los mensajes y las conversaciones afectadas.

La descarga continua por HTTP usa un cursor v2 compuesto por la fecha y el ID del último mensaje entregado. Su avance se mantiene separado de los mensajes recibidos por SignalR y del lote reciente del bootstrap: recibir un mensaje nuevo por otro canal no permite saltarse los anteriores. Los mensajes que comparten fecha también se recorren sin perder el límite entre páginas.

Al reanudar se vuelve a consultar una ventana de cinco minutos para recoger mensajes cuya transacción terminó de confirmarse después de una lectura anterior. El historial pendiente se recorre en lotes de hasta ocho páginas por pasada, guardando el cursor para continuar desde el avance confirmado en la siguiente pasada.

Los avisos cifrados antiguos conservados tras reiniciar se pueden recuperar por sus IDs mediante `POST /messages/history-recovery`, en grupos de hasta cien. El servidor exige un sobre destinado a la cuenta actual y participación activa en la conversación. Sólo devuelve una marca de borrado cuando existe un recibo propio de eliminación o un vencimiento comprobado; un ID desconocido o ajeno no se trata como prueba de borrado. El cliente también aplica las marcas de borrado recibidas en el bootstrap.

El borrado de mensajes y el vaciado de conversaciones invalidan también las recuperaciones y lecturas anteriores. La protección cubre la acción HTTP aunque no llegue el evento de SignalR, el primer descifrado todavía en curso y la persistencia de una lectura tardía de caché. Los mensajes legibles no se reemplazan por una copia cifrada o atrasada durante una actualización.

La lista de chats usa filas y filtros más compactos, historias plegables, un control visible de actualización y avisos de historial con detalles accesibles desde un panel. Durante la actualización, nueve siluetas sustituyen visualmente la lista completa; se conservan sus datos, elementos y posición de desplazamiento hasta mostrar el resultado actualizado. Se ajustan la navegación móvil, los espacios y las superficies de los temas claro y oscuro, conservando las preferencias de reducción de movimiento.

La web puede detectar una versión nueva al volver a primer plano o recuperar conexión. La recarga se aplaza cuando el cliente informa de una operación sensible o contenido pendiente y se registra la versión aplicada para evitar recargas repetidas del mismo despliegue.

## Validación

Pasaron **789/789 pruebas Angular**, **61/61 comprobaciones .NET**, **12/12 pruebas Node**, **36/36 pruebas unitarias Android** y **20/20 comprobaciones offline del canal de actualizaciones**. La compilación web de producción terminó correctamente. Las regresiones cubren claves conservadas, lectura sin creación, rechazo de destinos ajenos, persistencia real de la sesión reparada, diagnóstico seguro, mensajes borrados durante una recuperación, continuidad del cursor HTTP y autorización de la recuperación por IDs.

APK, instalador Windows y ZIP portátil compilados y verificados. Se compararon 1430 archivos web de Windows, 1429 del APK (Android omite `.well-known`) y 1430 del ZIP con la compilación de producción. El APK identifica 5.0.0/build 32 y conserva la firma SHA256 `e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`. El verificador generó los hashes y el manifiesto de actualización a partir de los binarios finales. La publicación se completa después de esta validación.

Se inspeccionó `ChatsPage` real en un entorno local de pruebas con datos ficticios, en escritorio y anchuras móviles de 390 y 360 px. Se comprobó la lista, las siluetas completas, el retorno de los chats al terminar una recarga simulada, el aviso compacto y su panel de diagnóstico. Los archivos temporales de esta prueba no forman parte de la aplicación publicada.

No se ha confirmado la corrección mediante instalación física en el teléfono afectado ni mediante una sincronización real teléfono–web contra el backend publicado. Las pruebas locales utilizan cuentas y datos ficticios. El cambio no reconstruye claves privadas perdidas, mensajes eliminados ni una base incompatible; esos casos conservan un error identificable y los datos disponibles.

## Despliegue

**Render requiere un despliegue manual del backend actualizado.** El cliente necesita que el servidor que atiende la cuenta incluya `/auth/repair-device`, `/messages/history-recovery` y el cursor v2 de sincronización; instalar el APK o publicar la web no incorpora esas funciones a una API anterior. Deben conservarse la base de datos y los secretos de producción y comprobarse la disponibilidad y compatibilidad del backend después del despliegue.

Los paquetes y el canal de actualización se publican sólo después de verificar las compilaciones finales. El procedimiento está en [la guía del canal de actualizaciones](release-update-feed.md). Hasta completar la publicación y comprobar los recursos públicos no se afirma que 5.0.0 esté disponible para los usuarios.
