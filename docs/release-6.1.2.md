# Nivra 6.1.2

Cliente 6.1.2, Android build 39, protocolo de llamadas 2. Corrige la recuperación de Chats al volver la conexión, el contorno blanco del visor de historias y la presencia del editor de notas mientras la Bóveda está bloqueada.

## Recuperación de conexión

Una señal de conexión o el regreso al primer plano programa una reconciliación HTTP tras 400 ms. Si una actualización anterior sigue terminando, la nueva reconciliación espera y vuelve a consultar el índice y los mensajes; la señal ya no se consume simplemente esperando el intento fallido. El sondeo existente también comprueba errores pendientes cuando no llega un evento de conexión, aunque SignalR parezca conectado.

Los fallos transitorios de transporte y las respuestas temporales admitidas utilizan reintentos espaciados con variación, desde 2,5 segundos hasta un máximo de 30 segundos. Sólo se programa una recuperación por cuenta, dispositivo y generación de sesión. El éxito cancela el aviso y el reintento; quedar sin conexión o en segundo plano pausa la cola. Las señales repetidas se agrupan y el sondeo no inicia otra lectura mientras la cola está ocupada.

Se conservan conversaciones, mensajes almacenados, llaves y sesiones. Esta cola realiza lecturas: no recarga la página ni vuelve a enviar mensajes. Los errores de credenciales, permisos o formato no activan su bucle de reintentos transitorios. Las respuestas tardías de una sesión anterior no actualizan el índice, cursor o error de otra sesión, incluido el regreso A → B → A.

El navegador puede indicar conexión antes de que el servidor sea accesible. Nivra sólo da por recuperada la actualización tras completar las lecturas reales; sin acceso a Internet mantiene disponible lo que ya esté guardado.

## Visor de historias

El modal real `nivra-story-viewer-modal` estaba recibiendo el borde y el fondo de los paneles normales, especialmente en el tema claro. Ahora queda excluido de esas reglas. El modal y su contenido utilizan el área disponible de la aplicación, con borde y relleno exteriores a cero, en lugar de imponer una altura independiente del contenedor.

En móvil, el visor ocupa esa área completa; sus controles respetan las áreas seguras superior y laterales. Las fotos y los vídeos mantienen sus proporciones. La presentación en tarjeta de escritorio queda limitada por su contenedor, también con una ventana baja o en horizontal. No se solicita pantalla completa ni se oculta la barra de estado del teléfono.

## Bóveda y desplazamiento

La tarjeta completa Nueva nota, incluidos los campos y el selector de archivos, sólo se crea en el DOM después de desbloquear la Bóveda. Un PIN incorrecto o un desbloqueo aún pendiente mantiene el editor oculto. Al volver a bloquear la misma cuenta, el borrador se conserva oculto; cambiar de cuenta o destruir la vista limpia el borrador local. Los resultados tardíos del selector de archivos se rechazan si la vista se bloqueó, cambió de sesión o dejó de existir. Las salas privadas conservan su propio flujo de acceso.

Las superficies principales de Mundo, Bóveda, Llamadas y Cuenta, incluido Perfil, ocultan la barra de desplazamiento. Se mantienen el desplazamiento por dedo, rueda y teclado y las reglas de overflow existentes; el estilo queda limitado a esas vistas.

## Entrega y validación

No se añaden dependencias ni migraciones. Los cambios del cliente son compatibles con la API 6.1.0 activa y no necesitan un nuevo despliegue de Render.

- **1.250 pruebas del cliente aprobadas**, incluidas **30 nuevas**: 19 de recuperación y aislamiento de red, 6 del editor de Bóveda y 5 de geometría y modal de historias.
- **46 pruebas focales aprobadas en una ventana móvil de Chrome**, incluidas las de tamaño vertical y horizontal, áreas seguras y la superficie real del modal Ionic en tema claro. Están incluidas en el total anterior.
- El retorno de conexión durante una petición fallida, las señales repetidas, las pausas offline/segundo plano, la recuperación sin evento online y las respuestas tardías A → B → A se comprueban con transporte y reloj controlados.
- **75 comprobaciones Node** y **20 del feed de actualización** aprobadas; comprobación de tipos TypeScript sin errores.
- **58 pruebas JVM Android aprobadas**. APK build 39 compilado y firmado con el certificado fijado de las versiones anteriores; manifiesto compilado comprobado. La API compila en Release con cero advertencias y errores. La compilación web de producción conserva las advertencias previas de tamaño y de la cadena opcional del aviso de historial.
- Paquetes APK, instalador EXE y ZIP verificados: coinciden los 1.436 archivos web de escritorio y ZIP y los 1.435 del APK (Android omite la asociación web `.well-known/assetlinks.json`). Versiones, certificado, hashes y feed de actualización comprobados antes de publicar.

Las simulaciones de pérdida de conexión y de geometría no equivalen a una prueba en carretera, con todas las operadoras o en todos los modelos de teléfono. No se inició otra sesión de emulador ni se utilizaron cuentas del usuario en estas pruebas.
