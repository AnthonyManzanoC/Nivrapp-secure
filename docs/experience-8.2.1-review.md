# Nivra 8.2.1: llamadas, interacción y seguridad

Revisión del 2 de noviembre de 2026 sobre la versión publicada 8.2.0.

## Cambios

- El historial de llamadas permite filtrar todas, perdidas o video y buscar sin distinguir tildes. Presenta las más recientes primero, en bloques de 40, sin eliminar registros. Solo ofrece volver a unirse a una llamada activa sin fecha de finalización.
- La pantalla de voz/video identifica al contacto, distingue el estado de conexión y permite volver a Chats sin colgar. Los controles de voz permanecen visibles; en video no desaparecen durante el uso del teclado, solicitudes de cámara, juegos, avisos de error o elección de audio.
- Las llamadas iniciadas desde un contacto no continúan después de abandonar la vista o cambiar de cuenta/dispositivo/generación de sesión. Las respuestas tardías de invitación no modifican otra llamada ni vuelven a abrir ventanas cerradas.
- La agenda ordenada y el directorio de participantes se calculan al cambiar sus datos. Los eventos de reproducción no provocan una actualización general de la aplicación. Se retiran los eventos de pistas eliminadas sin detener la captura que pertenece a la llamada.
- Filtros, estados vacíos, búsquedas y botones mantienen colores del tema, foco visible y objetivos táctiles cómodos. Se elimina una doble vinculación del aviso de error de llamadas.
- La prueba nativa de privacidad comprueba el cambio mientras se muestra una llamada entrante, además de la recepción inicialmente privada.

## Alcance

TURN y Firebase por teléfono se conservan en pausa. No se cambia el protocolo criptográfico, las bases de datos ni las claves del historial. No se envían llamadas, SMS ni mensajes a cuentas reales durante las pruebas.

Los cambios de rendimiento usan las propiedades de [cálculo diferido y caché de Angular](https://angular.dev/guide/signals) y los eventos de [visibilidad del documento](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event). No se interrumpe el audio de una llamada al ocultar la interfaz.

## Validación

Resultados locales antes de publicar: 36 comprobaciones HTTP de seguridad, 85 pruebas Node, 125 comprobaciones del servidor de llamadas y 18 de límites de autenticación aprobadas. Análisis TypeScript y compilación de producción correctos. La auditoría de dependencias no presenta alertas altas/críticas; quedan avisos moderados de herramientas de desarrollo (4 raíz, 45 Angular y 5 escritorio), sin aplicar degradaciones de versión sugeridas por la corrección forzada.

La compilación mantiene advertencias de tamaño en estilos y paquete inicial; no se amplían presupuestos para ocultarlas. Las pruebas de UI, regresión completa y Android se registrarán con la revisión final. Las pruebas automatizadas no sustituyen llamadas con teléfonos físicos, redes restrictivas, fabricantes y ahorro de batería.
