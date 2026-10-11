# Historias en Nivra 2.1.0

El visor compartido usa un único reloj de reproducción para Chats, los perfiles de chats y Mundo. Fotos y texto comienzan cuando la autorización y el descifrado terminan; las fotos esperan además su carga. Audio y vídeo muestran el progreso de `currentTime` y avanzan con el evento real `ended`, sin un temporizador que pueda saltarse un vídeo mientras carga.

Mantener pulsado, escribir una respuesta, abrir las estadísticas o las reacciones, confirmar compartir, pausar o pasar la app a segundo plano pausa la reproducción. Cuando el navegador bloquea el audio automático, el vídeo puede empezar silenciado con un control visible para activar sonido. Si también bloquea la reproducción silenciosa, aparece una acción explícita para reproducir. Cada entrada del visor tiene un propietario local para impedir dos modales simultáneos entre Chats y su página hija.

Las historias vistas permanecen en la secuencia y la apertura normal empieza en la primera nueva. La vista explícita de una historia concreta conserva su posición. Las historias de una sola vista no se precargan: su contenido cifrado se descarga y descifra **antes** de consumir `/view`, porque después de esa petición la autorización del medio se pierde. Si la descarga falla, no se consume la vista. El contenido de una sola vista se elimina de la memoria al cerrarlo o pasar a la siguiente historia.

El creador dispone de estadísticas de vistas, reacciones y respuestas del servidor. Abrirlas pide una instantánea actual; los eventos existentes actualizan el contenido mientras el visor está abierto. No se incrementan contadores por eventos antiguos sin datos completos. Las respuestas pueden abrir su conversación real. La actualización del propietario no cuenta su propia vista.

Compartir publica de nuevo la historia para los contactos del usuario, conserva el autor original y pide una confirmación explícita. Respeta las restricciones del autor y de una sola vista. No mide compartidos externos, no inventa estadísticas de compartidos y no envía contenido a otras aplicaciones automáticamente. El creador puede eliminar su historia con confirmación explícita; el servidor conserva la comprobación de propiedad.

Las descargas cifradas simultáneas del mismo medio se unen a una sola petición. Cuando el servidor ofrece un acceso S3 temporal autorizado, `EncryptedDownloadService` descarga el objeto cifrado sin enviar credenciales de Nivra al almacenamiento. Mantiene el proxy autorizado para versiones antiguas o problemas de CORS. La memoria de medios descifrados se limita a 4 objetos o 64 MB, conservando el elemento visible y el último precargado; esos dos elementos pueden superar ese presupuesto si son archivos grandes. La precarga adyacente omite vídeos u otros medios de más de 8 MB; se descargan al abrirlos.

## Validación

Las pruebas de historias cubren orden de autorización y consumo de una sola vista, descarga fallida sin consumo, cierre durante descarga, respuesta tardía que no reabre un visor antiguo, separación de cuentas y dispositivos, unión de descargas, eliminación de contenido de una sola vista, límite de memoria y omisión de precargas grandes. Las pruebas de reproducción cubren espera de carga, buffering, reloj del medio, pausa real, segundo plano, bloqueo de autoplay, cancelación y accesibilidad con teclado. Las estadísticas usan recuentos reales y descartan navegación tardía hacia otra cuenta.

No se han realizado envíos o llamadas a contactos reales ni modificaciones de producción para estas comprobaciones. Queda la validación física de reproducción y gestos en Android e iOS/Safari, audio con la app en segundo plano y una red móvil lenta. Esta lista describe límites de validación, no una garantía de ausencia total de fallos.
