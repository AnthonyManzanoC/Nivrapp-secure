# Nivra: mejoras de llamadas, acceso e historias

Revisión actualizada el 13 de septiembre de 2026. Las migraciones aditivas de esta entrega se aplicaron a PostgreSQL y el backend se desplegará con la misma revisión del cliente. El APK queda generado para pruebas físicas; la instalación y los permisos reales deben verificarse en un teléfono antes de anunciar estas funciones.

## Problemas identificados y cambios

| Caso | Causa observada | Cambio implementado |
| --- | --- | --- |
| La llamada saliente aparece dos veces | El broadcast puede abrir la interfaz del emisor en otras sesiones; varias pestañas comparten deviceId. | Solo la respuesta de iniciar abre la llamada saliente. Cada instancia tiene un clientSessionId y el servidor registra al propietario por usuario, dispositivo e instancia. |
| Al contestar, otra sesión sigue sonando y termina cortando la llamada | La cancelación dependía de SignalR y del dispositivo, sin arbitrar la respuesta ni proteger el cierre. | `/claim` decide un único ganador bajo bloqueo de PostgreSQL. Las demás sesiones liberan recursos locales. Señales, tokens y cierres verifican propietario; el sondeo recupera eventos perdidos. |
| El temporizador corta una llamada recién contestada | El vencimiento puede competir con la respuesta. | El cierre con `reason: timeout` verifica el estado bajo el mismo bloqueo y conserva una llamada atendida. Las invitaciones receptoras vencen localmente. |
| Recargar la página deja una llamada inaccesible | La sesión de transporte antigua conserva la propiedad. | “Continuar aquí” usa `/resume` solo tras una acción explícita y sustituye la sesión anterior. Las señales antiguas no recrean conexiones. |
| Se crean varias salas en un grupo | La comprobación de sala existente y su creación no eran una operación atómica. | HTTP y SignalR usan el mismo bloqueo de conversación. Se reutiliza la sala activa. El chat oculta iniciar voz/video y permite unirse o volver. Salir conserva la sala mientras otro participante siga registrado. |
| Al ir a otro chat deja de escucharse al interlocutor | Los elementos de audio estaban dentro de la página de llamadas. | Un servicio mantiene una sola salida de audio por flujo recibido durante la llamada, independiente de la ruta. Los videos permanecen silenciados para evitar duplicación. Hay recuperación de autoplay con “Activar audio” y acceso para volver a la llamada. |
| Colgar sin red deja recursos abiertos | La limpieza esperaba la respuesta del servidor. | Se liberan inmediatamente cámara, micrófono, audio y pantalla local; el fallo de notificar al servidor se comunica al usuario. Capturas que terminan después de colgar se descartan. |
| Android pierde continuidad al salir | No había un servicio nativo específico para la llamada activa. | Servicio foreground de micrófono y reproducción; cámara si procede. Arranca después del permiso y con la app visible, muestra notificación privada y se detiene al terminar. No es una garantía contra todas las restricciones del fabricante/WebView. |
| Historias poco accesibles | Solo se abrían desde las superficies existentes. | Fila horizontal sobre la búsqueda de Chats con historias personales y de grupo, anillos de nuevas/vistas y visor existente. |
| Login genérico, tema incorrecto y QR poco informativo | Se perdían los errores estructurados y se heredaba el tema manual de la cuenta anterior. | Errores accionables, campos legibles, visibilidad de contraseña, tema del sistema sin sesión, contador y renovación QR. El desafío dura 60 segundos y la autorización duplicada se serializa antes de crear credenciales. SMS no se cambia. |
| Riesgo de perder historial por un fallo temporal | Recuperación de SQLite eliminaba la base y algunos fallos cambiaban silenciosamente de almacén. | Se conservan base y claves, se impide el fallback nativo silencioso y se ofrece reintentar. |

## Compartir pantalla en móvil

Android incorpora una ruta nativa de `MediaProjection`: solicita el consentimiento del sistema, usa un servicio foreground de tipo `mediaProjection`, captura con WebRTC nativo y entrega una pista de vídeo a la WebView mediante una conexión WebRTC local. La pista se publica por la conexión directa existente o por la misma sala LiveKit ya creada; no abre una segunda sala, no envía capturas JPEG ni activa el micrófono durante la captura.

