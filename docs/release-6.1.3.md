# Nivra 6.1.3

Cliente y API 6.1.3, Android build 40, protocolo de llamadas 2. Conserva las mejoras de las versiones anteriores y corrige las carreras de llamadas con dos cuentas guardadas en el mismo teléfono.

## Llamadas y notificaciones de dos cuentas

«Contestar» y «Rechazar» conservan la cuenta, el dispositivo, la llamada y la acción originales. La aplicación adopta esa sesión, comprueba sus credenciales y termina la sincronización del registro nativo antes de ejecutar la acción. Un aviso recibido no cambia la cuenta por sí solo. Una pista de llamada de la cuenta del emisor, abierta en otro equipo, ya no impide contestar desde la cuenta destinataria del teléfono. Una llamada local en curso sigue protegida frente a un cambio involuntario de cuenta.

Las acciones nuevas utilizan una sola intención nativa persistente. El consumo usa el identificador de la intención para no borrar un toque más reciente; las entregas duplicadas se agrupan por cuenta, dispositivo, llamada y acción. Una adopción de sesión temporalmente fallida permite volver a intentar la misma intención. Los avisos de una cuenta inactiva ofrecen Contestar y Rechazar sin abrir una pantalla completa ni mostrar datos privados. Los reflejos de una llamada saliente se excluyen tanto en Android como en el cliente.

Los PendingIntent de llamadas llevan una capacidad aleatoria vinculada a su acción y a la membresía de la cuenta. Se valida en almacenamiento nativo privado antes de entregar la acción a JavaScript. Rotar credenciales conserva la capacidad de una llamada que está sonando; quitar y volver a añadir la cuenta cambia esa membresía.

El transporte elimina su error anterior al comprobar una conexión real. Conserva los errores independientes de permisos o cámara. Los temporizadores comprueban WebRTC antes de fallar o reiniciar, no castigan una captura o aceptación todavía pendiente y las respuestas tardías no cambian otra cuenta, llamada o peer. Los eventos Accepted repetidos y la carga simultánea de configuración ICE se agrupan. Una llamada fallida se presenta como «Sin conexión», aunque el estado persistido anterior fuera Active.

## Envío persistente en la API

Crear la llamada guarda también sus avisos pendientes en la misma transacción PostgreSQL. El endpoint devuelve la llamada sin esperar a FCM o Web Push. Un trabajador usa ámbitos de servicios nuevos, selección indexada, arrendamientos atómicos y concurrencia limitada. Los fallos del proveedor se reintentan con espera creciente dentro del plazo original de 75 segundos; los tokens se entregan en lotes y con tiempo límite. Un reinicio del proceso permite recuperar un arrendamiento vencido.

Antes de enviar se descartan llamadas finalizadas, invitaciones vencidas, destinatarios que salieron y cuentas que ya contestaron en otro dispositivo. Aceptar confirma el aviso dentro de la transacción: abandonar después una sala grupal no reactiva su invitación original. Los reintentos pueden entregar nuevamente el mismo aviso: la identidad de llamada y los mecanismos del cliente agrupan esas entregas. El vencimiento y el TTL de proveedor no se extienden en cada intento.

El servidor también cierra llamadas directas que quedaron en Ringing sin respuesta tras ese plazo. Vuelve a comprobar el estado bajo el bloqueo de coordinación de llamada para respetar una aceptación concurrente. Las salas grupales con un único participante no se cierran por esta regla. La migración añade `call_push_outbox` y un índice para buscar Ringing; conserva mensajes, historias y sesiones existentes.

`/health/ready` informa `webrtcRelayConfigured` sin exponer credenciales. Ese booleano confirma configuración de TURN; no es una prueba de acceso al relay desde cada operadora. Las redes que requieren relay necesitan un servicio TURN accesible y credenciales válidas.

## Traducción de llamadas

El botón de traducción permite elegir subtítulos, voz traducida o ambos; idiomas de origen y destino; y una persona en una llamada con varios participantes. Recuerda modo e idiomas por cuenta. Siempre requiere activación explícita en cada llamada. La voz traducida se reproduce para quien la activa, junto al audio original; no sustituye la voz enviada al interlocutor. Se recomiendan auriculares para evitar eco y la traducción puede tener retraso o errores.

