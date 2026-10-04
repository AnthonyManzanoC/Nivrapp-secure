# Nivra 1.2.1 — interfaz e idiomas

Esta versión conserva los flujos de mensajería, llamadas y cifrado de 1.2.0. Actualiza la presentación y corrige problemas observados en móvil.

- El idioma elegido en Inicio o Cuenta se aplica inmediatamente. Las respuestas lentas de un idioma anterior ya no sustituyen al seleccionado. Los catálogos incluyen las mismas claves y las fechas usan el idioma activo.
- Cuenta reúne las funciones en secciones desplegables accesibles. La foto del perfil reemplaza el icono de Cuenta cuando existe; el icono reaparece si la imagen falla.
- Mundo ocupa todo el ancho del teléfono. El componente de grupos no crea columnas ocultas y las tarjetas conservan sus proporciones.
- El emblema de Nivra mantiene su escudo y rayo; se actualiza de forma coherente en web, PWA, Android y Windows.
- Se ocultaron opciones locales que guardaban un valor pero no ejecutaban el comportamiento anunciado. Sus valores almacenados se conservan para una implementación futura.

Los textos traducidos automáticamente deben recibir revisión editorial de hablantes nativos antes de campañas internacionales. Las respuestas de error generadas por el backend pueden seguir en español. Esta entrega no cambia CoTURN, protocolos criptográficos ni migraciones de base de datos.

**Comprobaciones:** compilación Angular de producción, 106 pruebas de Angular, revisión móvil en navegador y validación de APK y paquete portable de Windows. El APK es de depuración firmado para pruebas; el EXE se distribuye con su carpeta portable.