Android requiere consentimiento de captura y un servicio de tipo mediaProjection; iOS requiere ReplayKit y una Broadcast Extension para compartir fuera de la aplicación. Lo documentan [Android MediaProjection](https://developer.android.com/media/grow/media-projection) y [LiveKit Screen sharing](https://docs.livekit.io/transport/media/screenshare/). El servicio Android añadido para audio sigue las [restricciones de servicios foreground](https://developer.android.com/develop/background-work/services/fgs/service-types).

Android se compila en este entorno; iOS sigue requiriendo proyecto nativo, extensión, macOS/Xcode y pruebas físicas. La validación física pendiente cubre compartir/detener, revocar consentimiento, rotación, bloqueo de pantalla, cambio de cámara y restauración de cámara al detener la captura.

## Privacidad verificable

SQLite nativo ya estaba configurado para cifrado. Se reforzó la conservación del historial ante errores; no se cambió el protocolo criptográfico ni se derivó la clave exclusivamente de un PIN corto. Las llamadas grupales ahora activan el worker E2EE de LiveKit con claves aleatorias de 256 bits por publicador, distribuidas por la señal cifrada por dispositivo y rotadas ante un cambio de sesión o miembros. El código aún no implementa Double Ratchet/PFS para mensajes. “Cero rastros”, “imposible de peritar” o superioridad frente a Signal/WhatsApp/Telegram no son garantías justificadas por esta entrega.

El inventario, evidencias y prioridades están en [stories-privacy-review.md](stories-privacy-review.md) y [security-production-readiness.md](security-production-readiness.md). La migración a un protocolo mantenido debe contemplar identidad, rotación por mensaje, dispositivos múltiples, revocación y compatibilidad con el historial existente, con revisión externa antes de anunciar esas propiedades.

## Actualización coordinada de clientes

Las llamadas nuevas exigen el protocolo de cliente 2 y el servidor devuelve `426 Upgrade Required` con el aviso de actualización. La URL configurada hoy abre la aplicación web; no instala ni actualiza por sí sola una app Android, iOS o de escritorio. Antes de usar el bloqueo como mecanismo de actualización forzosa para móviles se debe publicar un destino real y verificable para cada plataforma —por ejemplo, la ficha o pista interna de Play, una página de descarga de APK firmada o el instalador de escritorio— y configurar ese destino para la versión publicada. Sin ese enlace de distribución, el aviso puede impedir llamadas antiguas sin llevar al usuario a un binario instalable.

## Validación y puesta en marcha

- Compilación Angular de producción correcta. Persisten advertencias de tamaño: bundle inicial de aproximadamente 2,71 MB y estilos existentes de chat-detail por encima de su presupuesto. No se ampliaron presupuestos para ocultarlas.
- 79 pruebas Chrome Headless aprobadas: llamadas, E2EE de medios, historias, juegos, identidad, recuperación, almacenamiento y audio.
- 62 comprobaciones C# offline aprobadas: propiedad, concurrencia lógica de autorización QR, caducidad, transferencia, señales obsoletas, migraciones, ID privado y recuperación.
- Validación PostgreSQL real: migraciones aplicadas y ocho transacciones concurrentes verificaron la exclusión mutua del bloqueo de llamadas.
- Compilación Java Android correcta; la validación física queda pendiente de instalar el APK. La ruta de pantalla nativa requiere pruebas reales de consentimiento, detener/reanudar, rotación, bloqueo, revocación y restauración de cámara antes de considerarla lista para producción.

La migración aditiva `20260913180837_CallSessionOwnership` debe probarse en una base de ensayo y desplegarse junto con el backend y el cliente nuevos. Los clientes móviles/escritorio antiguos no conocen los nuevos contratos de propiedad; requieren actualización coordinada. QR sigue almacenando desafíos en memoria del proceso: varias réplicas necesitan afinidad de sesión o almacenamiento compartido. No se modificaron credenciales ni infraestructura.

Antes de publicar: usar dos cuentas, dos dispositivos y dos pestañas del mismo navegador; probar voz/video directa y grupal, respuestas simultáneas, llamada saliente, reconexión SignalR, recarga y “Continuar aquí”, timeout concurrente, creación grupal simultánea, abandonar y volver, pérdida de red al colgar, denegar permisos, navegación interna, bloqueo de pantalla y cambio Wi-Fi/datos. Verificar QR con doble escaneo, caducidad y cancelación; temas claro/oscuro del teléfono; historias que se crean, caducan o se borran durante la navegación.

Los fallos de red que impidan avisar de una salida pueden dejar propiedad registrada en el servidor; la recuperación es explícita mediante “Continuar aquí”. No se añadió caducidad automática de propietarios, porque podría expulsar llamadas válidas cuyo JavaScript esté suspendido en segundo plano. Una limpieza futura debe contrastar presencia real del transporte, no solo temporizadores del navegador.
