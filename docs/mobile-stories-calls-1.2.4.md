# Nivra 1.2.4: historias y recuperación de llamadas

Android `versionCode` 13. Esta versión corrige el avance duplicado del visor de historias, conserva el sobre cifrado de sesión ante fallos temporales del Android Keystore y añade una recuperación manual de llamadas que el servidor aún mantiene activas.

Al abrir una historia de otra persona, el visor reproduce primero todas las historias no vistas de ese anillo. Cuando ya no hay nuevas, permite volver a reproducir el conjunto completo. El temporizador se detiene antes de cada transición asíncrona para que un retraso al registrar una vista no salte historias ni cierre el visor.

Al quitar la app de recientes, Android ya no detiene por código el servicio de primer plano de una llamada. Si el proceso de la interfaz se reinicia, Nivra conserva localmente el identificador de la llamada por cuenta, consulta al servidor y ofrece **Continuar aquí**; el usuario confirma el traslado y no se reclama la llamada automáticamente desde otro dispositivo. El aviso persistente de llamada abre la pantalla de llamadas.

Una app híbrida no puede garantizar que una llamada WebRTC siga conectada si Android termina su proceso o el sistema revoca micrófono/red en segundo plano. HONOR puede detener el proceso al quitarlo de recientes según sus ajustes de inicio y batería; la recuperación permite volver a una llamada aún vigente, pero las llamadas deben validarse en un HONOR 90 físico para confirmar el comportamiento del sistema.

La restauración de sesión hace reintentos breves y ya no elimina el sobre cifrado cuando el Keystore o el puente nativo fallan temporalmente. La sesión sigue protegida; si la clave del Keystore fue eliminada o invalidada de forma permanente, el contenido cifrado no se puede recuperar y se requiere iniciar sesión de nuevo.
