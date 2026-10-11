# Nivra 2.1.1 — recuperación con la API primaria suspendida

Fecha: 11 de octubre de 2026. Android utiliza versionCode 23; el protocolo de llamadas permanece en 2.

## Corrección

Una instalación nueva no había aprendido la huella del cluster antes de que la primaria agotara su cuota. Además, el cliente anterior exigía FCM configurado para aceptar el respaldo aunque PostgreSQL, Redis, S3 y la firma compartida estuvieran listos. Publicar sólo el hotfix del servidor no modificaba esos clientes.

Web, Android y Windows 2.1.1 incluyen la huella pública de la instalación compartida confirmada por el operador: `c761492c31e3e9346640c94da63c476eea907d2aad8a26b6d830c60cd5d7fc64`. Antes del primer login, refresh o envío, el cliente comprueba la salud de los orígenes autorizados y selecciona el respaldo compatible. No aprende confianza de un servidor desconocido. El pin no contiene credenciales y no reemplaza HTTPS ni la verificación de identidad de contactos.

La preparación y recuperación concurrentes se agrupan. Se conservan pausas entre intentos, límites de tiempo y un máximo de tres candidatos por ronda. Un respaldo activo no se abandona sólo porque siga caída la primaria. Las lecturas seguras pueden repetirse una vez; las escrituras con respuesta incierta no se repiten automáticamente para evitar duplicados.

SignalR reconstruye la conexión al cambiar el origen, espera que termine un handshake anterior y cancela la reconexión si cambia la cuenta, el dispositivo o se cierra sesión. Un cierre tardío de la conexión anterior no cambia el estado de la nueva.

## API y notificaciones

`apiFailoverReady` comprueba PostgreSQL, Redis, almacenamiento compartido configurado y firma durable. FCM/Web Push se informan por separado; `multiInstanceReady` conserva la exigencia de ambas notificaciones configuradas. La API 2.1 anterior sólo se acepta cuando el campo nuevo está ausente, el estado es `ok` y los tres indicadores core son explícitamente verdaderos. Un campo nuevo `false`, `null` o inválido bloquea el respaldo.

El worker Android conserva la lista de orígenes y el pin, rechaza redirecciones, limita respuestas y comprueba el alcance de la sesión antes de renovar el token push. No marca FCM como preparado hasta recibir una confirmación válida del servidor.

La comprobación pública del 11 de octubre encontró la primaria en 503. La secundaria devolvió 2.1.0, PostgreSQL/Redis/S3/firma preparados y el pin esperado, pero `pushFcmReady=false`. El operador confirmó que configuró Firebase; la API publicada todavía no demuestra esa configuración. Mensajes y acceso pueden usar el respaldo sin esperar a FCM. Las llamadas entrantes con Android dormido necesitan FCM operativo y una comprobación física posterior al despliegue.

## Validación

| Comprobación | Resultado |
| --- | --- |
| Cliente Angular, Chrome Headless | 535 aprobadas |
| Android, JVM | 18 aprobadas |
| Windows, orígenes e IPC | 7 aprobadas |
| API, infraestructura | 66 aprobadas |
| API, metadata de actualización Android | 12 aprobadas |
| Diagnóstico de cluster, fixtures de fallos | 30 aprobadas |
| Compilación API Release | Sin errores ni advertencias |
| Web, APK y Windows | Compilación correcta; 1.421 archivos web idénticos verificados |
| APK | Firma v2 válida y certificado de la versión anterior |
| Pool del cliente con APIs publicadas | Seleccionó la secundaria con la primaria en 503; dos lecturas de salud, cero autenticaciones y cero escrituras |
| Diagnóstico operacional publicado | Salida 0: una API disponible con pin esperado; primaria excluida y FCM pendiente |

Las pruebas concurrentes incluyen veinte primeras escrituras sintéticas y cincuenta recuperaciones simultáneas; no enviaron mensajes a contactos reales. No se simularon fallos en las cuentas de Render ni se realizó una llamada física. La compilación web conserva el aviso de presupuesto inicial: 3,01 MB y 609,14 kB de transferencia estimada. No se cambió el presupuesto para ocultarlo. Las auditorías de dependencias de 2.1.0 siguen documentadas en [seguridad y rendimiento](security-performance-2.1.0.md); esta corrección no agrega dependencias.

## Activación

1. Recargar la web publicada para obtener 2.1.1. El APK y Windows deben actualizarse con los paquetes 2.1.1; un cliente anterior no incorpora el nuevo pin por actualizar únicamente Render. El APK conserva el certificado anterior.
2. Hacer **Manual Deploy del último commit de `main`** en la secundaria. El nuevo cliente ya admite el servidor 2.1 anterior con core preparado; el despliegue publica la metadata del APK 2.1.1 y `apiFailoverReady`.
3. Conservar las dependencias compartidas y revisar Firebase según la [guía de Render](render-failover-setup-2.1.0.md), especialmente el secret file y la prioridad de fuentes de credenciales. No compartir el JSON ni claves privadas.
4. Cuando Render permita recuperar la primaria, desplegar el mismo commit allí.

Para comprobar disponibilidad durante la caída:

```powershell
./tools/check-api-cluster.ps1 -ExpectedClusterFingerprint c761492c31e3e9346640c94da63c476eea907d2aad8a26b6d830c60cd5d7fc64
```

Salida 0 confirma al menos un origen compatible disponible. Sin ese parámetro, el diagnóstico exige todos los nodos listos. Ninguna comprobación demuestra entrega push a un teléfono.

Los paquetes y sus SHA-256 se publican en [la versión 2.1.1](https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/tag/v2.1.1). Más APIs se incorporan al registro explícito de web y shells, con las mismas dependencias y el mismo pin; no se reciben orígenes arbitrarios desde mensajes o parámetros. Cambiar el alcance del cluster exige coordinar nuevos pins y clientes. Redis/PostgreSQL/S3 y sus cuotas siguen siendo dependencias comunes; servicios gratuitos adicionales no garantizan capacidad ilimitada ni llamadas sin cortes.
