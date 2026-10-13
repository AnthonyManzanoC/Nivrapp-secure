# Nivra 4.0.0

Corrige la saturación de conexiones PostgreSQL identificada en producción y endurece la publicación, lectura y revocación de historias. Android versionCode 26; protocolo de llamadas 2.

## Historias y funcionamiento

- Pool Supabase de sesiones limitado por defecto a 3 conexiones por proceso; los valores explícitos se respetan. Errores transitorios se comunican como 503 con reintento, conservando la validación de dispositivos.
- Subidas cifradas acotadas y compatibles con S3 de Supabase, con longitud y SHA-256 reales, firma SigV4 y limpieza del archivo temporal. El cliente puede retomar una subida interrumpida una sola vez usando la misma reserva y los mismos bytes.
- Publicaciones persistidas conservan respuesta 201 aunque Redis o push fallen después del commit. Los POST con resultado incierto no se repiten automáticamente.
- Feed filtra permisos antes de limitar resultados y resuelve autores, relaciones y estadísticas por lotes.
- Archivos de historias deben estar subidos, vigentes, pertenecer al creador y estar fuera de bóvedas. Descargas respetan eliminación, caducidad, consumo de una vista y pertenencia actual al grupo. Republicaciones no convierten una vista en contenido reutilizable ni prolongan su duración original.
- Recuperación de perfiles limitada a tres solicitudes simultáneas, con espera tras fallos transitorios y cancelación de solicitudes pendientes al cambiar de cuenta.

## Experiencia

Editor con encuadre adaptable, progreso, error junto a la acción y reintento que conserva el borrador. Visor con pausa coherente, buffering, lectura de textos largos y protección contra autoplay tardío. Estadísticas del creador distinguen carga de ausencia de actividad.

Estilos compartidos más consistentes en cuenta, chats, navegación y formularios; estados reales de guardado, contraste y foco. La insignia de cámara queda visible sobre el avatar. La navegación muestra el contador de chats sin leer. El puente NivraNative se registra una sola vez.

## Validación y límites

La suite Angular, los checks de historias/S3 y los de infraestructura, llamadas, historial, push y seguridad nativa se ejecutan para esta versión. El fixture S3 utiliza el SDK real contra un proveedor HTTP de prueba y no usa credenciales ni datos de producción. El visor y el editor se revisan visualmente con datos ficticios; la prueba de publicación entre cuentas reales queda ligada al despliegue de Render.

Auditorías npm de producción y NuGet sin vulnerabilidades conocidas en la revisión; el middleware de desarrollo se actualiza a 7.4.6. Quedan 14 hallazgos en dependencias de desarrollo cuya remediación requiere cambios incompatibles o aún no tiene parche. La compilación conserva la advertencia existente del tamaño del bundle inicial; no se elevan presupuestos.

APK y Windows contienen los mismos recursos web y hashes publicados. El APK conserva el certificado anterior. Windows se distribuye como ZIP completo con `Nivra.exe` y sus recursos; extraerlo entero antes de ejecutar.

Para activar la corrección en producción, realizar el [despliegue de Render y configuración de capacidad](render-database-capacity-4.0.0.md) en cada API. El respaldo comparte la misma base y su capacidad debe dimensionarse conjuntamente.
