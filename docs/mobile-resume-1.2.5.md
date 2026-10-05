# Nivra 1.2.5: regreso fluido a la app

Android `versionCode` 14. Al iniciar una sesión existente, Nivra restaura la última pestaña de esa cuenta. Una autenticación nueva sigue entrando por Chats. El inicio nativo consulta su estado activo, vuelve a validar la sesión cifrada, reintenta el almacén local y sincroniza conversaciones al regresar.

Chats muestra un estado de recuperación durante la sincronización y ya no presenta el mensaje de primera conversación cuando aún no pudo leer el índice cifrado. Si la sincronización del servidor recupera el índice, se descarta el aviso residual de una falla temporal del caché local.

Android puede terminar el proceso de la interfaz cuando se quita la app de recientes o el fabricante aplica sus límites de batería. Nivra restaura la sesión y la pantalla al volver; una interfaz Angular no puede conservar viva la misma instancia de WebView tras su terminación. Las notificaciones en segundo plano dependen de FCM y de los permisos y políticas de batería del dispositivo, en particular el inicio automático y ejecución en segundo plano de HONOR.
