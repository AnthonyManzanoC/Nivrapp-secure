# Nivra 8.0.1 — continuidad visual de escritorio

Android build 51. Protocolo de llamadas 2. Conserva el cifrado publicado y sus formatos de historial.

- Barra de navegación y área de trabajo como tarjetas flotantes alineadas, con márgenes y curvas coherentes desde 769 px. El modo móvil conserva la barra inferior y las áreas seguras.
- La cabecera de chat oculta el grupo del botón Volver cuando la lista lateral está visible. Lo conserva en pantallas de hasta 768 px, también al bloquear una conversación.
- La vista de tres líneas omite el estado secundario si repite el texto de la vista previa. Conserva presencia real, escritura, reconexión y número de participantes. Los chats protegidos no muestran actividad.
- El menú junto a la videollamada incluye **Cerrar chat**. Regresa a la lista sin borrar conversaciones ni cancelar los mensajes guardados para enviar.
- Cola de textos cifrada por cuenta y dispositivo, usando el almacenamiento existente (IndexedDB y SQLCipher). El compositor se libera al confirmar el guardado local; permite seguir enviando mientras hay peticiones pendientes. Conserva IDs, orden y opciones de privacidad; no guarda textos en localStorage.
- Reintentos automáticos ante red/503/429/timeout con espera creciente, identidad estable e idempotencia del servidor. Al volver la conectividad o reabrir la app se reanudan inmediatamente los fallos temporales de red/renovación de sesión. La cola considera `Retry-After` con un máximo de cinco minutos. Los intentos gestionados por la cola tienen un plazo total de 30 segundos, incluyendo la apertura de identidad y preparación criptográfica. Si la preparación vence, no se inicia después una petición tardía. Un HTTP ya enviado puede ser aceptado aunque se pierda el acuse: el reintento conserva su ID para evitar duplicados.
- Reabrir la app restaura la cola del mismo dispositivo. El borrado/vaciado de un chat pausa sus envíos y espera al intento activo antes de limpiar pendientes. Un acuse por tiempo real retira la burbuja pendiente duplicada.
- La cola permite hasta 200 textos de 64.000 caracteres por cuenta/dispositivo. Respeta la expiración original sin extenderla al reintentar. Un error de guardado conserva el borrador; los errores de permisos/identidad requieren una acción explícita.
- Los reintentos se ejecutan con la aplicación en primer plano, desbloqueada y con conexión. Android puede suspender JavaScript al cerrar la app: la restauración ocurre al volver a abrirla; no se promete ejecución del envío con el proceso cerrado. La cola persistente cubre textos; los adjuntos conservan su flujo y permiten encolar nuevos textos durante una carga.
- Revisión con los componentes Shell/Chats, CSS real de ChatDetail y datos ficticios en escritorio claro/oscuro y móvil. Pasaron **1.494 pruebas Angular, 36 controles HTTP/API y 83 pruebas Node**. La ejecución final incluye permisos de reenvío, texto durante una carga de archivo y reanudación tras fallo temporal de sesión. El análisis de dependencias no detectó avisos altos/críticos; quedan avisos moderados en herramientas de desarrollo.

## Double Ratchet: avance de laboratorio

El piloto suma persistencia cifrada, confirmación atómica de sesión y bandeja, protección contra escritores obsoletos y recuperación comprobada en otro proceso. Sus 15 pruebas pasan con Node 24.18.1. No se importa ni se anuncia en los clientes publicados.

**No se activa el protocolo nuevo en esta release.** Siguen pendientes el puente común para navegador/Android/Windows, IndexedDB/SQLCipher, reserva de preclaves en PostgreSQL, capacidades autenticadas, fan-out multidispositivo e integración del historial. El adaptador SQLite del piloto no cumple esos requisitos por sí solo. La [documentación del piloto](../crypto/ratchet-pilot/README.md) detalla sus límites.

La distribución oficial de [libsignal](https://github.com/signalapp/libsignal) publica puentes Java, Swift y Node sobre Rust. El módulo Node del piloto no puede cargarse directamente en un navegador. La gestión [Sesame](https://signal.org/docs/specifications/sesame/) requiere sesiones por pares de dispositivos y tratamiento explícito de altas, bajas y restauración. Activarlo sin esas piezas dejaría destinatarios sin poder descifrar los mensajes.
