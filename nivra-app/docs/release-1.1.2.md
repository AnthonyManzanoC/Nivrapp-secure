# Nivra 1.1.2 — vídeo, audio de pantalla, juegos e historial

Fecha: 2026-09-14. Android versionCode 8; protocolo de llamadas 2, compatible con 1.1.1. Esta entrega no requiere una migración de base de datos nueva.

## Cambios

- Directas: las solicitudes de renegociación que llegan durante una oferta pendiente se conservan hasta volver a `stable`. Al sustituir una pista se recupera la dirección `sendrecv` si era de solo recepción. Las pistas remotas se publican dentro de NgZone con una nueva referencia MediaStream para actualizar el elemento de vídeo ya montado.
- Audio receptor: un elemento de audio persistente por pista, deduplicado. Micrófono y audio de pantalla se reproducen simultáneamente; detener pantalla no elimina el micrófono. Los elementos de vídeo permanecen silenciados para no duplicar audio.
- Pantalla Android: AudioPlaybackCapture de Android 10+ usa el permiso MediaProjection ya concedido y envía PCM al puente WebRTC nativo existente. No abre otro micrófono ni otra sala remota. Excluye el UID de Nivra para evitar volver a transmitir el audio de la llamada. La pista se publica también como ScreenShareAudio en LiveKit. Liberación del capturador de audio al detener la proyección/llamada.
- Pantalla PC: aviso para marcar Compartir audio y aviso si la fuente no entrega ninguna pista. La disponibilidad depende del navegador, la fuente elegida y el sistema operativo.
- Juegos: el creador puede finalizar una partida, incluso un lobby vacío, y elegir otra. Salir como espectador no cancela la partida del grupo. X cierra y desmonta el panel; el transporte de datos de la llamada se conserva para poder abrir otro juego sin renegociar o desconectar los medios. Cabecera fija al desplazar, botón de 44 px y separación de controles móviles.
- Historial: se reutiliza la conexión SQLite y se comprueba el secreto protegido existente, sin borrarlo y registrarlo repetidamente. No se intenta convertir la base por un error genérico. Una apertura fallida se conserva como el mismo episodio; las lecturas de fondo no crean repetidamente el aviso después de una carga remota correcta. Reintentar/actualizar libera el intento fallido y vuelve a abrir, mostrando de nuevo el error si realmente continúa. Nunca elimina ni sustituye datos o claves para esconder un fallo.

## Validación y límites

94 pruebas Angular Chrome Headless aprobadas. Incluyen recepción de vídeo, dirección de transceptor, renegociación pendiente, pistas de audio independientes, cancelación autorizada de juegos y recuperación local tras navegación. Compilaciones de producción Angular y .NET aprobadas. APK de pruebas 1.1.2 (código 8) generado y firma APK v2 verificada; paquete Windows x64 con EXE 1.1.2 generado. Persisten las advertencias previas de tamaño del bundle inicial (2,71 MB) y estilos de chat-detail. No equivalen a una prueba acústica ni a una llamada entre teléfonos reales.

En teléfonos: comprobar voz → cámara desde ambos extremos, dos cámaras activadas a la vez, compartir/detener pantalla conservando micrófono, música de una aplicación que permita captura, aplicación que la deniegue, revocar proyección, rotación, bloqueo y salida/cambio de juegos. Actualizar ambos extremos permite validar todas las correcciones del receptor.

Android impone la política más restrictiva de captura de la aplicación fuente: DRM, llamadas y aplicaciones que la prohíban no pueden capturarse con este mecanismo. No se promete audio interno universal ni captura iOS; iOS sigue requiriendo ReplayKit/Broadcast Extension y macOS/Xcode. [Documentación Android](https://developer.android.com/media/platform/av-capture).

## Criptografía: costes y trabajo pendiente

No se han activado PQXDH, Double Ratchet, MLS, Sealed Sender ni una nueva política obligatoria TURN con esta corrección. La migración concreta está en [el plan de modernización](cryptography-modernization-roadmap.md). Ninguna prueba de esta entrega demuestra equivalencia con Signal o ausencia de rastros.

`libsignal` tiene licencia AGPL-3.0. No es correcto afirmar que prohíba todo uso comercial: ese uso debe cumplir sus obligaciones. Tampoco hay que asumir que Signal ofrezca una licencia comercial alternativa. El proyecto declara que el uso fuera de Signal no tiene soporte; sus puentes publicados Java/Swift/Node no son un paquete WASM oficial listo para Angular. [Repositorio y licencia](https://github.com/signalapp/libsignal).

OpenMLS usa MIT y permite integrar MLS sin una tarifa de licencia; Android, iOS y WASM se compilan en su CI pero no figuran entre los destinos probados allí. La integración de estado persistente, épocas, dispositivos, recuperación e historial requiere validación propia. [OpenMLS](https://github.com/openmls/openmls).

El software abierto no elimina el coste de ingeniería, auditorías independientes, mantenimiento, almacenamiento y ancho de banda TURN. Sealed Sender necesita un diseño de autenticación y control de abuso compatible: ocultar un campo JSON no oculta al remitente si HTTP/SignalR sigue autenticándolo. La recuperación poscompromiso necesita nuevos secretos generados fuera del control del atacante; no protege automáticamente mientras este conserve acceso al dispositivo.
