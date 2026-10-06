# Nivra 1.2.8: perfiles estables y transición a video

## Chats al volver a abrir

Las fichas parciales de participantes y contactos ya no eliminan nombres o fotos completos durante la sincronización. Una consulta de perfil que falla por falta de red conserva la copia conocida. Se persiste el perfil fusionado para que la siguiente apertura no parta de un resumen incompleto.

Los contactos completos del bootstrap y las respuestas del directorio son la autoridad para cambios de perfil, incluida la retirada de una foto. La copia de apertura refleja esa respuesta y las lecturas locales tardías completan campos ausentes sin reemplazar datos que ya llegaron del servidor. Un perfil local más reciente puede enriquecer una copia de apertura anterior.

El aviso del historial espera 900 ms cuando la pantalla deja de cargar. Si el almacenamiento se recupera durante ese intervalo, el aviso no aparece. Si el fallo persiste, conserva el mensaje y la acción Reintentar. Los datos cifrados y las claves existentes se conservan.

## Audio a video

En una llamada directa, activar video en un lado publica su cámara y solicita al otro participante activar la suya. El receptor acepta mediante una acción visible antes de capturar video. Puede mantener su cámara apagada y continuar la llamada. La solicitud y la respuesta viajan por la señal cifrada `media-mode` existente.

La pantalla distingue una solicitud de cámara, la espera de video y una cámara apagada. La espera visible dura hasta 30 segundos y una aceptación posterior todavía se procesa. En llamadas grupales cada participante controla su cámara. Migrar a un grupo o reconectar conserva el micrófono silenciado y la cámara apagada; los controles permiten volver a activarlos aunque todavía no existan pistas locales. Las respuestas de permisos que llegan después de finalizar la llamada se descartan sin crear medios para una llamada nueva.

La composición directa reserva el escenario al contacto y muestra la cámara propia en una vista pequeña. La cuadrícula grupal conserva sus participantes y los avatares de espera mantienen un tamaño limitado. Compartir pantalla sigue visible aunque la cámara esté apagada. Hay una acción para reactivar audio cuando el navegador exige una interacción. El sonido de conexión se detiene al conectar, fallar o finalizar.

## Verificación en dispositivos

La comprobación física sigue pendiente; no hay un teléfono conectado a ADB en este entorno. Instalar 1.2.8 en ambos extremos para comprobar la nueva invitación de cámara. La instalación de prueba debe conservar los datos de la versión anterior.

1. En HONOR 90, dejar sincronizar, quitar Nivra de Recientes y abrir con y sin red. Verificar que nombres y fotos no cambian a iniciales mientras se completa la lista.
2. Volver desde Inicio varias veces. Un error transitorio del historial no debe producir un destello; un fallo persistente debe conservar Reintentar.
3. Llamar entre móvil y PC. Pedir video primero desde móvil y luego desde PC. Aceptar en el otro lado y verificar ambos videos sin salir de la llamada.
4. Mantener la cámara apagada, negar el permiso y cancelar mientras el permiso está abierto. El audio debe seguir y no debe aparecer captura después de colgar.
5. Probar una llamada grupal, activar y apagar cámaras, fijar participantes y abrir juegos. El sonido de conexión no debe continuar sobre el audio de la llamada.
6. Cambiar de red y volver a la llamada. Revisar la recuperación y la acción de reintento cuando la red no permite conectar.

## Verificación automatizada

76 pruebas pasan en Chrome Headless: llamadas, presentación de video, perfiles, apertura de chats, historial cifrado, identidad, medios y cifrado grupal. Cubren permiso rechazado, cierre durante captura, respuesta tardía, toques repetidos, consentimiento al pasar a grupo, cámara apagada, compartir pantalla y el aviso transitorio de almacenamiento.

La compilación de producción de Angular, la sincronización Capacitor, `assembleDebug` de Android y el empaquetado Windows finalizan correctamente. Angular conserva advertencias de tamaño del bundle y del estilo de chat-detail, además de la deprecación Sass `@import`.

El APK verifica su firma v2, declara `com.nivra.app`, versión `1.2.8`, código `17`, y conserva el certificado de 1.2.7. El EXE declara versión `1.2.8`. Se compararon por SHA-256 los 1415 archivos web de la aplicación dentro del APK y del paquete Windows con la compilación nueva; `assetlinks.json` pertenece a la asociación del dominio y aapt excluye su carpeta `.well-known` del APK.

Paquetes locales: `artifacts/Nivra-1.2.8-debug.apk` y `artifacts/Nivra-1.2.8-win32-x64.zip`, con hashes en `artifacts/Nivra-1.2.8-SHA256.txt`. El ZIP incluye el EXE y sus recursos.

Las pruebas locales no certifican entrega de FCM en reposo ni conectividad en todas las redes móviles.
