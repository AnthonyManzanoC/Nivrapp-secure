# Nivra 3.0.0

Versión de perfil, interacción y consolidación de las funciones de chats, historias, llamadas y respaldo de API existentes. Android versionCode 24; protocolo de llamadas 2 compatible con la versión anterior.

## Cambios

- La cámara del perfil es un botón independiente de 44 px: no queda cortada por el borde circular. La foto abre el visor y la cámara abre la selección de imagen. Controles de teclado y distribución móvil ajustados.
- La selección y eliminación de la foto se bloquean durante carga/guardado para evitar modificar el borrador mientras se publica.
- Las confirmaciones de historias retienen la navegación por teclado. Escape cierra primero la confirmación; espacio sobre un botón conserva su activación normal.
- Se conservan el visor compartido de historias, reacciones, actividad, búsqueda de chats, salas, actualizaciones Android y respaldo de API de 2.1.1. No hay cambios de esquema ni de protocolo de llamadas.

## Pruebas

537 pruebas generales del cliente aprobadas, seguidas por 11 pruebas de perfil tras su último ajuste. API: 89 comprobaciones de llamadas, 28 de historial, 24 de push, 12 de actualización y 66 de infraestructura. Android: 18 pruebas específicas más la prueba de ejemplo; Windows: 7 comprobaciones de orígenes e IPC. Compilación de producción completada.

Estas pruebas cubren regresiones y estados sintéticos; no equivalen a una videollamada física en todos los dispositivos. No se realizó una nueva revisión visual interactiva completa ni una prueba de Android dormido. La compilación mantiene el aviso de bundle inicial de 3,01 MB frente a 2 MB; el CSS de cuenta supera su presupuesto por un byte. No se aumentaron los presupuestos para ocultar los avisos.

## Notificaciones en el segundo Render

El operador confirmó que configuró `Push__Fcm__ServiceAccountPath=/etc/secrets/firebase-key.json`, pero no creó el Secret File. Esto explica el FCM desactivado observado en la API; la variable sólo indica una ruta.

1. Obtener el JSON privado de cuenta de servicio del mismo proyecto desde Firebase, Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada. No usar `google-services.json` de Android.
2. En el segundo servicio Render, Environment → Secret Files, crear `firebase-key.json` con ese contenido. No compartir ni guardar ese archivo en Git.
3. Conservar `Push__Enabled=true`, `Push__Provider=Fcm`, el proyecto existente y la ruta indicada; guardar y redesplegar el último `main`.
4. Comprobar `pushFcmReady=true` en `/health/ready`. Después probar una llamada con la sesión activa y Android bloqueado: la configuración preparada no prueba por sí sola entrega real.

Referencias oficiales: [Firebase Admin](https://firebase.google.com/docs/admin/setup) y [Secret Files de Render](https://render.com/docs/configure-environment-variables).

Las credenciales compartidas en el chat no se incorporaron a código ni a paquetes. Deben reemplazarse en sus proveedores. La firma de sesiones y los valores incluidos en la huella del cluster requieren rotación coordinada de servidores y clientes.

## Distribución

Publicación: [3.0.0](https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/tag/v3.0.0). El ZIP de Windows contiene `Nivra.exe` y sus archivos necesarios; extraer el paquete completo antes de abrirlo. El APK conserva el certificado anterior. Los hashes se adjuntan a la publicación. Render utiliza Manual Deploy; desplegar el mismo commit en cada API disponible para actualizar su metadata de descarga Android.
