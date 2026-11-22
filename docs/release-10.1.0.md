# Nivra 10.1.0

22 de noviembre de 2026. Android build 62.

- Las pantallas de voz y video tienen fondos más sobrios, controles con estados de interacción visibles y un indicador junto al estado de la conexión. Los controles principales quedan accesibles durante la reconexión y los ajustes de audio tienen su propio panel.
- La conexión directa intenta recuperar la sesión de medios cuando cambia la red. Si el intento falla, la pantalla ofrece reintentar.
- En Android, el servicio nativo reintenta renovar el registro de notificaciones después de fallos recuperables. El aviso puede aparecer aunque la pantalla principal esté cerrada.
- En Windows, cerrar la ventana envía Nivra al área de notificación. Abrirla desde ese icono recupera la misma ventana.
- Al volver a la aplicación, la sincronización se reanuda sin repetir la bienvenida. La web avisa de una versión disponible y deja que el usuario decida cuándo recargar.
- El cliente utiliza primero la API disponible. En el servidor, un fallo al avisar a un participante después de guardar la llamada permite seguir notificando a los demás.

La validación incluye 1.807 pruebas de Angular y 119 capturas de flujos en móvil y escritorio, además de las pruebas del servidor y Android. En Android 16 se verificó la actualización del APK 10.0.0 al 10.1.0. En la prueba del servicio nativo se inyectó un aviso de llamada con la pantalla principal cerrada y un registro local de cuatro días. El ejecutable final de Windows conservó la misma ventana al cerrar y reabrir desde la bandeja. Queda por comprobar la entrega real de Firebase después de varios días en teléfonos físicos.

Los instaladores están preparados para el cliente de distribución. El despliegue de las API se realiza por separado.
