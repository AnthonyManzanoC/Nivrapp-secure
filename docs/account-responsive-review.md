# Cuenta, idiomas y navegación — revisión local

## Cambios

- Cuenta utiliza elementos `details/summary` accesibles. Los formularios permanecen montados al plegar una sección, conservando sus valores.
- La navegación usa la foto del usuario en un círculo; conserva el icono cuando no hay foto o la imagen falla. Los enlaces tienen nombres accesibles también en móvil.
- Mundo usa una sola columna hasta 860 px. El host de grupos ocupa `1 / -1`, evitando crear columnas implícitas en móvil.
- La carga de idiomas ignora respuestas tardías de selecciones anteriores, evita mostrar el diccionario anterior y permite reintentar descargas fallidas.
- Se completaron las claves usadas por Cuenta, recuperación, Mundo y las demás pantallas en los diez catálogos. Recuperación ya utiliza el servicio de traducción; las fechas siguen el idioma elegido.
- El botón para revocar un dispositivo se desactiva durante el guardado.

## Controles ocultos tras revisar sus consumidores

No se borraron las preferencias almacenadas ni se modificaron los endpoints de seguridad. Se ocultaron controles que no tenían una ruta de ejecución que aplicara su promesa: proxy, contenido adulto, borrado por inactividad, traducción de chats enteros, Direct Share, navegador integrado, streaming configurable, ahorro de datos de llamadas y preferencias locales de visibilidad. También se ocultó el guardado de canales, cuya función de canales todavía no está disponible.

Se mantienen los controles conectados a funcionalidades existentes, como privacidad del servidor, bloqueo, ajustes visuales, guardado de medios de chats/grupos, gestos nativos y pausa de reproducción.

## Comprobaciones

- Suite Angular: 106 pruebas correctas, incluidas tres regresiones de carga de idiomas (respuesta tardía, idioma anterior y reintento) y una de formato de fechas.
- Compilación de producción correcta; persiste la advertencia de tamaño del bundle inicial.
- Navegador local, viewport de 390 px: ancho del documento 390 px, grid 348 px, cero hijos de Mundo desbordados hacia la derecha.
- Cuenta: apertura/cierre de secciones, cambio a inglés, persistencia al recargar y restauración a español; foto visible en navegación de escritorio y móvil.

## Límites de la comprobación

Los diez catálogos cubren las 839 claves de la interfaz y preservan las variables dinámicas. Las traducciones generadas automáticamente requieren revisión de hablantes nativos; los errores enviados por el backend aún pueden aparecer en español. No se han probado destructivamente la revocación de sesiones, borrado de cuenta o cambios de credenciales de una cuenta real. La comprobación responsive fue en navegador, no en hardware Android/iOS. CoTURN permanece fuera de esta entrega.
