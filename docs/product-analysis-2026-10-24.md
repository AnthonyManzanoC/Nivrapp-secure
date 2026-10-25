# Nivra: análisis del producto y mejoras 5.1.0

Revisión del código y pruebas locales del 24 de octubre de 2026. El usuario confirmó que la recuperación del historial de 5.0.1 ya funciona en su instalación. Las mejoras siguientes mantienen ese diseño y se entregan en el cliente 5.1.0, Android build 34.

## Lo que ya cubre la aplicación

| Área | Funcionalidad implementada |
| --- | --- |
| Acceso e identidad | Cuenta por alias, autenticación telefónica, vinculación QR, identidad por instalación, dispositivos de confianza, recuperación y revocación. |
| Mensajería | Chats directos y grupos, búsqueda y contactos, fijados/archivados/no leídos, escritura, reacciones, recibos y políticas de privacidad. |
| Historial | Lectura local, SQLite cifrado en Android e IndexedDB en web, recuperación autorizada de claves, migración del formato Android anterior y sincronización HTTP/SignalR. |
| Medios | Fotos, vídeos, documentos y notas de voz; cifrado en el cliente, vistas previas, caption y reintento de adjuntos. |
| Historias y Mundo | Historias privadas/públicas, audiencia, visualizaciones, comentarios, visor y composición de medios. |
| Bóveda | Elementos privados, medios y salas/invitaciones, con las políticas y claves previstas por esos recorridos. |
| Llamadas | Voz/vídeo directo, grupos mediante LiveKit cuando está configurado, pantalla, recuperación de conexión e integración de juegos durante llamadas. |
| Plataformas y avisos | Web, APK Android y aplicación Windows; FCM/Web Push, notificaciones nativas de llamadas y canal de actualizaciones con hashes y firma Android verificados. |

La base integra un conjunto amplio de funciones. El siguiente avance depende especialmente de la validación con accesorios y fabricantes reales, redes cambiantes, servicio de notificaciones disponible y continuidad del backend. La cantidad de código no acredita por sí sola calidad, seguridad ni disponibilidad.

## Cambios de esta entrega

**Historial inteligente.** El dispositivo habitual Android se recomienda como fuente cuando aparece entre los destinatarios reales del mensaje que falta. La recomendación filtra la cuenta, la confianza y la revocación; el directorio se consulta con caché y no bloquea una respuesta autorizada que ya haya llegado. La aprobación sigue exigiendo comparar el código y abrir las claves persistidas.

Ser un APK no demuestra que conserve todas las claves. Una reinstalación, un teléfono nuevo o una cuenta que empezó sólo en web necesitan poder recuperar desde el dispositivo que sí las tenga. Forzar siempre al teléfono como única matriz impediría esos casos. Tampoco se puede reconstruir una clave privada eliminada. La API actual no prueba la posesión remota de claves: el dispositivo recomendado es una candidata; la importación autorizada y el descifrado real comprueban el resultado.

**Historias.** Un gesto hacia arriba pliega el acordeón aunque haya cero o un chat y la lista no pueda desplazarse. Arrastrar desde el tope sigue desplegándolo. La franja también observa ese gesto y conserva el deslizamiento horizontal entre historias. La transición respeta la preferencia de reducir movimiento.

**Audio de llamadas.** La ruta se separa de silenciar el micrófono y silenciar la escucha. Android enumera auricular, altavoz y accesorios disponibles; conserva una selección manual conectada y elige una alternativa al desconectarla. Voz prefiere el auricular sin accesorios; vídeo prefiere altavoz. El selector solicita acceso Bluetooth cuando corresponde. El estado nativo usa revisiones para rechazar eventos atrasados y libera la ruta al colgar. En web y Windows se ofrecen las salidas permitidas por el navegador, sin inventar dispositivos que no expone.

**Adjuntos.** El componente muestra imagen/vídeo grande, miniaturas seleccionables, añadir/quitar archivos y comentario. Incluye giro, recorte cuadrado con arrastre/zoom y restauración del original. La edición limita el tamaño de los canvas y conserva el original si falla. Los archivos fallidos de un lote quedan disponibles para reintentar.