El audio recibido se procesa en el dispositivo. No se abre otro micrófono ni se utiliza reconocimiento o traducción en la nube como alternativa silenciosa. La aplicación no almacena audio ni transcripciones. Los subtítulos expiran y desaparecen inmediatamente al cambiar cuenta, llamada o pista, incluso antes de ejecutar los efectos de limpieza. La cancelación durante una descarga invalida los resultados pendientes. La cola de audio y texto está limitada; una sobrecarga detiene la traducción y deja continuar la llamada.

- **Android:** requiere Android 13 o posterior, un motor de reconocimiento *en el dispositivo* compatible con entrada de audio y el idioma de voz instalado. La solicitud se comprueba antes de iniciar. Los motores que no pueden confirmar soporte se rechazan. Android documenta que los extras de audio dependen del proveedor: no se promete disponibilidad en todos los teléfonos. ML Kit traduce localmente; descarga los modelos necesarios por Wi-Fi tras activar la función. Los modelos instalados funcionan sin esa descarga. La voz requiere una voz del sistema instalada que no necesite conexión. Al salir de la app se detiene sólo la traducción.
- **Web y Windows:** requiere que el navegador o runtime exponga reconocimiento local de pistas de audio y la API local Translator para esos idiomas. Las APIs disponibles varían por navegador y Electron. No se activa el reconocedor heredado que puede enviar audio a la nube. Si falta un motor, modelo o voz, la interfaz explica la limitación. No se incluye un catálogo de voces ni se garantiza disponibilidad en cada instalación de escritorio.

Referencias técnicas: [audio de entrada y sesiones segmentadas de Android](https://developer.android.com/reference/android/speech/RecognizerIntent), [reconocimiento local de Android](https://developer.android.com/reference/android/speech/SpeechRecognizer), [traducción local ML Kit](https://developers.google.com/ml-kit/language/translation/android), [Translator en navegadores compatibles](https://developer.chrome.com/docs/ai/translator-api) y [reconocimiento de una pista de audio](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start).

## Ajustes de cuenta

Cuenta presenta el contexto del perfil y accesos directos a Perfil, Apariencia, Chats, Modo Seguro, Privacidad y Dispositivos. Los accesos abren y enfocan su sección sin recargar la página ni guardar el formulario. El aviso de cambios pendientes permite volver al borrador desde la cabecera. La navegación se adapta al espacio disponible, mantiene controles táctiles amplios y respeta la preferencia de movimiento reducido.

«Mostrar botón Traducir» también se aplica a las llamadas. Desactivarlo oculta el control y detiene la traducción local en curso.

Guardar Equilibrado o Abierto envía explícitamente la desactivación de la expiración previa. Las opciones de galería aclaran que controlan el destino al descargar un archivo. Diagnóstico presenta la copia manual disponible y elimina los interruptores que no tenían un envío implementado. No se ejecutan borrados, PIN de pánico ni vinculaciones reales durante las pruebas.

## Validación y despliegue

- 1.310 pruebas del cliente aprobadas, con comprobación TypeScript sin errores. 137 de ellas también ejecutadas en Chrome con ventana móvil; cubren el modal Ionic, sus tres modos y acceso al botón con contenido largo, además de carreras de llamadas y cuentas.
- 80 comprobaciones Node; 20 del feed; 68 pruebas JVM de Android aprobadas. El worklet se comprueba con PCM mono/estéreo, límites, saturación, orden de bytes y salida silenciosa.
- 121 comprobaciones de llamadas del servidor, 43 de push y 73 de infraestructura aprobadas. Incluyen propiedad por sesión, cola transaccional, arrendamientos, vencimiento, aceptación concurrente, tiempo límite de proveedor simulado y migración aditiva. Estas comprobaciones de política y traducción SQL no envían avisos a usuarios ni equivalen a una prueba de PostgreSQL productivo.
- Compilaciones y paquetes finales se verifican antes de publicar: marcador web, versiones de APK/EXE, certificado Android, coincidencia de archivos web y hashes SHA-256.

No se realizó una nueva llamada con cuentas del usuario ni una validación física del motor de traducción de su teléfono. Las pruebas automatizadas de carreras y proveedores no garantizan conexión en todas las redes ni disponibilidad de todos los motores de voz. La nueva cola de servidor requiere desplegar la API 6.1.3 en el servicio Render activo; publicar los instaladores por sí solo no aplica esa migración.
