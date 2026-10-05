# Nivra 1.2.3: video, recepción nativa y juegos

- Al finalizar la negociación WebRTC, la vista se reconstruye con las pistas actuales de los receptores, incluidas las de transceptores reutilizados. Ya no depende exclusivamente de un segundo evento `ontrack` durante el cambio de voz a video.
- Android comprueba si la actividad está realmente reanudada. La importancia del proceso no es una prueba de que el usuario esté dentro de Nivra: la propia entrega FCM puede elevarla. Se conservan las notificaciones nativas incluso si la interfaz JavaScript está cerrada. Los eventos de finalización de llamada limpian el aviso también con la actividad visible.
- Se mantiene el bloqueo de inicialización push hasta completar el trabajo asíncrono nativo y se renueva el registro al regresar, como máximo cada cinco minutos. Esto reutiliza la sesión autenticada existente.
- Cinco juegos: tres en raya, cuatro en línea, cálculo, cinco en línea (8×8) y la última ficha (21 fichas, retirar de 1 a 3, gana la última). Los dos nuevos usan el mismo coordinador, validación de turnos, revisiones y revancha. Actualizar ambos participantes para utilizar el nuevo catálogo.

## Límites y comprobación real
No se ha reproducido aún el fallo en el teléfono del usuario. Estos cambios corrigen rutas concretas de código, pero no prueban que todos los casos de entrega tardía queden resueltos. Revisar con dos teléfonos: voz → cámaras en ambos órdenes, bloquear pantalla, dejar 15/30/60 minutos en segundo plano y recibir llamadas/mensajes sin abrir Nivra. Registrar si Android destruye el proceso o si FCM no llega; son problemas distintos.

La app conserva Capacitor y módulos Android nativos. Una migración de todas las pantallas a Kotlin no resuelve por sí misma restricciones de batería, fuerza de detención o entrega FCM. CoTURN sigue aplazado.

Referencia oficial: https://firebase.google.com/docs/cloud-messaging/android-message-priority explica la entrega de alta prioridad y su posible reducción cuando no produce avisos visibles. No se ha confirmado reducción de prioridad en este dispositivo.

Validación automatizada: 113 pruebas Angular correctas, incluidas recuperación de pistas desde receptores sin un nuevo ontrack, victoria diagonal, bordes del tablero y rechazo de retiradas ilegales. No había dispositivos físicos conectados por ADB.
