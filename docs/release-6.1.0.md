# Nivra 6.1.0

Cliente y API 6.1.0, Android build 37, protocolo de llamadas 2. Esta versión corrige dos fallos confirmados de 6.0.0 e incorpora fotos con fragmentos de música en las historias.

## Añadir y cambiar de cuenta

Una petición protegida iniciada sin sesión, durante «Añadir otra cuenta», podía recibir un 401 e iniciar una renovación sin token. Ese flujo terminaba interpretándose como cancelación del alta, restauraba la primera cuenta y navegaba a Chats. La regresión se reprodujo con Router, AuthPage, AuthService, interceptor HTTP y registro cifrado IndexedDB reales, utilizando únicamente cuentas ficticias y transporte de prueba.

Una respuesta 401 sólo puede renovar la sesión con la que comenzó la petición. Una expiración automática sin cuenta activa ya no equivale a pulsar «Volver a mi cuenta». El formulario permanece abierto hasta autenticar la nueva cuenta o cancelar expresamente; el registro conserva la sesión anterior. La prueba también autentica la segunda cuenta y comprueba el cambio entre ambas.

Las actualizaciones automáticas esperan también a que termine el cambio de cuenta. Una regresión integrada retiene la navegación al formulario y entrega una versión nueva durante esa transición: la app conserva el acceso de la segunda cuenta y sólo aplica la actualización pendiente después de volver expresamente a la cuenta anterior.

## Icono, difusiones y contactos

El proveedor PostgreSQL de producción utiliza reintentos de conexión. Las transacciones de apariencia, difusión y relaciones se abrían fuera del ámbito compatible con esa estrategia; su primera consulta podía lanzar una excepción y devolver HTTP 500. Estas operaciones utilizan ahora el mismo ámbito coordinado que el resto de transacciones de la aplicación, conservando los bloqueos y revisiones y evitando repetir una escritura cuyo resultado sea incierto.

La prueba reprodujo la excepción del proveedor Npgsql y verificó la solución. Una comprobación adicional contra PostgreSQL ejecutó consultas y bloqueos con identificadores inexistentes, sin modificar filas, cuentas ni mensajes. El cliente reconcilia una respuesta perdida del cambio de icono leyendo una vez la preferencia canónica; sólo confirma el cambio cuando coinciden la preferencia y la aplicación del icono en el dispositivo. También se registraron los iconos de flecha internos de Ionic que provocaban el error de URL al intentar cargarlos.

## Historias con música

El editor permite añadir a una foto un archivo de audio del dispositivo, elegir el inicio y un fragmento de hasta quince segundos, escucharlo, silenciarlo o quitarlo. Se conserva la edición existente de foto, texto y audiencia. Se admite un archivo compatible de hasta 12 MB y cinco minutos; la selección prepara audio mono a 22.050 Hz y rechaza contenido ilegible o vacío.

Sólo se sube el fragmento WAV recortado, de hasta unos 662 kB antes del cifrado. La canción original permanece en el dispositivo. Foto y fragmento utilizan archivos cifrados separados y los mismos destinatarios y vencimiento. En historias privadas y de grupo, título, posición, duración y claves se incluyen en el sobre cifrado de la historia. Las historias publicadas en Mundo conservan su semántica pública existente.

El visor presenta la foto con su fragmento, un distintivo musical y controles de reproducción y sonido. El avance y la vista previa siguen el tiempo real del audio, evitando cortar un fragmento antes de tiempo si tarda en arrancar. El visor espera a que estén listos la foto y el fragmento y se pausa al ocultar la app, mantener pulsado, responder o abrir controles. Si el navegador requiere una interacción para permitir sonido, ofrece «Toca para reproducir», de acuerdo con las [políticas de reproducción de audio del navegador](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay). El formato de archivo debe poder decodificarse en el dispositivo; la [API de decodificación](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData) necesita el archivo completo para preparar el fragmento local. La medición inicial del tamaño del editor se aplaza hasta terminar la comprobación de la vista, evitando el error de Angular al adaptar la foto a otra anchura.

El segundo archivo está sujeto a las mismas comprobaciones de acceso, expiración, bloqueo, visualización única y republicación. Una historia de una sola visualización prepara ambos contenidos antes de registrar su consumo. Cerrar el editor, cambiar de cuenta o reemplazar el audio invalida el trabajo pendiente y libera los recursos asociados.

## Despliegue y validación

La migración aditiva `20261026060301_StoryMusicFragment` incorpora la referencia opcional al archivo musical. Debe desplegarse la API 6.1.0 manteniendo la base y sus secretos. Las historias anteriores siguen funcionando; los clientes anteriores pueden seguir mostrando la foto sin la reproducción musical nueva.

Validación final del código:

- **1.177 pruebas Angular aprobadas**, incluidas las nuevas integraciones de cuentas y las regresiones de música, reproducción y launcher.
- **70 pruebas Node aprobadas**, de contenedor, puentes, notificaciones y actualizaciones.
- **456 comprobaciones .NET aprobadas**: identidad 24, relaciones 31, metadata 41, push 43, Modo Seguro 22, historial 61, infraestructura 73, llamadas 89, historias/archivos 60 y manifiesto de entrega 12.
- **20 comprobaciones offline aprobadas** del canal de publicación.
- **56 pruebas JVM de Android aprobadas**, sin fallos, errores ni pruebas omitidas, y compilación del APK firmada con el mismo certificado de la versión anterior.
- Comprobación PostgreSQL real aprobada: reproducción del fallo anterior y consultas y bloqueos corregidos con identificadores inexistentes, sin modificar filas de producción.
- Revisión visual y de reproducción en navegador, con los componentes reales y archivos sintéticos locales, en 390 × 844 y 1280 × 900. La fuente de veinte segundos se recortó desde el segundo tres en un WAV de cinco segundos; el visor terminó en el segundo cinco. La vista previa llegó al final elegido de la fuente y no se observaron errores nuevos de consola tras corregir la adaptación del editor.

Las pruebas focales de cuentas y metadata están incluidas en la validación anterior y no se suman nuevamente. No se publicaron historias reales ni se utilizaron cuentas del usuario para las pruebas. La recepción de notificaciones y la compatibilidad de los formatos de audio en teléfonos físicos conservan los límites de sistema y navegador explicados en la entrega anterior.

## Paquetes verificados

La verificación de entrega comparó los 1.436 archivos web del paquete de escritorio y del ZIP con la compilación final, y los 1.435 archivos empaquetables de Android con esa misma compilación. Se comprobaron versión, build 37 y certificado Android conservado de la versión anterior.

| Archivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `Nivra-6.1.0-debug.apk` | 83508508 | `f985a23fdca88f829eed14af366c1acf3955394e79ffa8ab3e157cf43fe34c97` |
| `Nivra-6.1.0-Setup.exe` | 107982631 | `cf2eb8afd6115baae815285eeca3407b449e867c93c9d943d8f36553cf45c280` |
| `Nivra-6.1.0-win32-x64.zip` | 156759134 | `d16b95c7b7c6daf63dc5e4fc9cfd676e33a36927a21f3171dead8ac6221748ef` |
