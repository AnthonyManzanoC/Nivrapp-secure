# Nivra 9.3.0

14 de noviembre de 2026. Android build 59.

La actualización renueva la presentación de la aplicación y corrige fallos de reconexión, avisos de mensajes, almacenamiento protegido en Windows y apertura de llamadas en Android.

## Experiencia de uso

- La navegación de escritorio muestra iconos y nombres de sección. Mantiene seleccionada la sección de origen al abrir contactos, comunidades y Compartir. En móvil conserva las cinco pestañas principales.
- Bienvenida, acceso, recuperación, chats, conversación, contactos, cuenta, historias, llamadas, comunidades, listas de difusión, invitaciones y Bóveda comparten superficies, espaciado y controles revisados para temas claro y oscuro.
- Los botones aplican el color de acento de la cuenta y un texto legible al cambiar de tema. El selector de idioma muestra el nombre nativo completo en teléfonos estrechos.
- Compartir permite editar el texto en un único campo, identifica al destinatario seleccionado y desactiva el envío al borrar todo el mensaje. El texto borrado deja de sustituirse por el original al enviar.

## Estabilidad

- La reconexión verifica la generación de sesión y conexión antes de reemplazar el transporte SignalR, para descartar operaciones que terminan después de salir o cambiar de cuenta.
- Un fallo de notificación en tiempo real después de guardar un mensaje permite seguir intentando avisar a los demás destinatarios y por push.
- Windows crea el protector de secretos mediante un temporal sincronizado y limpia también los temporales autorizados al borrar ese protector.
- Android abre la llamada en curso mediante una acción firmada vinculada a la cuenta, independiente del vencimiento de la invitación inicial.
- Los clientes prefieren la API operativa y excluyen el servidor suspendido. El servidor actualiza SignalR Redis y el runtime Docker a 9.0.23.

## Validación registrada

Antes de incrementar la versión, el código funcional pasó 1.664 pruebas Angular, una revisión visual con 89 capturas y tres pruebas instrumentadas Android. Se recorrieron bienvenida, acceso y recuperación en la web de producción local, Electron Windows y un emulador Android 16. Los resultados y las capturas están en `artifacts/design-launch-2026-11-14/`.

La revisión de estabilidad registró 615 aserciones de servidor, 105 pruebas Node y 72 pruebas JVM Android. Después del parche SignalR se repitieron 270 aserciones de infraestructura, llamadas, seguridad y autenticación. El detalle está en [la revisión de estabilidad](reliability-review-2026-11-14.md) y en `artifacts/reliability-2026-11-14/`.

La preparación 9.3.0 volvió a compilar API y web de producción. Los controles offline del feed y del diagnóstico de clúster se registran en `artifacts/release-9.3.0/`, junto a la verificación final de los instaladores y metadatos. Los directorios de artefactos son evidencia local ignorada por Git.

La compilación web mantiene advertencias de tamaño, con aproximadamente 2,72 MB iniciales y varios estilos por encima del umbral de aviso. Las llamadas y notificaciones en teléfonos físicos, la conectividad por TURN y la auditoría independiente conservan sus pruebas pendientes. Las últimas consultas anteriores al despliegue informaron TURN desactivado en las dos API operativas.

## Publicación

Pendiente de completar tras verificar la release, los despliegues y los bytes de las descargas públicas.
