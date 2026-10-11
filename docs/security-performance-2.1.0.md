# Seguridad y rendimiento de Nivra 2.1.0

La validación separa pruebas automatizadas, comprobaciones públicas en producción y pruebas que requieren un teléfono o infraestructura de staging. Un resultado de compilación no demuestra que Android siempre reciba una llamada bajo todas las políticas de batería, ni que dos servidores sin Redis compartido puedan entregar eventos entre sí.

## Cambios comprobables

- La aplicación sólo envía credenciales a orígenes API incluidos en la versión. Los parámetros de navegación y configuración nativa no pueden añadir servidores arbitrarios. El interceptor compara el origen completo; un dominio que empiece por el nombre de la API no recibe credenciales ni puede ordenar un borrado del dispositivo.
- Windows bloquea la navegación externa en la ventana privilegiada y comprueba el documento local, ventana y frame principal antes de entregar secretos o cambiar la protección de pantalla mediante IPC. Los frames ajenos no obtienen permisos de cámara/micrófono del shell. La comprobación sigue las [recomendaciones oficiales de Electron](https://www.electronjs.org/docs/latest/tutorial/security/).
- Un respaldo exige salud pública reciente, configuración compartida con la misma huella, protocolo compatible y FCM/Web Push disponibles. Las comprobaciones no llevan tokens ni cookies y rechazan redirecciones. La respuesta de salud tiene un límite de 16 KB.
- Las recuperaciones simultáneas comparten una operación, con pausa entre intentos y como máximo tres candidatos por ronda. La aplicación permanece en un servidor sano. Los errores de autorización, compatibilidad y cuota por usuario no conceden otra API/cuota.
- Las lecturas pequeñas tienen un plazo aunque HttpClient haya emitido el evento inicial `Sent`. Los mensajes, cambios de perfil y renovaciones de sesión que pierdan su respuesta no se repiten automáticamente; el servidor elegido para solicitudes futuras puede cambiar. Los uploads y descargas grandes conservan su recorrido propio.
- Los reintentos y eventos SignalR se descartan después de un cambio de usuario/dispositivo. Android guarda la referencia compartida junto a su registro protegido y sólo renueva el destino push en un segundo origen después de comprobar su compatibilidad.
- Si un hub ya conectado pierde su API, comprueba el respaldo al empezar a reconectar. Al crear la conexión nueva, chats y bóveda vuelven a suscribirse y llamadas consulta las salas activas y el estado persistido; no espera a agotar todos los reintentos del servidor anterior.
- Los adjuntos normales pueden descargar bytes cifrados directamente de S3 con autorización previa y acceso temporal. No envían bearer, cookies ni referente al almacenamiento. El lector valida tamaño anunciado/real, cancela cuerpos inválidos y no repite una descarga con errores de integridad. El fallback autorizado conserva compatibilidad con servidores anteriores y CORS no configurado.
- Historias de una sola vista, mensajes eliminados al leer y archivos de bóveda conservan el proxy autorizado. Las claves de descifrado siguen en el cliente. Los límites y permisos no se sustituyen por una URL pública permanente.
- Historias no consumen una vista antes de descargar y descifrar su contenido. El visor usa el tiempo real del audio/vídeo, se pausa al escribir o abrir actividad, cancela operaciones antiguas y limita su caché. Perfil conserva borradores y no aplica respuestas de otra cuenta.
- La finalización del alias de teléfono toma un bloqueo PostgreSQL por cuenta y vuelve a comprobar el token y el estado antes de crear una sesión. Alias, dispositivo y sesión se confirman juntos; los competidores no emiten sesiones adicionales.

## Reproducir las pruebas

Desde `nivra-app`, ejecutar los tests Angular con Chrome Headless y los dos casos WebRTC de integración por separado. Desde la raíz, ejecutar los proyectos `checks/Nivra.CallChecks`, `Nivra.HistoryChecks`, `Nivra.PushChecks`, `Nivra.ReleaseChecks` y `Nivra.InfrastructureChecks`. Los tests usan datos sintéticos; no llaman ni escriben a contactos reales. Android incluye tests de origen, compatibilidad del cluster, registro push y actualización. Windows incluye `node --test Nivra.Desktop/api-origins.test.js Nivra.Desktop/renderer-security.test.js`.

`dotnet run --project checks/Nivra.DatabaseChecks -- --check` verifica conectividad, migraciones pendientes y tres escenarios de ocho transacciones PostgreSQL: llamadas, actividad JSON de historias y finalización de alias. Usa claves aleatorias y datos sintéticos en memoria bajo bloqueos reales. No crea usuarios, historias, mensajes ni llamadas. No usar `--migrate` como sustituto de esta comprobación.

`tools/check-api-cluster.ps1` consulta una vez la salud pública de cada API. Por defecto sólo devuelve éxito si todos los nodos tienen core readiness, protocolos compatibles, PostgreSQL/Redis listos, configuración S3 compartida, firma durable y la misma huella. Una API 2.1 sin el campo nuevo requiere un fallback estricto de `status=ok` y S3/Redis/firma explícitamente `true`; un `apiFailoverReady=false` presente nunca se ignora. Con `-ExpectedClusterFingerprint` el modo operacional exige al menos un nodo core-ready con protocolo compatible y pin exacto, y excluye los demás con advertencias sin confirmar salud del conjunto. La referencia debe estar previamente verificada o publicada en el cliente. Push pendiente genera advertencias y mantiene `multiInstanceReady=false`; el éxito del diagnóstico no confirma entrega de notificaciones. Un timeout no demuestra que FCM o S3 estén desactivados: requiere una nueva comprobación cuando termine el arranque frío.

## Límites de la validación

No se ejecuta una prueba de carga destructiva contra Render gratuito ni se provocan fallos en las cuentas reales. Para medir concurrencia, latencia p95 y consumo de red hace falta staging con Redis, S3 y usuarios sintéticos. El checker de infraestructura permite una prueba Redis local optativa; las pruebas lógicas de dos instancias no equivalen a un backplane Redis real.

La revisión visual automatizada en el navegador se detuvo porque Computer Use no pudo confirmar la URL de Windows. Las pruebas de componentes y compilación siguen disponibles; no se presenta ese intento como una revisión visual completa. La validación física de Doze en Android y de Safari/cámara en Mac continúa requiriendo los dispositivos correspondientes.

Las descargas directas evitan que el cuerpo cifrado atraviese Render cuando S3/CORS lo permiten. No se atribuye un porcentaje de ahorro medido en producción: el almacenamiento conserva su propio tráfico y sus cuotas. Un respaldo gratuito dormido puede tardar en despertar. La arquitectura admite más orígenes configurados y verificados; no promete capacidad infinita o ausencia de cortes.

## Referencia de confianza del cliente

Las instalaciones existentes aprenden la huella de la primaria autorizada y la guardan como referencia de compatibilidad. Una instalación nueva que nunca pudo consultar esa primaria no confía automáticamente en otra API. Después de desplegar y verificar ambos servicios, se puede compilar su huella pública en `environment.prod.ts` (`apiClusterFingerprint`) para permitir ese primer inicio con la primaria caída. La huella no es una contraseña; no sustituye la validación de TLS ni autoriza añadir hosts desconocidos.

El registro de APIs está compilado en web, APK y Windows. Añadir hosts a futuro exige una versión del cliente y las mismas comprobaciones compartidas. El cliente limita el número de comprobaciones simultáneas, mantiene el nodo sano elegido y evita repetir mensajes o cambios cuya respuesta pudo perderse.

Una renovación de sesión que se confirma en PostgreSQL pero pierde su respuesta conserva el refresh token antiguo en el cliente. Por seguridad no se repite ciegamente; ese caso puede requerir iniciar sesión otra vez. Recuperarlo de forma transparente exige un protocolo de renovación idempotente con respuesta protegida, que esta versión no incorpora.
