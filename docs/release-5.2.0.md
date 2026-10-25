# Nivra 5.2.0

Cliente/API 5.2.0, Android build 35. Conserva el diseño y la recuperación Android de 5.1.0. No elimina conversaciones, bases ni identidades para resolver un estado pendiente.

## Historial web

La recuperación vuelve a intentar primero los mensajes protegidos conocidos con las claves locales, incluso después de reabrir la aplicación. Ya no espera un bootstrap o páginas ajenas antes de aprovechar una aprobación. Las ingestas normales y las copias locales que vuelven a ser legibles concilian sus pendientes; el aviso desaparece cuando no quedan mensajes protegidos conocidos sin leer. La aprobación parcial mantiene un aviso específico: importar algunas claves no prueba que se haya recuperado todo el historial. Los tiempos de las lecturas son acotados y se adaptan a la red, liberando los indicadores de carga después de fallar.

## Modo Seguro de cuenta

Al activar se crea y confirma un PIN común de cuatro dígitos, también en Android. La API conserva un verificador cifrado con PBKDF2-SHA256/AES-GCM ligado al ID estable de cuenta; no recibe el PIN en claro ni datos biométricos. Cada instalación conserva la última política recibida para desbloquear sin conexión. Los eventos en tiempo real, la vuelta al primer plano, la reconexión y una consulta periódica vuelven a comprobar la política. Los cambios incluyen revisión para que dos dispositivos no sobrescriban silenciosamente su configuración.

Android utiliza el diálogo del sistema con la biometría disponible e inscrita; el PIN de Nivra queda como alternativa. El sistema elige entre los métodos que expone a aplicaciones, que pueden incluir huella, rostro o iris. No se afirma que un sensor esté inscrito sólo porque existe. Una instalación antigua que tenía únicamente biometría local conserva el desbloqueo del dispositivo para poder actualizar su configuración y crear el PIN común.

En la web compatible se puede activar explícitamente un autenticador de plataforma después de comprobar el PIN común. WebAuthn exige verificación de usuario y comprueba firma, origen, RP, desafío, cuenta y credencial; no almacena biométricos ni claves privadas. Esa verificación puede usar Windows Hello, biometría o el código del sistema: el navegador no garantiza qué método se utilizó. La aplicación Electron actual usa `file://`, donde este flujo no está disponible, por lo que conserva el PIN común. No se cambió su origen de almacenamiento, evitando perder acceso al historial existente.

Antes de conocer la política de una instalación nueva se cubre el contenido privado. Una política desconocida con error de red muestra una comprobación recuperable; una política ya recibida continúa funcionando sin conexión. Un servidor anterior que no implementa esta función conserva el bloqueo local existente hasta su actualización.

Este bloqueo protege la interfaz de una sesión. No sustituye la autenticación de la cuenta, un bloqueo del sistema operativo ni el cifrado de la base. La limitación de intentos es local a cada instalación; el PIN de cuatro dígitos no es una contraseña de recuperación ni protege frente a un atacante que controla el equipo. Un dispositivo desconectado sólo puede aplicar cambios de cuenta cuando vuelva a recibirlos.

## Conexiones lentas

Las comprobaciones de disponibilidad no retienen cada petición durante múltiples sondas: dejan continuar hacia el origen previamente confiado tras una espera corta y mantienen la validación del clúster para cambiar de servidor. El tráfico correcto evita sondas repetidas. Las lecturas permiten 30 segundos de base, 60 en 3G, 90 en 2G y hasta 120 en enlaces muy lentos; también consideran latencia observada cuando el navegador no informa el tipo de red. Son límites, no velocidades garantizadas.

SignalR agrupa arranques y eventos de reconexión, espera progresivamente con variación aleatoria y cancela resultados de sesiones anteriores. Se conservan las restricciones que impiden repetir escrituras cuyo resultado sea ambiguo. La app conserva su caché y borradores existentes; esta entrega no añade una cola durable de envíos offline. Fotos, vídeos y llamadas siguen necesitando ancho de banda suficiente, y el primer acceso web aún debe descargar su aplicación. No puede ofrecerse la misma velocidad de una fibra en 2G ni continuidad sin señal o sin servidor disponible.

## Validación

Pasaron 942/942 pruebas Angular, incluyendo regresiones de recuperación parcial/completa, reapertura, red lenta, PIN compartido, cambios simultáneos, cambio de cuenta, resultados biométricos atrasados, falsificación de respuestas WebAuthn y protección inicial del contenido. Pasaron 61/61 pruebas Node y las comprobaciones .NET de Modo Seguro (22), historial (61), push (39), release (12) e infraestructura (73). Las 52 comprobaciones JVM Android mantienen sus resultados correctos con las entradas nativas sin cambios.

La revisión visual utilizó el componente real de bloqueo con servicios ficticios en 390 × 844 y 1280 × 900. Se comprobaron las pantallas de biometría, alternativa PIN y espera protegida. No constituye una prueba de un lector físico ni de una operadora 2G. Se mantiene la entrega sin emulador solicitada por el usuario.

El conteo reproducible de fuentes actuales es de 124.290 líneas físicas en 470 archivos: 106.805 de aplicación/herramientas y 17.485 de pruebas. Incluye comentarios, estilos, plantillas y migraciones; excluye dependencias, binarios y salidas de compilación. El paquete inicial web es de 3,14 MB y conserva un aviso de presupuesto: reducirlo sigue siendo trabajo pendiente para el primer acceso en redes lentas. El APK y la aplicación Windows incluyen esos recursos localmente.

Los paquetes finales se compararon con la misma distribución de producción: 1430 archivos web en Windows, 1429 en el APK y 1430 en el ZIP. Android identifica 5.2.0/build 35 y conserva el certificado SHA256 `e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`. Los metadatos de descarga y actualización se generaron después de verificar las versiones, los archivos y la firma reales.

La política compartida requiere desplegar la API 5.2.0 y su migración aditiva `AccountAppLock` en el servicio Render activo. La migración crea una tabla nueva de configuración de cuenta y no altera las tablas de mensajes. La API aplica sus migraciones al iniciar.

Referencias de plataforma: [BiometricPrompt Android](https://developer.android.com/reference/androidx/biometric/BiometricPrompt), [WebAuthn](https://www.w3.org/TR/webauthn-3/), [SignalR y reconexión](https://learn.microsoft.com/aspnet/core/signalr/javascript-client), [señal online](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine) y [límites de Network Information](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/effectiveType).
