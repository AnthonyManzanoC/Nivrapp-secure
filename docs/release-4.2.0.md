# Nivra 4.2.0

Esta versión armoniza Modo Seguro con el diseño de la aplicación, presenta con más claridad la preparación diaria de las conversaciones y renueva el icono de Android. Conserva los accesos, las conversaciones y el canal de actualizaciones de Android y Windows.

## Preparación diaria

La presentación inicial ahora funciona en web, Android y Windows, con una composición de marca y una animación indeterminada que respeta la reducción de movimiento. Se muestra como máximo una vez por día del calendario local y por cuenta, al entrar o volver al primer plano. El cambio de fecha durante el uso normal no interrumpe la aplicación.

Cuando la preparación de chats termina rápidamente, la presentación permanece 1100 ms para poder leerla. Si todavía está en curso, espera su estado real, con un límite de 2200 ms para que una conexión lenta o sin servicio no bloquee el acceso. Los trabajos de carga y sincronización continúan en paralelo; la presentación no los retrasa ni anuncia que han terminado. No muestra porcentajes inventados.

Login, recuperación, invitaciones, llamadas y otras tareas activas quedan fuera de la presentación. Si la cuenta cambia o aparece una condición incompatible, se retira de inmediato, incluso antes del tiempo mínimo. El registro diario se guarda antes de mostrarla para evitar repeticiones al recargar. Si el almacenamiento está bloqueado o lleno, se usa un registro en memoria durante esa ejecución; sin almacenamiento persistente no se puede conservar ese registro entre reinicios.

La comprobación de versiones de la web sigue siendo independiente y no añade esta espera a su petición de red. Los actualizadores de Android y Windows mantienen su canal y sus verificaciones existentes.

## Modo Seguro y Android

Modo Seguro recibe una presentación coherente con las superficies, la tipografía y los estados de la aplicación, con estados de verificación y espera visibles, teclado físico y etiquetas accesibles. Los textos nuevos están completos en los diez idiomas de la aplicación. Cuando Modo Seguro está activado, ocultar la pestaña o minimizar solicita el bloqueo. Toda la aplicación, incluidos los diálogos Ionic, queda oculta e inerte mientras el diálogo de desbloqueo permanece accesible por separado.

El PIN incorpora una espera progresiva local: después de cinco errores comienza una pausa de 30 segundos que puede crecer hasta cinco minutos con más intentos fallidos. El contador se conserva por cuenta y no se elimina al cerrar y abrir la pantalla. También se evitan verificaciones concurrentes, se descartan resultados de PIN o biometría que correspondan a una cuenta o ciclo de bloqueo anterior y se borra el PIN introducido después de cada intento y desbloqueo. Esta limitación protege el flujo local; no sustituye un bloqueo del servidor ni convierte el almacenamiento del dispositivo en resistente a manipulaciones.

El icono exterior de Android conserva el escudo y el rayo de Nivra, con verde profundo y menta suave. Usa capas vectoriales separadas en los iconos adaptativos desde Android 8, un símbolo monocromo para los iconos temáticos desde Android 13 y PNG en las cinco densidades para lanzadores anteriores. El sistema aplica su propia máscara y, en los iconos temáticos, sus colores. La geometría queda dentro de la zona segura; el generador reproduce todos los recursos a partir de un SVG común. La portada web y el splash permanecen independientes de este cambio.

Cuenta incorpora tres variantes incluidas: original, esmeralda y marfil. La elección se aplica localmente, sin cargar archivos ni descargar iconos de terceros. En Windows se conserva para el usuario del sistema y se restaura al iniciar después de actualizar. Cambia la ventana y los accesos directos existentes de Nivra en Escritorio e Inicio cuyo destino sigue siendo el ejecutable actual; no cambia el EXE, el instalador ni otros accesos. El puente IPC solo admite los tres identificadores y valida el frame de origen. Los ICO se copian de forma atómica desde el paquete a una ruta física del perfil para que Windows pueda leerlos fuera de `app.asar`.

En Android, la elección pertenece a la instalación y usa alias de lanzador estables. La actividad principal conserva sus enlaces y acciones de compartir y permanece habilitada. Desde Android 13 se cambia el conjunto de componentes de forma atómica; en versiones anteriores se habilita el nuevo antes de retirar el anterior, con reversión si falla el cambio. No se reinstala ni se fuerza un reinicio. El lanzador puede tardar unos segundos en actualizar su caché.

Los iconos anclados y la caché de Windows pueden tardar en reflejar la elección; a veces será necesario volver a anclar Nivra. No se manipulan esos accesos ni se modifica el icono incrustado en el archivo EXE. Véanse [los alcances de Windows](../Nivra.Desktop/README.md).

## Disponibilidad observada del backend

Durante la revisión, `https://nivrapp-secure.onrender.com` respondió a la comprobación de disponibilidad con HTTP 200, versión 4.0.0, protocolo 2 y `multiInstanceReady: true`. El origen que antes se consultaba primero devolvió HTTP 503 con `ServiceSuspended`. Se ajusta la prioridad para usar el origen disponible y se conserva la lista de orígenes verificados. Esta observación de disponibilidad no demuestra redundancia del clúster ni constituye una prueba completa de mensajes o llamadas entre dispositivos.

## Seguridad, rendimiento y validación

Se han aprobado 126 pruebas Angular, 39 comprobaciones de Desktop, seis del proxy de actualizaciones, 32 pruebas nativas Android, 138 comprobaciones de recursos del lanzador, 12 de la metadata de Android y 20 del contrato de publicación. Las comprobaciones de temporización cubren preparación rápida y lenta, límite de espera, llamadas y bloqueo, cierre y cambio de cuenta, entradas simultáneas, cambio de día local y almacenamiento no disponible. La presentación usa únicamente temporizadores acotados y el estado existente de preparación; no añade peticiones, sondeos periódicos ni trabajo criptográfico.

La compilación de producción y el verificador de paquetes pasaron: se cotejaron 1430 recursos web de Windows y del ZIP y 1429 del APK con la distribución final. El APK mantiene el paquete `com.nivra.app`, el certificado de actualización fijado y el versionCode 29; el protocolo de llamadas permanece en 2. El manifiesto de actualización se genera después de comprobar tamaños y hashes de los binarios.

El navegador ejecutó el bundle de producción con una cuenta ficticia, conexiones limitadas a la API local y un puente de iconos simulado. Se comprobó el rechazo de PIN incorrecto, la limpieza del PIN, el acceso con PIN correcto, la presentación visible de aproximadamente 1,1 segundos y su ausencia al volver a abrir el mismo día. También se comprobó el selector de iconos y su confirmación, y el diseño claro de escritorio y oscuro de móvil. Estas pruebas no equivalen a una instalación física. La instalación, actualización, biometría y revisión del icono en un teléfono físico, así como la instalación interactiva y los accesos del sistema Windows, siguen pendientes hasta su comprobación expresa.

El bundle inicial es de 3,04 MB, frente a 3,02 MB de 4.1.0, y conserva el aviso de presupuesto de 2 MB. No se aumentó el límite de error ni se añadieron dependencias. La medición local de preparación sirve para revisar la presentación; no es un resultado de rendimiento de un teléfono físico. Las comprobaciones de descargas y del manifiesto público se repiten después de publicar.

El instalador Windows conserva la distribución sin firma Authenticode; las garantías y limitaciones criptográficas de las conversaciones no cambian.
