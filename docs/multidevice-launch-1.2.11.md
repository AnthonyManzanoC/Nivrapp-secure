# Nivra 1.2.11: historial entre dispositivos y experiencia de apertura

## Historial cifrado

Un inicio con contraseña en otro navegador crea una identidad de dispositivo distinta. Los mensajes anteriores estaban cifrados para las llaves anteriores, por lo que iniciar sesión no bastaba para abrirlos. La vinculación QR ahora incluye el conjunto de llaves históricas asociadas a la misma cuenta. El destino genera su propia identidad local y registra esa llave pública; las privadas recibidas mediante QR se utilizan únicamente para abrir historial. El backend respeta el bundle publicado por el destino actual y conserva el recorrido anterior para destinos antiguos. El cliente actual rechaza el callback heredado que entrega tokens del origen, sin modificar la identidad de ese equipo. Para un inicio con contraseña, el dispositivo nuevo solicita una transferencia y muestra una huella calculada localmente a partir de su propia llave pública.

En un dispositivo anterior actualizado, el propietario compara esa huella con la del dispositivo nuevo y autoriza compartir el historial. La aprobación es local y explícita: el cliente nunca exporta sus privadas únicamente porque el servidor declare autorizado un dispositivo. La autorización vuelve a comprobar la solicitud y se vincula a la misma llave mostrada. Las llaves viajan selladas mediante ECDH P-256 y AES-GCM; el servidor sólo conserva metadatos públicos y ciphertext. Las solicitudes tienen un plazo de acceso de quince minutos; una solicitud nueva limpia las transferencias vencidas de esa cuenta.

Los endpoints verifican la cuenta, el dispositivo de origen y destino, confianza, revocación, caducidad, formato criptográfico y snapshots de las llaves. El cliente comprueba además el propósito, solicitud, cuenta, dispositivo, caducidad y llave de destino dentro del payload autenticado. Valida que cada privada corresponda a su punto público y almacena el conjunto protegido localmente. Los registros antiguos sin propietario demostrado pueden seguir siendo candidatos de descifrado local; no se exportan seleccionándolos sólo por un alias que puede cambiar de dueño.

Después de importar las llaves se reintentan los sobres pendientes, la lista y la conversación abierta. Las demás conversaciones acceden a las llaves al cargar sus páginas. Se conserva la caché existente y se indica el historial pendiente en vez de ocultar el problema como una conversación vacía. Esto recupera el historial cifrado que todavía está disponible, respetando la caducidad y las políticas de una visualización. No puede recrear mensajes borrados ni llaves perdidas en todos los dispositivos.

La resolución de identidad con credenciales identifica la cuenta antes de reutilizar una llave local. Mientras un servidor antiguo devuelva sólo el alias, se genera una identidad nueva en vez de inferir la propiedad de una privada por ese alias. Las llaves anteriores de propietario desconocido se conservan protegidas para descifrado local y no se exportan. Si falta la publicación de la llave del equipo actual, el envío la repara y vuelve a comprobar los directorios. Nunca sustituye una llave remota por una antigua ni omite un participante sin dispositivo autorizado. En ese caso el error identifica el contacto y explica cómo recuperar la recepción. Los resultados de red, QR, importación y cargas de mensajes se descartan si cambia su contexto de cuenta o dispositivo.

La comparación y el envío consideran el mismo directorio de identidades publicadas. Se omiten únicamente los dispositivos antiguos sin llave publicada; una llave presente malformada, una privada o un identificador duplicado siguen rechazándose. Un cambio real en las llaves públicas conserva el bloqueo hasta comparar y guardar la verificación. El aviso aparece junto al compositor con un botón para abrirla. El texto pendiente se entrega de vuelta una sola vez, en memoria y limitado a la cuenta, dispositivo y conversación; no se añade al almacenamiento ni al historial del navegador.

La migración aditiva `HistoryKeyTransfers` añade solicitudes y respuestas selladas; las respuestas tienen borrado en cascada. Se aplicaron ésta y la migración anterior pendiente `GroupInviteLinks`. La comprobación posterior de PostgreSQL encontró cero migraciones pendientes y verificó la coordinación con ocho transacciones reales.

## Cámara y llamadas

Las preferencias de captura ya no imponen máximos que excluyan cámaras utilizables. Para errores recuperables hay un único intento compatible. Una denegación de permiso no genera otra solicitud automática. El cambio de voz a video captura sólo video y conserva el micrófono; reutiliza una pista propia viva cuando corresponde. En grupos se recuperan publicaciones de cámara interrumpidas a través del SDK.

