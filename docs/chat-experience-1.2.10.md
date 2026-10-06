# Nivra 1.2.10: experiencia de chat

## Conversación y escritura

Se mantiene el transporte cifrado existente. El rediseño agrupa las acciones secundarias dentro del campo y deja una acción principal: grabar si el borrador está vacío o enviar si contiene texto. Los ajustes de duración y una visualización están disponibles en Privacidad del mensaje, con indicación de una política personalizada. La cámara sigue accesible en el menú de adjuntos incluso en pantallas pequeñas.

Los mensajes tienen separadores de fecha, remitente en grupos y confirmaciones basadas en recibos. Los destinatarios de cada mensaje se calculan según la fecha de incorporación o salida; un miembro nuevo no hace retroceder las confirmaciones de mensajes anteriores. Los registros de llamada se pueden pulsar para volver a llamar.

La búsqueda se realiza sobre mensajes disponibles en este dispositivo, sin mandar contenido a un buscador. Permite pasar a la coincidencia anterior o siguiente. No incluye mensajes de una visualización, caducados ni errores de descifrado. El gesto horizontal permite responder; moverse al desplazar cancela la pulsación larga. Los mensajes de una visualización no ofrecen una respuesta que copie su contenido.

## Emojis y stickers

Selector con 267 emojis, siete categorías, búsqueda español/inglés y recientes limitados a 24. Un emoji se inserta en el cursor o reemplaza la selección, sin enviar el borrador. Los recientes guardan únicamente identificadores del catálogo en el dispositivo y se pueden borrar.

Doce stickers originales se convierten localmente de SVG a PNG transparente. Se envían como archivos cifrados con una indicación opcional dentro del contenido cifrado; un cliente anterior puede verlos como imágenes. El sticker se envía aparte, conservando el texto pendiente. No se usan catálogos remotos ni servicios externos. Durante una edición de texto se mantienen los emojis y se desactiva el envío de stickers.

Al responder con un sticker, adjunto o nota de voz, la referencia al mensaje original se incluye dentro del payload cifrado. Las políticas de una visualización y caducidad siguen limitando el contenido que se puede citar.

## Información y navegación

Los perfiles directos reúnen avatar, alias, teléfono, biografía, historias, multimedia y seguridad. Los grupos conservan permisos, configuración, administradores, invitaciones y acciones actuales, con búsqueda de participantes y filtros en la vista previa multimedia. Bloquear o salir queda separado de las llamadas.

La verificación iniciada desde Info espera el cierre del modal y vuelve a la conversación exacta. Tanto Info como Verificar identidad respetan el espacio nativo de la barra de estado, con fallback Ionic/navegador aplicado una sola vez. Se mantienen las comprobaciones criptográficas de identidad.

Las acciones nuevas descartan resultados tardíos cuando cambia cuenta, dispositivo, conversación o se destruye la pantalla. La subida de archivos y el envío de mensajes comprueban el contexto de usuario y dispositivo durante las esperas para evitar que una operación antigua use otra sesión.

## Comprobación física

No hay un HONOR 90 conectado al entorno. Antes de distribuir ampliamente, comprobar en ese teléfono:

1. Abrir chat directo y grupo, escribir texto largo, abrir adjuntos, galería y cámara. Comprobar ancho del campo y teclado.
2. Insertar emoji a mitad de un texto; buscar por alegría/corazón y equivalentes en inglés. Enviar sticker con un borrador pendiente y comprobar que el borrador se conserva y la otra persona recibe la imagen.
3. Desplazar mensajes verticalmente y deslizar uno horizontalmente para responder. Probar pulsación larga, acciones, una visualización y caducidad.
4. Buscar mensajes y navegar entre coincidencias; comprobar resultados que sólo existen en el historial disponible localmente.
5. Abrir Info directo y grupal, filtrar multimedia, buscar miembros y verificar identidad. Volver debe conservar el chat y el reloj debe quedar libre.
6. Comprobar temas claro/oscuro, orientación y tamaño de texto del sistema, además de llamadas y mensajes normales tras actualizar.

## Paquetes

Android 1.2.10, código 19: `artifacts/Nivra-1.2.10-debug.apk`. Windows: `artifacts/Nivra-1.2.10-win32-x64.zip`. Los hashes quedan en `artifacts/Nivra-1.2.10-SHA256.txt`.

## Validación

- Compilación TypeScript de aplicación y pruebas sin errores.
- 266 pruebas unitarias correctas. Incluyen cambio de cuenta/dispositivo durante subidas y envíos, privacidad de citas, recibos históricos, inserción de emojis y generación de PNG transparente.
- 2 pruebas de integración WebRTC correctas en Chrome Headless con conexiones reales locales.
- Revisión visual con servicios simulados en 390×844 y 1280×900: escritura, adjuntos, búsqueda, emojis, stickers, perfiles directos/grupales y filtro de miembros; temas claro y oscuro.
- Build de producción correcto, hash `4f3d8f22be45195b`. Permanece el aviso existente del bundle inicial (2,75 MB frente a objetivo de 2 MB) y la deprecación Sass de `@import`. No hay error de presupuesto de estilos.
- Android compilado con Gradle; `aapt` confirma versión 1.2.10/código 19 y `apksigner` confirma firma v2 con el certificado anterior. Windows confirma FileVersion/ProductVersion 1.2.10.
- 1416 archivos web idénticos mediante SHA256 entre build, APK y Windows. Se excluye únicamente `.well-known/assetlinks.json`, servido por el sitio y omitido por `aapt`.
- SHA256 APK: `76415008ddae095ddee7149f7b175c337455fca59a27437ab7c2d46e09d0cde9`.
- SHA256 ZIP Windows: `c8f00971ca7a15bdcedf370ac03916043b9e88c7fe938787b236c871b1740a03`.
