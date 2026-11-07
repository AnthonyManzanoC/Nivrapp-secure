# Nivra 9.2.0 — primeros pasos y diagnóstico de avisos

6 de noviembre de 2026. Android build 58; se mantiene el identificador y certificado de la aplicación.

## Comportamiento

- La primera entrada general a Chats en una cuenta sin introducción local abre una guía. Se puede omitir y reabrir desde Cuenta. Los enlaces a conversaciones, invitaciones y llamadas mantienen su destino.
- Cinco tareas prácticas llevan a perfil, contactos, mensajes, llamadas y recuperación. Doce explicaciones presentan las áreas funcionales. El progreso es local por cuenta, se puede desmarcar y funciona en memoria si el almacenamiento está bloqueado.
- Cuenta y una ruta independiente muestran diagnóstico de notificaciones. Consulta el permiso nativo en Android, disponibilidad de API y proveedor, y registro activo de la cuenta/dispositivo. Windows explica su mecanismo sin exigir FCM. No se expone el token ni se afirma entrega garantizada.
- El endpoint de estado añade `hasRegistration`, filtrado por usuario y dispositivo; no requiere migración. La UI sigue siendo conservadora ante una API anterior o un fallo de red. Las respuestas tardías de otra sesión se descartan.
- La recuperación de acceso, identidad e historial se explica en la guía y en la recuperación de contraseña. Los enlaces de la guía abren el apartado correspondiente de Cuenta, incluso al reutilizar esa vista.
- Nuevos textos completos en español e inglés. Los demás catálogos conservan el fallback del sistema.

## Chat incógnito

- El diálogo de confirmación termina de cerrarse antes de navegar. Tiene tamaño compacto y colores que se mantienen al cambiar de página. Los errores de apertura aparecen en el mismo diálogo.
- La conversación temporal tiene vista propia, contacto, estado de conexión/entrada, mensajes y compositor, salida al chat normal y estado de sala terminada. Los paneles de notas/PIN y administración no se mezclan con la conversación.
- Cliente y servidor rechazan mensajes temporales si todavía no ha entrado el contacto. Se confirma la conexión y un rechazo al entrar deja de ignorarse.
- Un refresco fallido conserva la sala y los mensajes. Al reconectar se comprueba el acceso; las salidas offline se mantienen en memoria y se reintentan sin volver a mostrar la sala cerrada. Un cambio de cuenta limpia ese estado.
- El texto se conserva ante un fallo y un envío completado no borra el siguiente borrador. Se evitan dobles pulsaciones. La lista acompaña mensajes nuevos sin desplazar a quien está leyendo arriba.
- Se conserva la regla BurnOnExit: salir o desconectarse un participante puede terminar la sala. No cambia a borrado después de leer ni se promete impedir capturas.
- 72 pruebas unitarias Android aprobadas. Las regresiones Angular cubren modal, envío, conexión e aislamiento. Las capturas se comprueban en ambos temas y tamaños.

## Carga de recursos

Se elimina la precarga global de todas las rutas. LiveKit y su proveedor de llaves pasan a importación dinámica, el motor de juegos carga ante una partida y el panel al abrirse. Se preservan orden de paquetes, aislamiento de llamadas y cancelación durante la carga. Bóveda y Comunidades conservan pantallas diferidas.

La compilación local de referencia 9.1.0 tenía aproximadamente 3,23 MB iniciales. La compilación de esta entrega queda alrededor de 2,73 MB (reducción aproximada del 15,5 %); LiveKit aparece en un paquete separado de unos 523 kB. No se atribuye una reducción porcentual del tiempo de arranque sin medir dispositivos. Permanecen avisos de presupuesto inicial y de estilos existentes; no se aumentan los límites para ocultarlos.

En APK y Electron los paquetes están incluidos localmente: la carga diferida distribuye lectura/ejecución y no obliga a descargar código externo para cada función.

## Validación

Resultados locales: 1.660 pruebas Angular aprobadas; 50 comprobaciones HTTP de seguridad (incluido aislamiento del registro push); 44 comprobaciones del servidor push; 86 pruebas Node de escritorio y componentes nativos. La API compila sin errores. La distribución WASM supera su verificación de procedencia y licencias.

La revisión automatizada de diseño utiliza los componentes reales con datos ficticios. Comprueba cinco pasos y doce áreas de la guía, diagnóstico, ausencia de desbordamiento en 390×844 y 1440×900, ambos temas y ausencia de excepciones. Se inspeccionaron capturas locales. No se usan cuentas reales ni se envían mensajes.

Las huellas de instaladores se producen con tools/verify-release.ps1, que comprueba firma, versión, contenido web e integridad antes de generar el feed.

El [protocolo de sesiones con usuarios](usability-first-session-9.2.0.md) queda preparado para validar comprensión en Web, Android y Windows. No se presentan capturas sintéticas ni pruebas automatizadas como sesiones con personas.

## Operación pendiente

Las llamadas y notificaciones en teléfonos físicos, restricciones de fabricantes, TURN y la auditoría independiente conservan sus requisitos. iOS no tiene proyecto nativo generado. Configurar avisos no prueba su entrega; una red o sistema pueden impedirla. La nueva propiedad del diagnóstico requiere desplegar la API actual para confirmarla desde el servidor.

## Artefactos publicados

Código funcional: d51d6069322851175020ee0854aca72e13ab6001. Publicación: https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/tag/v9.2.0.

El verificador confirmó 1.452 archivos web de escritorio/ZIP y 1.451 en Android, con firma Android existente y build no depurable. Las descargas públicas del APK y EXE coinciden por tamaño y SHA-256 con los artefactos locales. Se revisaron 69 capturas sintéticas de diseño. Los checksums completos viajan en Nivra-9.2.0-SHA256.txt.