Los transceivers antiguos con dirección `sendonly`, `recvonly` o `inactive` se actualizan a `sendrecv` al publicar. Esto habilita la ruta inversa de video durante la renegociación. Una captura tardía o una publicación fallida se limpia sin activar una cámara en la llamada siguiente. Los diagnósticos distinguen permiso, cámara ausente, fallo de inicio y fallo de actualización; la llamada mantiene audio y ofrece reintentar cuando corresponde.

La foto del Mac no permite determinar si existe un fallo físico. Los cambios cubren caminos reproducibles en código; todavía se requiere comprobar la cámara y los permisos de Safari en ese equipo. Tampoco hay un teléfono físico conectado para validar cambios de red, suspensión y permisos del sistema.

## Fondos y apertura web

Nivra usa un fondo crema con dibujos vectoriales originales y una variante oscura. Seda añade contornos suaves en ambos temas. Los cuatro SVG son locales y ligeros. El chat real, las miniaturas y la vista previa utilizan la misma fuente, con tamaño y repetición coherentes. Se mantienen las elecciones existentes por cuenta.

La web consulta un manifiesto público de versión una vez por día local al abrir. No impone una duración mínima; libera la pantalla a los 1,2 segundos como máximo si la comprobación tarda o no hay conexión. Sólo recarga para una versión numérica superior, con una marca persistida que evita bucles. No recarga durante llamadas o subidas, ni al entrar en autenticación o recuperación. Los paquetes Android y Windows no utilizan este recorrido. Las cabeceras de despliegue permiten revalidar el HTML y evitan almacenar el manifiesto; los assets con hash conservan su caché.

La pestaña muestra el número de conversaciones visibles no leídas, por ejemplo `(3) Nivra - Private Messenger`. Se actualiza al leer y al llegar conversaciones, y se limpia al cerrar sesión. No muestra nombres ni contenido de mensajes.

## Validación y paquetes

Validación final: 370 pruebas unitarias de Angular y dos pruebas con conexiones WebRTC reales en Chrome Headless, todas correctas. El servidor pasó 28 comprobaciones de historial/QR y 73 de llamadas. Las pruebas incluyen claves WebCrypto reales, recuperación entre identidades, autorización explícita, rechazo de sustituciones, respuestas tardías, aislamiento de cuentas, preservación de llaves antiguas y paso bidireccional a video. La compilación Angular de producción terminó con hash `158b99a91d380332`; mantiene los avisos no bloqueantes de Sass `@import` y del presupuesto inicial (2,81 MB, aproximadamente 577 kB transferidos).

Android se compiló correctamente con firma v2 y el mismo certificado SHA-256 de la versión anterior (`e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`). Windows muestra FileVersion y ProductVersion `1.2.11`. Se compararon por SHA-256 los 1421 archivos web distribuidos en ambos paquetes contra la compilación de producción; todos coinciden. La asociación del dominio `.well-known/assetlinks.json` se sirve desde la web y aapt la excluye del APK.

SHA-256 del APK: `40b057127df311b3a61f276203c2582cc30d65d3a09366e4547845d74db17a6f`. SHA-256 del ZIP Windows: `19f7c88a4400dc55f2608afedd29c6660d32d01eb8fa7966a0924eba6dcde12c`.

Los fondos originales se inspeccionaron en muestras con temas claro/oscuro y tamaños móvil/escritorio. El nuevo aviso de identidad se verificó mediante pruebas de render, acción explícita y bloqueo durante envío; se dejó una muestra con CSS real y datos ficticios. La sesión de navegador de CUA no estuvo disponible para una inspección visual final de ese aviso. No se realizó una llamada física con el Mac ni con el teléfono del usuario.

Android: `artifacts/Nivra-1.2.11-debug.apk`, versión 1.2.11, código 20. Windows: `artifacts/Nivra-1.2.11-win32-x64.zip`. Los hashes quedan en `artifacts/Nivra-1.2.11-SHA256.txt`.

Comprobación física recomendada: vincular dos navegadores mediante contraseña y mediante QR; comparar las huellas y recuperar mensajes antiguos directos y grupales; cancelar y cambiar de cuenta durante una transferencia; enviar a un contacto antiguo; pasar de voz a video desde cada lado en teléfono y Safari; apagar/reactivar la cámara; recibir video de todos los participantes de un grupo; abrir por primera y segunda vez en el día y comprobar el contador al leer.

## Publicación del servidor

El servidor se publica manualmente desde Render. Después de subir el commit validado a `main`, usar `Manual Deploy → Deploy latest commit` en el servicio de Nivra. La comprobación `GET /health/ready` debe devolver `status: "ok"`, `version: "1.2.11"`, `callProtocol: 2`. La web debe servir `assets/release.json` con la misma versión. La transferencia de historial y el registro QR de identidad local requieren ese servidor nuevo; el cliente mantiene el inicio con contraseña compatible durante la actualización.
