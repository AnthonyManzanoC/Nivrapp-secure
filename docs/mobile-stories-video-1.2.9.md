# Nivra 1.2.9: historias desde Chats y vídeo bidireccional

## De voz a vídeo

Se reprodujeron dos fallos distintos con conexiones reales del navegador. Al renovar los servidores ICE, `setConfiguration` omitía el tamaño del pool negociado y lo cambiaba de 4 a 0 después del primer SDP; el navegador rechaza ese cambio. Ahora conserva la configuración vigente y modifica únicamente servidores y política ICE.

Al añadir una cámara mientras la llamada aún figuraba como Voice, la opción antigua `offerToReceiveVideo: false` convertía el transceiver bidireccional en uno que sólo enviaba. Se eliminó esa opción, se prepara explícitamente la recepción cuando hace falta y se mantiene un único responsable de las ofertas para reducir colisiones durante las invitaciones. La aceptación sigue siendo explícita: una invitación no enciende la cámara del receptor. Los errores de permisos o captura ofrecen instrucciones y mantienen el audio.

## Historias

Chats y Mundo comparten un modal de creación. La propia historia conserva su reproducción y tiene un botón independiente para añadir otra, incluso cuando ya hay historias activas. El modal ofrece galería de fotos, vídeo o audio, texto y captura de cámara. Permite previsualizar, escribir una descripción, girar o recortar verticalmente una foto antes de publicar. El archivo publicado refleja la edición.

La cámara permite tomar fotos, cambiar entre frontal y trasera y grabar hasta 60 segundos. El micrófono se solicita al pulsar Grabar. El cierre, la salida de captura y los resultados tardíos de permisos liberan las pistas. Hay alternativas explícitas para la cámara del dispositivo o la galería cuando una función del navegador no está disponible.

Se conservan audiencia, grupos, duración, una visualización y permisos de republicación. La publicación continúa usando el cifrado y la preparación de archivos existentes. Un grupo que desaparece no se sustituye por contactos. El borrador se conserva ante un fallo de envío. Una historia confirmada por el servidor se mantiene aunque la actualización posterior falle o devuelva una lista anterior, para evitar publicaciones duplicadas. Se comprueba cuenta y dispositivo durante la preparación y subida.

La aparición breve de los anillos al abrir depende de la lectura local de historias. No bloquea los chats ni vuelve a iniciar la sesión; no se añadió una espera artificial para ocultarla.

## Navegación y presentación

La verificación de identidad vuelve al chat que la abrió. Tras recargar esa pantalla usa la ruta local validada guardada en la navegación; la comparación de claves y los controles ante cambios de identidad se mantienen. El lector de QR, el código y las acciones tienen una presentación adaptable.

La portada móvil ocupa mejor el ancho disponible, muestra una marca mayor y permite leer completos los métodos ID/Alias, QR y SMS. Cuenta muestra Cerrar sesión al final, después de la zona sensible, sin acordeón. Se ajustaron espaciado de iconos, estados de pulsación y foco. Las nuevas cadenas están disponibles en los diez idiomas.

## Validación de la versión

- 214 pruebas unitarias aprobadas en ChromeHeadless, incluyendo publicación de historias, cambios de cuenta y dispositivo, captura y navegación de identidad.
- 2 pruebas de integración aprobadas con conexiones WebRTC reales: voz establecida, solicitud de vídeo desde cada participante y recepción de imágenes en ambos extremos. Se ejecutan por separado de las pruebas que sustituyen las APIs WebRTC.
- Compilación web de producción, sincronización Capacitor, APK Android y paquete Windows completados. Persisten avisos de Sass y presupuestos de tamaño; no hubo errores de compilación.
- Firma APK v2 verificada con el certificado usado en la versión anterior. Android declara 1.2.9, código 18; el EXE declara 1.2.9.
- 1.416 archivos web coinciden por SHA-256 entre la compilación de producción y ambos paquetes. Se excluye únicamente `.well-known/assetlinks.json`, que sirve el dominio web y Android no empaqueta.
- Portada y editor de historias revisados en el navegador con tamaño móvil de 390 × 844 y escritorio. Las pruebas de cámara cubren permisos, cancelación y liberación de pistas; queda pendiente la captura con hardware del teléfono.

Registros: `artifacts/release-129-tests.log`, `artifacts/release-129-call-integration.log`, `artifacts/release-129-web-build.log`, `artifacts/release-129-android-build.log` y `artifacts/release-129-windows-build.log`.

## Comprobación física pendiente

No hay un HONOR 90 conectado en este entorno. Las pruebas del navegador no certifican todas las condiciones de radio, ahorro de batería o cámara de ese teléfono.

1. Instalar 1.2.9 en móvil y PC. Iniciar una llamada de voz, pedir vídeo desde el móvil y aceptar desde PC; repetir invirtiendo quién pide. Comprobar ambas cámaras sin salir de la llamada.
2. Negar cámara, continuar con audio y volver a solicitar vídeo. Cambiar de red y comprobar recuperación sin el error de configuración.
3. Desde Chats, crear una historia con foto, añadir otra con texto y comprobar el avatar y el botón de añadir por separado. Repetir desde Mundo.
4. Tomar una foto, cambiar de cámara, grabar vídeo y cancelar un borrador. Comprobar que la captura termina al abandonar el editor.
5. Verificar identidad desde una conversación y volver: debe permanecer esa conversación. Revisar la portada móvil y Cerrar sesión visible al final de Cuenta.
6. Cerrar y reabrir conservando sesión: los chats y las fotos deben conservar el comportamiento de 1.2.8 mientras las historias se actualizan.

## Paquetes

APK de prueba: `artifacts/Nivra-1.2.9-debug.apk`, versión 1.2.9, código Android 18. Windows: `artifacts/Nivra-1.2.9-win32-x64.zip`, que incluye EXE y recursos. Los hashes se guardan en `artifacts/Nivra-1.2.9-SHA256.txt`.
