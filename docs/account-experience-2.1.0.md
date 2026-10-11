# Perfil y cuenta en Nivra 2.1.0

El perfil abre con foto, nombre, alias y un estado visible de cambios pendientes. Guardar muestra progreso y evita envíos simultáneos; descartar restaura foto, texto y preferencias al último perfil cargado. Los fallos de carga y guardado aparecen junto al formulario y conservan el borrador. La recuperación de cuenta mantiene su flujo de correo verificado en una sección propia.

La biografía vacía se envía explícitamente como cadena vacía. Antes se enviaba `null`, que el servidor interpretaba como «no cambiar», y borrar el texto podía dejar la biografía anterior. Nombre y biografía usan los límites existentes de 160 y 500 caracteres. La elección de foto limita el archivo a 20 MB antes de abrir el decodificador.

La invitación y el QR usan la URL web pública, incluso desde Android y Windows. No se comparte el origen `https://localhost` de una WebView. La copia utiliza el puente de portapapeles nativo cuando corresponde y cerrar la hoja de compartir del sistema no se presenta como un fallo.

## Seguridad comprobada

Las cargas y mutaciones de `AccountService` están ligadas al usuario y dispositivo que iniciaron la operación. Respuestas tardías, cierres de sesión o cambios de dispositivo no pueden reemplazar el usuario activo, las reglas de privacidad ni la lista de dispositivos. Antes y después de una lectura asíncrona de claves para cambiar alias se vuelve a comprobar el ámbito de la cuenta.

Los resultados de disponibilidad de alias y las fotos recortadas también respetan ese ámbito. El escáner cierra la captura si la cámara termina de abrirse después de cerrar la pantalla o cambiar cuenta. Una imagen QR que acaba de decodificarse después de cerrar el escáner no ejecuta su acción.

## Rendimiento comprobado

Los refrescos simultáneos comparten una sola operación de carga: una lectura de perfil, dispositivos, privacidad y permisos. No se añade sondeo periódico. La página evita una segunda estimación de almacenamiento al entrar y compara campos de borrador sin serializar la foto Base64 en cada ciclo de renderizado.

Los 18 casos de perfil/cuenta pasan en Chrome Headless. Cubren aislamiento entre cuentas y dispositivos, coalescencia de solicitudes, recuperación ante errores, borrador conservado, borrado real de biografía, URL pública, reintento del alias y liberación de una captura de cámara tardía. El caso de cámara simula la promesa de permiso; no solicita acceso físico a cámara ni envía mensajes o llamadas. Estas pruebas no representan carga de producción ni sustituyen una prueba manual en el teléfono.

Archivos principales: `account.service.ts`, `account.page.ts`, `account.page.html`, `account.page.scss`, `account-session-scope.spec.ts` y `account-profile-experience.spec.ts`.