**Notas de voz.** Soltar mientras se solicita permiso cancela ese intento; conceder el permiso después no envía un audio. La captura se invalida al cambiar de chat, cuenta o pantalla. Un envío requiere duración útil mínima de 800 ms y datos de audio suficientes. Los tracks, foco de audio y estados se limpian al cancelar o terminar.

**Avisos.** El registro Android dispone de mantenimiento persistente con WorkManager para recuperarse después de agotar los reintentos cortos. Comprueba el token FCM y evita volver a registrar continuamente uno confirmado. El cierre de sesión cancela los trabajos y una respuesta antigua no revive la cuenta. En web, recibir una notificación no se interpreta como tocarla. La API permite entregar el comando de borrado a un dispositivo recién revocado exclusivamente cuando coinciden la cuenta y ese destinatario exacto; los eventos normales mantienen el filtro de dispositivos activos.

## Tamaño medido

| Fuente | Archivos | Líneas físicas |
| --- | ---: | ---: |
| Cliente Angular/Ionic | 271 | 75 944 |
| API .NET | 87 | 33 877 |
| Android nativo | 67 | 5 986 |
| Windows/Electron | 14 | 1 857 |
| Comprobaciones y herramientas restantes | 19 | 2 702 |
| **Total** | **458** | **120 366** |

Del total, **16 481 líneas corresponden a pruebas/comprobaciones**, y **103 885 a las demás fuentes y herramientas**. Hay **107 463 líneas no vacías**, incluyendo comentarios. Se cuentan fuentes actuales, plantillas, estilos y migraciones; se excluyen dependencias, salidas de compilación, binarios, imágenes, JSON, documentación y el SPA legado. El conteo es reproducible con `node tools/source-metrics.cjs`.

## Evidencia y límites de la revisión

Pasaron **872/872 pruebas Angular**, **52/52 pruebas JVM Android**, **61/61 pruebas Node**, **20/20 comprobaciones del canal de actualización** y **322 comprobaciones .NET** distribuidas en push, historias/subidas, metadatos de release, historial, llamadas e infraestructura. Una preparación de IndexedDB de la suite necesitó un plazo más amplio para el almacenamiento del equipo de compilación; las operaciones probadas mantienen su plazo normal.

APK, instalador y ZIP portátil se verificaron contra la misma distribución web: 1430 archivos en Windows, 1429 en Android y 1430 en el ZIP. La firma Android coincide con las versiones anteriores. El paquete inicial web es de 3,10 MB; reducir su carga inicial sigue siendo una mejora de rendimiento pendiente para redes móviles lentas.

La revisión visual utilizó los componentes reales de adjuntos y llamadas con datos ficticios y servicios aislados en 390 × 844 y escritorio. Se comprobó giro, recorte, restauración, añadir otra imagen, elegir una salida y conservar esa selección al silenciar la escucha. No se capturó audio/vídeo ni se hicieron llamadas a otras personas en ese entorno. Esas pantallas no demuestran una conexión Bluetooth física.

La migración del historial se conserva sin modificar su algoritmo en esta entrega. La comprobación física de Bluetooth/SCO, auricular/proximidad, reconexión de accesorios, permiso inicial y recepción de avisos con distintos fabricantes sigue siendo necesaria. El esquema de cifrado implementado tampoco sustituye una auditoría criptográfica externa ni acredita equivalencia con Signal.

WorkManager puede persistir tareas tras reinicios, pero sus intervalos son diferibles según red, batería y Doze. El mantenimiento de registro se programa cada 12 horas y no constituye el canal de entrega de cada mensaje: FCM sigue atendiendo los avisos. Ninguna aplicación puede prometer recepción permanente después de una detención forzada, sin red o con el backend/proveedor indisponible. Véanse [persistencia de trabajo en Android](https://developer.android.com/develop/background-work/background-tasks/persistent), [intervalos de WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work) y [límites de entrega FCM](https://firebase.blog/posts/2019/02/life-of-a-message).

La corrección del comando de revocación requiere desplegar la API 5.1.0 en el servicio activo. Las funciones del cliente conservan compatibilidad con API 5.0.0 y protocolo de llamadas 2. La disponibilidad de la infraestructura y su cuota sigue siendo parte de la experiencia real.
