# Nivra 1.2.0

Android versionCode 9. Protocolo de llamadas 2, sin cambios respecto a 1.1.2.

- Ajustes visuales de acceso y superficies principales, foco accesible y controles de audio etiquetados.
- Centro de grupos con búsqueda y filtro de grupos donde publican administradores; no son canales públicos ni comunidades de varios grupos.
- Invitaciones de grupo con tokens aleatorios, hash almacenado, caducidad de 24 horas, límite de usos y revocación. Compartir usa la mensajería cifrada existente.
- Comparación de identidad por código/imagen QR en chats directos, persistencia de llaves observadas y bloqueo saliente ante cambios. No se presenta primera observación como identidad verificada.

## Despliegue

Incluye la migración aditiva `20261003163236_GroupInviteLinks`. El backend la aplica durante el arranque. La compilación y las pruebas offline no prueban una migración contra PostgreSQL real ni dos aceptaciones concurrentes en una base de ensayo. Comprobar logs de despliegue antes de probar invitaciones en las aplicaciones actualizadas.

APK de depuración firmado para pruebas, no un AAB firmado para tienda. Windows portable: conservar todo el contenido del ZIP junto a Nivra.exe; no es un instalador y no tiene firma Authenticode. Los paquetes utilizan la API de producción configurada.

CoTURN, MLS y el prototipo libsignal permanecen en `feature/coturn-futuro` y no forman parte de esta versión. Sealed Sender no está activo. No se anuncia equivalencia criptográfica con Signal.

Validación de software: compilación Angular de producción, pruebas Angular y comprobaciones C#; siguen presentes advertencias de tamaño del bundle y estilos. Las pruebas físicas de llamadas y la validación de cuentas reales son independientes.
