# Nivra 6.1.1

Cliente 6.1.1, Android build 38, protocolo de llamadas 2. Incorpora navegación por barrido, un atajo entre las dos cuentas y avisos de historial que se pueden ocultar temporalmente. Corrige el cierre Android al cambiar de icono. El flujo de acceso y segunda cuenta de 6.1.0 se conserva.

## Navegación táctil

En las pantallas principales, desplazar el dedo hacia la izquierda abre la siguiente pestaña de la barra y hacia la derecha vuelve a la anterior: Chats, Mundo, Bóveda, Llamadas y Cuenta. Se avanza una pestaña por gesto, sin saltar desde los extremos al otro lado. La entrada de la pantalla utiliza una transición breve y respeta la preferencia de movimiento reducido.

Las filas de Chats ya tienen acciones horizontales de Ionic. El nuevo observador conserva sus gestos cortos y sólo interpreta un barrido amplio y deliberado como cambio de pestaña. Antes de navegar cierra la fila deslizante. No hay acciones automáticas de fijar, archivar ni silenciar asociadas al barrido largo. Una fila ya abierta conserva su gesto de cierre y sus botones.

El observador usa listeners pasivos para el inicio y movimiento, fuera de la zona de Angular, sin capturar el gesto ni bloquear el desplazamiento vertical. Sólo cancela el clic de compatibilidad al finalizar un barrido válido. Esta separación se apoya en la semántica de [eventos táctiles del navegador](https://developer.mozilla.org/en-US/docs/Web/API/Touch_events/Using_Touch_Events) y en los controles Ionic instalados. La navegación reemplaza la entrada de la pestaña para evitar acumular una entrada de historial por cada barrido; los botones y accesos de teclado conservan su funcionamiento.

## Protección de la interacción

El cambio por gesto se limita a las cinco rutas principales y a la disposición con barra inferior. No se activa dentro de conversaciones, otras rutas, controles de edición o multimedia, zonas con desplazamiento horizontal, ventanas modales, menús o la Bóveda a pantalla completa. Una llamada en curso, el Modo Seguro bloqueado y una transición entre cuentas también lo desactivan. La transición respeta tanto la preferencia de movimiento reducido del sistema como el interruptor de animaciones de Nivra, y libera su referencia a la vista cuando termina.

Se descartan gestos verticales, diagonales ambiguos, lentos, invertidos, cancelados, con varios dedos o iniciados en el borde del sistema. El zoom de la página conserva sus gestos. Cambiar de ruta, cuenta, dispositivo, visibilidad o foco invalida el intento pendiente. Después de esperar el cierre de una fila se comprueba de nuevo la ruta y la cuenta, para que un evento tardío no navegue en otra sesión.

La mejora reutiliza el único RouterOutlet existente: no mantiene cinco vistas, conexiones ni copias de los datos abiertas en paralelo. Las pantallas mantienen su carga habitual al entrar. Los gestos horizontales dentro de una conversación y el acordeón vertical de historias conservan sus manejadores existentes.

## Cambio de icono sin cerrar la pantalla Android

Antes, los tres aliases del launcher apuntaban directamente a `MainActivity`. Al elegir el icono de otra cuenta se deshabilitaba el alias que podía identificar la tarea abierta. El indicador `DONT_KILL_APP` pide conservar el proceso, pero el alias seguía representando una entrada independiente para Android. Los [aliases de actividad](https://developer.android.com/guide/topics/manifest/activity-alias-element) y la [identidad y pila de las tareas](https://developer.android.com/guide/components/activities/tasks-and-back-stack) son mecanismos distintos de la sesión guardada de Nivra.

Los nombres de los tres aliases y sus preferencias se conservan. Ahora apuntan a una entrada temporal, sin interfaz, sin historial y con afinidad vacía. Ésta abre o reutiliza la actividad principal con un Intent explícito nuevo y termina inmediatamente. La tarea de la WebView queda identificada por la actividad estable, independientemente del icono sustituible. No se reinicia la WebView ni se programa una limpieza al salir de la app; se mantienen la selección atómica de icono y `DONT_KILL_APP`.

La entrada no reenvía rutas, datos, extras, permisos URI ni flags aportados por quien abre el icono. Las notificaciones, llamadas, enlaces y archivos compartidos conservan sus entradas explícitas a `MainActivity`. El cierre de la entrada temporal también ocurre si el sistema rechaza el arranque, evitando dejar una actividad sin interfaz abierta.

## Doble toque para cambiar de cuenta

Con dos cuentas guardadas, el primer toque en Cuenta abre su pantalla inmediatamente. Un segundo toque en el mismo botón dentro de 350 ms cambia a la otra cuenta mediante el flujo de activación existente y abre sus Chats. El acceso por teclado conserva la navegación normal. El atajo se cancela al cambiar el contexto, perder el foco o abandonar la app, y no cambia de cuenta durante llamadas, bloqueo del Modo Seguro o una operación de cuentas.

## Aviso de historial pendiente

La fila de historial pendiente incluye una X para ocultarla durante 24 horas en Android, Windows y web. Es una preferencia de presentación por cuenta y dispositivo: se conserva al recargar, no cambia las llaves ni el estado de recuperación y no declara recuperados mensajes que siguen protegidos. El recordatorio reaparece al vencer el plazo o cambiar la identidad pública pendiente.

Sólo se puede ocultar una espera de historial con identidad válida y almacenamiento disponible. Los errores de conexión, almacenamiento, vinculación o identidad y las operaciones activas siguen visibles. Sincronizar conserva el acceso a los detalles incluso cuando la fila está oculta. El panel distingue el estado real de la visibilidad del aviso, evitando mostrar «Tus chats están al día» por haber pulsado la X.

## Entrega

No se añaden dependencias ni migraciones de datos. Estas mejoras del cliente son compatibles con la API 6.1.0; la API de esta entrega actualiza la identificación de versión y la metadata del APK.

## Validación

- **1.220 pruebas del cliente aprobadas**, incluidas **43 nuevas**: 19 de navegación, gestos y preferencias de animación, 14 de doble toque y 10 del aviso de historial. Las comprobaciones focales están incluidas en este total.
- Host de prueba con Router y eventos Touch reales: cinco pestañas, extremos sin salto circular, rutas profundas excluidas, filtros, cierre de fila asíncrono, fila Ionic real, pérdida de foco, cambio entre cuentas y eventos tardíos.
- Controles de edición y multimedia, zonas horizontales, modales, zoom, varios dedos, inversión, cancelación y prevención del clic posterior al barrido comprobados.
- Suite final sin errores de consola nuevos. Los estados de overlays se prueban sin presentar modales reales de la app; el control de fila Ionic sí conserva sus métodos reales.
- Atajo comprobado con Router real, dos perfiles aislados, primera pulsación inmediata, retorno a Chats, rechazo de eventos tardíos, ráfagas triples, teclado, llamadas, bloqueo y limpieza de listeners.
- Aviso comprobado al recargar y cambiar cuenta, dispositivo o huella, vencimiento exacto de 24 horas, almacenamiento denegado o malformado, aparición de errores activos y apertura inicial de una cuenta vacía.
- **58 pruebas JVM Android**, **75 comprobaciones Node** y **20 comprobaciones del feed de actualización** aprobadas. El manifiesto compilado del APK conserva los tres aliases y su entrada transitoria privada hacia `MainActivity` estable.
- Compilación de la API en Release: **cero errores y advertencias**. Compilación web de producción aprobada; conserva las advertencias previas de presupuesto de tamaño y la cadena opcional del aviso de historial.

La comprobación del gesto se realizó en Chrome con controles Ionic y cuentas de prueba aisladas; no se utilizaron cuentas del usuario ni se inició otra sesión de emulador en esta entrega. Las pruebas y contratos nativos comprueban el relevo de actividades y el manifiesto, pero no sustituyen la confirmación del comportamiento del launcher en el modelo físico del usuario.
