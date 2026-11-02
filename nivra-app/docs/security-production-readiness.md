# Nivra: seguridad y preparación operativa

Revisión: 2026-11-02. Base publicada: 8.1.0. Candidata de experiencia: 8.2.0.

## Mensajes e historial

Los mensajes nuevos de 8.1.0 usan Double Ratchet de vodozemac 0.11.1 y un establecimiento inicial híbrido propio con X25519 y ML-KEM-768. La suite es `NIVRA-PQXDH-MLKEM768-A256GCM-1`, protocolo 5. Los hashes de las fuentes, la distribución WASM y sus licencias se verifican antes de compilar los clientes. Se conservó la licencia de Nivra; vodozemac usa Apache-2.0 y las dependencias poscuánticas elegidas usan MIT/Apache.

La composición de Nivra está inspirada en PQXDH y requiere una auditoría independiente. No es una implementación oficial de Signal. La auditoría de una dependencia no certifica el protocolo completo de Nivra.

Las sesiones y operaciones pendientes se guardan de forma transaccional en almacenamiento cifrado. Los reintentos reutilizan los bytes del mismo mensaje. PostgreSQL reserva preclaves de forma atómica; el destinatario elimina las consumidas tras autenticar la recepción. Un fallo deja el envío pendiente y no habilita silenciosamente el cifrado antiguo para mensajes nuevos.

El historial anterior conserva sus lectores de compatibilidad. Su transferencia cifrada exige aprobación de un dispositivo autorizado, admite paginación y reanudación y no clona el estado privado del ratchet. No recupera mensajes eliminados, vencidos o de una sola visualización. El emisor conserva su copia en el historial local protegido; no se añade una copia estática a cada mensaje que anule el secreto hacia adelante.

Las notas propias de 8.2.0 usan la misma ruta: conversación única por cuenta con bloqueo transaccional y cápsulas de ratchet independientes para los dispositivos vinculados. No se añade a otra persona ni se permite llamarse o bloquearse a uno mismo.

Historias, ajustes y señalización de llamadas conservan sus formatos propios. Los adjuntos usan AES-GCM; sus claves viajan dentro del mensaje protegido. No se afirma que todas las superficies usen el ratchet de mensajes.

## Llamadas y notificaciones

| Superficie | Implementación | Límite operativo |
| --- | --- | --- |
| Llamadas directas | WebRTC DTLS-SRTP, señalización cifrada, negociación perfecta y recuperación ICE | Algunas redes requieren TURN. Una llamada directa puede revelar IP entre pares. |
| Grupos | LiveKit con E2EE por publicador y rotación ante cambios de miembros/sesión | Validar teléfonos reales y auditar la distribución de claves. |
| Conexión privada | ICE autenticado y acotado. Un `RelayOnly` incompleto devuelve 503; el cliente conserva su política anterior y permite reintentar | La aplicación no se degrada silenciosamente a conexión directa por un error de configuración. Esto no provisiona un relay. |
| Pantalla Android | Proyección nativa en primer plano con consentimiento del sistema. Android 14+ solicita pantalla completa. La reconexión conserva y vuelve a publicar la captura autorizada | El sistema y el usuario pueden terminar la captura. Un permiso revocado requiere nuevo consentimiento. |
| Llamada entrante | Pantalla nativa sobre bloqueo, diseños de voz/video, caducidad y acciones firmadas por dispositivo | Android controla permisos de notificación y pantalla completa; validar cada fabricante. |
| Push | FCM nativo independiente de la WebView, renovación de token, privacidad y alcance por cuenta/dispositivo | Una app forzada a detenerse, permisos denegados, falta de red o restricciones del sistema pueden impedir o retrasar la entrega. |

El usuario confirmó que no dispone de TURN y decidió dejar su activación para una etapa futura, conservando su código y configuración. La API primaria informaba `webrtcRelayConfigured: false` en la revisión de 8.1.0. Los reintentos no sustituyen ese servicio en redes restrictivas.

## Protecciones y metadatos

- Las preparaciones tardías de llamada, captura o recuperación se descartan si cambia la cuenta o la sesión.
- Las cuentas fantasma siguen requiriendo alias/ID exacto o pase compartido. Mover Contactos fuera de Mundo mantiene esa regla.
- Los juegos autentican al remitente como participante y validan anfitrión, revisión, turno, coordenadas y tablero.
- La verificación de identidad y los avisos de cambio existen. No hay transparencia externa de llaves desplegada.
- El correo de recuperación es un metadato del servicio. Los enlaces son de un solo uso, se guardan como hash, caducan y revocan sesiones cuando corresponde.
- El servicio y los proveedores conocen metadatos necesarios: destinos, tiempos aproximados, tamaños y tokens push. Las historias de Mundo son públicas para su audiencia.
- Las credenciales de infraestructura deben permanecer en el gestor de secretos del proveedor y fuera de repositorios e instaladores.

## Autenticación, historias y experiencia

Las rutas heredadas `/auth/phone/start` y `/auth/phone/verify` solo se mapean en Development. Una prueba HTTP real comprueba su ausencia fuera de desarrollo. Firebase sigue implementado; el acceso por teléfono permanece en pausa por decisión del propietario y no se elimina. El radar se oculta de la interfaz mientras esté en pausa.

Contactos reúne contactos, notas propias y solicitudes recibidas, enviadas e historial. Mundo conserva historias y grupos con búsqueda local. Los doce fondos de texto se transmiten como identificadores dentro del contenido protegido; el visor solo acepta una paleta interna de colores. No interpreta estilos o direcciones arbitrarias del mensaje. Los resultados de acción caducan y sus temporizadores no bloquean la inicialización de pantalla; las alertas de seguridad y estados activos conservan su ciclo propio.

Los ocho juegos validan movimientos y revisiones. Una invitación desaparece a los 6,5 segundos y permite un único recordatorio a los 45 segundos si la misma sala sigue disponible; un cierre explícito anula el recordatorio. No cambia permisos de micrófono ni cámara.

## Evidencia y pendientes

La base 8.1.0 pasó 1507 pruebas Angular y pruebas de Rust/WASM, PostgreSQL/HTTP, historial, dispositivos, Electron Windows/Linux y Android WebView/SQLCipher con reinicio de proceso. La candidata 8.2.0 incorpora regresiones de notas propias, juegos, pantalla y cambios de cuenta; revisión visual con datos ficticios y ensayos nativos en un paquete separado. Consultar el resultado del commit que se distribuya: no atribuir a un candidato resultados de otro commit.

Siguen pendientes de operación: desplegar TURN; probar teléfonos físicos con bloqueo, Doze, ahorro de batería, cambios de red/app y compartir pantalla; auditar externamente la composición híbrida y la distribución de claves; realizar pruebas externas de penetración; revisar dependencias, retención de metadatos y cuentas de infraestructura.

Una compilación, una prueba automatizada y una llamada entre teléfonos reales son evidencias diferentes. No presentar como garantía “indescifrable”, “cero metadatos”, “igual que Signal” o “100 % en cualquier teléfono y red”.
