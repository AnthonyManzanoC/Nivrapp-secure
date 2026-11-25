# Nivra 10.2.0

**24 de noviembre de 2026 · Android build 64**

- El visor privado ocupa toda la pantalla, respeta los recortes y restaura el estilo de la barra del sistema al cerrar.
- Android sigue funcionando si el sistema rechaza una consulta de permisos de notificaciones.
- Los grupos y las comunidades aplican los permisos de administración a los cambios de roles, las bajas y la eliminación de contenido. La interfaz confirma los cambios cuando el servidor los registra.
- Al agregar a un miembro, un administrador puede compartir con esa persona un resumen cifrado de hasta 10 textos propios de los últimos 7 días. La opción es voluntaria y requiere la API 10.2.0. Se excluyen los mensajes de una sola vez, temporales, eliminados y con adjuntos.
- El historial cifrado se reanuda al volver la conexión. La verificación de un dispositivo nuevo conserva la identidad del contacto cuando el certificado tiene una cadena de confianza válida.

La validación incluye autorización y concurrencia con PostgreSQL aislado, pruebas del cliente en Chromium, pruebas de Android en emulador y comprobación del instalador de Windows. El APK conserva el certificado instalado. El instalador de Windows se distribuye sin firma Authenticode. Los hashes SHA-256 de los instaladores se publican con la versión.

El dueño del proyecto despliega la API desde `main`. El despliegue automático de la web desde `main` está pausado en la configuración de Vercel. Los instaladores y la información de actualización nativa se sirven directamente desde GitHub Releases.
