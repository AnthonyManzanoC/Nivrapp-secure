# Nivra 7.2.0 — navegación de Cuenta y recuperación de envíos

Android build 44. La actualización se instala sobre 7.1.0 con el mismo certificado y conserva el contrato de descarga de APK y EXE.

## Comportamiento

- Cuenta incorpora un buscador de ajustes. Busca por nombre traducido y términos relacionados, sin distinguir mayúsculas o acentos. Los resultados abren y enfocan su sección, sin guardar, restablecer ni cambiar valores. Se mantienen los seis accesos principales, el uso con teclado y la preferencia de movimiento reducido.
- Al enviar un texto, la burbuja aparece inmediatamente con estado pendiente. Si el envío falla mientras se escribe el siguiente mensaje, ambos textos permanecen separados: el fallido ofrece Reintentar/Descartar y el nuevo sigue en el editor.
- Reintentar conserva el identificador original, la respuesta citada y la política de expiración. Una confirmación tardía retira la recuperación pendiente; una respuesta de una cuenta anterior no modifica la cuenta actual.
- Los nuevos controles se adaptan a móvil y escritorio y a los temas claro/oscuro. Los objetivos táctiles miden al menos 44 píxeles y la búsqueda informa de resultados vacíos.

## Validación

- 1.405 pruebas Angular/Chrome Headless aprobadas en la suite general; las dos pruebas de integración WebRTC también pasan por separado. Incluyen aislamiento entre cuentas, bloqueo privado, confirmaciones tardías, reintentos idempotentes y conservación del nuevo borrador.
- 48 pruebas del contenedor Windows aprobadas, incluidas actualización, validación de origen, almacenamiento seguro y protección de la ventana.
- Revisión visual de los componentes reales en Chromium a 320, 390 y 1.200 píxeles, incluyendo ambos temas y búsqueda sin coincidencias; sin desbordamiento horizontal.
- Compilación de producción y verificación de contenido, firma, versión y hashes de los instaladores mediante los scripts de publicación del repositorio.
- La comprobación adicional de apertura Android en emulador no se pudo ejecutar: el AVD rechazó el arranque por espacio libre insuficiente en el equipo anfitrión, incluso tras comprimir archivos de compilaciones anteriores. No se presenta como una prueba aprobada ni como validación en un teléfono físico.

## Alcance

La recuperación del texto fallido reside en memoria y sólo en el contexto actual del chat, cuenta y dispositivo. No es una cola persistente tras cerrar la aplicación. No se añaden copias de texto plano al almacenamiento local ni cambios al protocolo E2EE, al bloqueo de contactos o a la verificación de identidad. El reintento usa el mismo servicio de cifrado y las comprobaciones de permisos existentes.

No se requieren migraciones ni un cambio del protocolo de llamadas. Los clientes son compatibles con la API 7.0 activa. Las pruebas locales no garantizan disponibilidad de la red ni sustituyen pruebas en todos los teléfonos físicos.

El bloqueo de archivos por cuota de Supabase detectado en 7.1 sigue siendo una incidencia del proveedor. Esta actualización no afirma resolverlo: requiere restablecer la cuota o el servicio de almacenamiento.
