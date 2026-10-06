# Nivra 1.2.7: apertura de Chats después de cerrar Android

Al retirar Nivra de Recientes, Android puede destruir la WebView. Una nueva apertura crea otra instancia de Angular, pero conserva la sesión protegida. No es posible prometer que el proceso se mantenga activo todo el tiempo; se recupera la pantalla y se sincroniza con el servidor cuando vuelve a abrir.

En 1.2.6, la pantalla esperaba hasta 30 lecturas individuales de mensajes y el almacén de perfiles antes de publicar un índice de chats ya disponible. Ahora publica el índice de la cuenta en cuanto se abre SQLCipher, limita las lecturas de vistas previas a lotes de tres y carga contactos y perfiles en paralelo con la sincronización. Los mensajes más recientes del servidor tienen prioridad sobre copias locales tardías.

Para los siguientes arranques se guarda una copia pequeña y cifrada de la lista y sus vistas previas. La clave se deriva del secreto de sesión protegido por el dispositivo, con un dominio propio y el ID de cuenta. La copia solo se usa en Android/desktop con vault seguro y se elimina al cerrar sesión. Si no puede descifrarse, se continúa con SQLCipher y el servidor sin borrar el historial. Los textos de mensajes temporales o de una sola vista se excluyen de esta copia.

Mientras se abre el almacenamiento, Chats muestra tarjetas discretas en el mismo espacio de la lista. En cuanto hay un índice válido, muestra los chats y actualiza las vistas previas y el estado en segundo plano. La primera apertura tras instalar esta versión todavía necesita crear la copia cifrada; su ventaja se nota al volver a abrir la aplicación.

Validación automatizada: compilación web y prueba del cifrado, separación por cuenta y borrado de la copia. Validación pendiente en un HONOR 90: iniciar sesión, dejar sincronizar, quitar de Recientes, volver a abrir con y sin red, comprobar si la lista aparece sin el estado de restauración y si mensajes llegados mientras estaba cerrada se incorporan al recuperar conexión. Las notificaciones nativas se mantienen mediante FCM; no se ha medido entrega física en reposo con este cambio.
