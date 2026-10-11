# Nivra 2.1.0: APIs compartidas y menor tráfico en Render

El cliente permite elegir otro origen autorizado cuando la API activa falla. Compartir sólo el código y la base de datos no bastaba: SignalR, presencia, QR de vinculación y configuración del primer alias por teléfono estaban en memoria de cada proceso. Un contacto conectado al otro servicio podía perder señales, y un QR creado en un servidor podía no existir en el otro.

La implementación nueva agrega el backplane oficial Redis de SignalR y estado temporal compartido para esos flujos. No crea cuentas ni proveedores, no copia mensajes sin cifrar y no modifica las claves de cifrado del usuario. El modo de una sola API sigue siendo válido sin Redis.

## Configuración para los dos servicios

En ambos servicios desplegar el mismo commit actual de `main` (corrección 2.1.1), la misma base PostgreSQL, configuración S3, clave de firma existente, LiveKit, proyecto FCM y claves Web Push. Los secretos se introducen en las variables/secret files de Render, nunca en Git. La comprobación pública del 11 de octubre encontró la secundaria con FCM desactivado aunque PostgreSQL, Redis, S3 y firma estaban preparados; `pushWebReady=true` no demuestra que Android pueda recibir FCM.

Además configurar en ambos:

| Variable | Valor/configuración |
| --- | --- |
| `MultiInstance__Enabled` | `true` |
| `ConnectionStrings__RealtimeRedis` | El mismo Redis accesible a los dos servicios; formato StackExchange.Redis `host:puerto,password=…,ssl=true`. Se recomienda TLS. El hotfix posterior a 2.1.0 permite `ssl=false` si el proveedor no ofrece TLS; ver riesgos y configuración en la guía. No es una URL `rediss://`. |
| `MultiInstance__Namespace` | El mismo nombre de aplicación, por ejemplo `nivra`; permite separar despliegues que comparten Redis. |
| `Security__TokenSigningKey` | La misma clave durable existente, con al menos 32 caracteres. Una rotación de esta clave necesita un plan: invalida sesiones y cambia la protección de tokens push. |
| `Storage__Provider` | `S3` o `SupabaseS3`, con endpoint HTTPS, bucket y credenciales completos. Nunca almacenamiento local entre hosts. |
| `Push__Enabled` | `true` |
| `Push__Fcm__ProjectId` | El mismo proyecto explícito que reciben los APK. No dejarlo vacío en modo de varias instancias. |
| `Push__Fcm__ServiceAccountPath` u otra fuente admitida | Credenciales válidas del mismo proyecto en cada host. |
| `Push__WebPush__PublicKey` / `PrivateKey` | Las mismas claves VAPID válidas en ambos hosts. |

`MultiInstance__Enabled=true` rechaza el arranque si falta Redis, almacenamiento compartido o una clave de firma durable. El tag original 2.1.0 también rechaza Redis sin TLS en producción; el hotfix del 11 de octubre en `main` elimina únicamente ese bloqueo y respeta la configuración `ssl`. No hace un fallback silencioso a archivos locales. No hay migraciones nuevas para esta arquitectura.

## Cómo se acepta una API de respaldo

`GET /health/ready` devuelve `version`, `callProtocol`, `minimumCallProtocol`, `failoverProtocol=1`, `clusterFingerprint`, `apiFailoverReady` y `multiInstanceReady`. También conserva `pushFcmReady` / `pushWebReady`, `push: { fcm, webPush }`, `sharedStorageReady`, `realtimeSharedReady`, `durableSigningKeyReady` y `pushProjectConfigured`.

La huella es un HMAC, ligado a la clave de firma, sobre el alcance de PostgreSQL, S3, Redis, LiveKit y push. No publica credenciales. Dos servidores de bases diferentes, buckets diferentes, proyectos FCM diferentes o claves de firma diferentes no se aceptan como el mismo cluster. Es un control de compatibilidad sobre configuración confiable, no reemplaza la validación TLS del origen ni la verificación de identidad de los contactos.

`apiFailoverReady=true` exige modo de varias instancias activo, conexión a PostgreSQL, un PING Redis reciente, almacenamiento S3 compartido configurado, clave durable y huella disponible. `sharedStorageReady` verifica la configuración y el proveedor; no es una prueba de lectura/escritura de objetos S3. La ausencia de FCM o Web Push no bloquea el servicio de mensajes y por eso no bloquea este campo. `multiInstanceReady=true` conserva el contrato completo: además exige proyecto FCM explícito y FCM/Web Push configurados. Los indicadores push describen configuración, sin garantizar entrega a un dispositivo.

Los clientes 2.1.1 que admiten core readiness pueden recuperar el servicio de mensajes con `multiInstanceReady=false`; los clientes antiguos que exigen el campo completo necesitan su actualización o completar push. Una API 2.1 sin `apiFailoverReady` permite un fallback estricto sólo si `status=ok` y S3/Redis/firma son explícitamente `true`, con protocolo y pin compatibles. Si el campo nuevo existe como `false`, `null` o de otro tipo, ese fallback no se aplica. Cada cliente compara la huella con una referencia confiable antes de enviar credenciales al respaldo; una secundaria no se convierte en fuente de confianza por ser el único host que responde. El resultado se puede revisar con:

```powershell
./tools/check-api-cluster.ps1
```

Sin parámetros, el diagnóstico devuelve `Core cluster compatible` y salida 0 si todos los hosts tienen el servicio API preparado, protocolos compatibles y la misma huella. Emite advertencias por las configuraciones push pendientes y conserva visible `multiInstanceReady`; salida 0 no confirma notificaciones de fondo. Un host inaccesible o core readiness incompleta producen salida 2. Con la primaria caída, este modo no puede demostrar por sí solo la compatibilidad de ambos hosts, aunque la secundaria esté sana.

Para disponibilidad operacional contra el pin público ya publicado en los clientes 2.1.1:

```powershell
./tools/check-api-cluster.ps1 -ExpectedClusterFingerprint c761492c31e3e9346640c94da63c476eea907d2aad8a26b6d830c60cd5d7fc64
```

`Operational failover available` y salida 0 requieren al menos un origen core-ready con protocolo compatible y coincidencia exacta con ese pin previo. Los hosts caídos o incompatibles se excluyen con advertencias; el resultado no confirma que todos estén sanos ni garantiza alta disponibilidad. No se establece una nueva referencia a partir del host que responde: el pin esperado debe proceder del alcance previamente verificado o del cliente publicado. El parámetro no cambia la configuración de los clientes.

Este diagnóstico sólo consulta salud pública. No envía tokens, no cambia variables ni genera carga sobre las cuentas. Añadir más hosts requiere agregarlos al registro confiable del cliente, desplegar la misma versión y verificar la misma huella; no se aceptan URLs arbitrarias recibidas de un mensaje o parámetro de navegación.

En un dispositivo que ya consultó la primaria, el cliente conserva la huella de compatibilidad para recuperar la API aunque la primaria esté caída al abrir de nuevo. Para una instalación completamente nueva con la primaria ya caída, el operador puede fijar `apiClusterFingerprint` en `nivra-app/src/environments/environment.prod.ts` con la huella de 64 caracteres obtenida y comparada previamente mediante este diagnóstico, y volver a compilar el cliente. No se debe copiar una huella de un respaldo sin verificar antes ambas configuraciones. El valor vacío mantiene la necesidad de consultar primero la primaria; la huella pública no contiene un secreto.

Separar readiness de push no cambia el cálculo de la huella existente. Reparar el archivo de credenciales FCM manteniendo el mismo proyecto no cambia ese alcance, pero cambiar el proyecto FCM, las claves Web Push, la clave de firma o cualquier otra configuración incluida en la huella sí lo cambia. Una rotación requiere coordinar ambos servidores y actualizar los clientes con pin compilado; no basta con rotar la secundaria mientras la primaria está caída. Verificar previamente el nuevo alcance común y preparar la publicación de clientes antes del cambio. Nunca aceptar automáticamente un pin distinto recibido del respaldo.

Si `pushFcmReady=false`, quedan pendientes las notificaciones Android en segundo plano por ese transporte; `pushWebReady=true` no corrige esa carencia. Revisar las credenciales/proyecto en cada host y probar recepción real en dispositivos después de corregirlo. La recuperación del API permite consultar el estado persistido y reconstruir SignalR al abrir o reconectar la aplicación, sin afirmar que se recibió una notificación de fondo.

## Estado compartido y seguridad

Redis distribuye eventos a clientes SignalR conectados a servidores distintos. El cliente mantiene cada conexión en el origen escogido; después de cambiar de API reconstruye conexión/suscripciones y consulta el estado persistido. Una desconexión no convierte una llamada o mensaje incierto en una operación segura de repetir: no se reintentan automáticamente mutaciones genéricas para evitar duplicar grupos, llamadas, mensajes o cambios de cuenta.

Los QR y resultados de autorización almacenados en Redis van cifrados con AES-GCM, una subclave derivada de la clave de firma, nonce aleatorio y un propósito específico. Vencen al minuto, y las credenciales entregables desaparecen a los 30 segundos de autorizar. Una concesión compartida y una comparación/intercambio atómica impiden que dos hosts emitan sesiones simultáneamente para el mismo QR. Los OTP antiguos son de desarrollo; Firebase Phone Auth sigue siendo el camino de producción. El estado temporal de completar el primer alias también se comparte.

La presencia usa concesiones de 90 segundos, renovadas cada 30, para que un proceso que cae no deje usuarios permanentemente conectados. La rotación de refresh tokens se serializa con un bloqueo transaccional PostgreSQL por hash del token; un fallo de commit no provoca repetición automática. Los destinos push ya usan bloqueos transaccionales y propiedad usuario/dispositivo.

La finalización del primer alias por teléfono usa un bloqueo PostgreSQL por usuario, vuelve a comprobar el token y lee `RequiresAlias` después del bloqueo. Alias, dispositivo y sesión se confirman en una misma transacción antes de consumir el token o notificar a los contactos. Dos peticiones simultáneas con el mismo token no emiten dos sesiones; la comprobación de base de datos valida ese patrón con ocho conexiones y un estado de cuenta simulado, sin escribir cuentas reales.

Las vistas, reacciones y respuestas de historias usan un mismo bloqueo transaccional PostgreSQL por historia antes de cargar su registro. Así, dos API no leen una lista JSON antigua y luego sobrescriben la actividad del otro participante. El commit ocurre antes del evento SignalR; una historia de una vista se vuelve a comprobar bajo el bloqueo. La comprobación de base de datos reproduce ocho modificaciones de snapshots locales usando ocho sesiones y bloqueos PostgreSQL reales, sin escribir historias ni usuarios de producción.

Las rutas de autenticación comparten un contador Redis atómico de 20 solicitudes por minuto por usuario autenticado o IP de conexión anónima. Usa el reloj de Redis, devuelve `429` con `Retry-After` al llegar al límite y falla con `503` si el contador compartido no está disponible. Cambiar de API no concede otra cuota. Los límites generales/de uploads siguen por proceso; una instalación pública grande puede necesitar además límites de recursos en un gateway. No se confía en cabeceras `X-Forwarded-For` enviadas por el cliente para evitar falsificar el alcance. Redis, PostgreSQL, S3 y FCM siguen siendo dependencias compartidas: varios procesos no eliminan una caída de esos servicios.

Detrás de un proxy, configurar `ReverseProxy__Enabled=true` junto con una lista real y comprobada de `ReverseProxy__KnownProxies__0`, etc., o `ReverseProxy__KnownNetworks__0` en CIDR. `ReverseProxy__ForwardLimit` permite entre 1 y 4 saltos; cada salto debe corresponder a un proxy de confianza. Sin esta configuración se usa la IP de la conexión, que podría ser la del proxy y agrupar varios usuarios. No activar el modo con una lista vacía, `0.0.0.0/0` o `::/0`; esos valores se rechazan. No se habilita confianza universal para facilitar Render: el operador debe verificar sus hops/IPs. Esta configuración se aplica antes de la autenticación y de los contadores.

## Ahorro de tráfico y memoria

Antes, cada descarga desde S3 entraba a la API y volvía a salir por Render; el fallback también copiaba el objeto completo a memoria antes de responder. Ahora `GET /files/{id}/download-access` y `GET /stories/{id}/media-access` pueden devolver acceso GET firmado al objeto cifrado, con `url`, `expiresAt`, `encryptedSize` y `contentType=application/octet-stream`.

El acceso dura como máximo 60 segundos y nunca más que el archivo. Se comprueba el permiso y estado antes de emitirlo, se desactiva la caché HTTP y sólo se generan URLs HTTPS del host S3 configurado. El cliente descarga sin token API, cookies ni referente; valida tamaño, descifra localmente y usa el camino anterior si el proveedor/CORS no soporta la descarga directa. Los buckets siguen privados y las claves de cifrado no llegan al servidor. La URL firmada es una capacidad temporal: no se debe registrar ni compartir; la revocación posterior del permiso no revoca por sí sola una URL ya emitida hasta su vencimiento, salvo que el objeto se elimine.

El fallback sirve un stream del objeto, conservando y liberando la respuesta S3, en lugar de reservar hasta 256 MB por descarga. Las descargas directas reducen el egreso de Render; el tráfico y las cuotas de S3/Supabase continúan existiendo.

Las historias de una sola vista, archivos de mensajes que se eliminan al leer y archivos de salas de bóveda permanecen en la descarga por API para conservar el control de acceso revocable de esos flujos.

## Validación y límites operativos

`checks/Nivra.InfrastructureChecks` cubre readiness del API sin FCM, rechazo sin PostgreSQL/Redis/S3/firma durable, readiness completa de push, pin de configuración, configuración incompleta, cifrado y manipulación de estado, QR entre dos instancias lógicas, exclusión de scans simultáneos, expiración, OTP/alias compartidos, URLs de descarga y liberación del stream. `checks/check-api-cluster.tests.ps1` usa respuestas de salud simuladas para comprobar salida 0 con advertencias push, recuperación operacional con primaria 503 y pin esperado, fallback legacy estricto y salida 2 con dependencias, protocolos o huellas incompatibles. No usan cuentas reales ni modifican producción. La conexión y entrega real a través de Redis requieren una prueba adicional con un Redis local o un entorno de staging configurado; no se han usado credenciales de producción para simular fallos.

Render Free suspende servicios al agotar el egreso sin un medio de pago y puede dormir una API inactiva; el arranque frío puede tardar aproximadamente un minuto. Una API de respaldo dormida no asegura un cambio instantáneo. Render también limita tráfico iniciado hacia bases y otros proveedores, y no ofrece escalado de varias instancias dentro de un servicio Free. El modo de respaldo mantiene la aplicación recuperable cuando existe otro origen sano, pero no promete capacidad infinita, llamadas sin ningún corte ni continuidad si todos los proveedores están fuera de servicio.

Referencias: [Render Free](https://render.com/docs/free), [SignalR en producción](https://learn.microsoft.com/en-us/aspnet/core/signalr/scale?view=aspnetcore-9.0), [backplane Redis oficial](https://learn.microsoft.com/en-us/aspnet/core/signalr/redis-backplane?view=aspnetcore-9.0), [URLs S3 firmadas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [compatibilidad S3 de Supabase](https://supabase.com/docs/guides/storage/s3/compatibility).

Se fija MessagePack 2.5.303 para mantener compatibilidad con el backplane 9.x y corregir las vulnerabilidades de su dependencia transitiva anterior. [Versión de seguridad oficial](https://github.com/MessagePack-CSharp/MessagePack-CSharp/releases/tag/v2.5.303), [aviso que también afectaba 2.5.302](https://github.com/MessagePack-CSharp/MessagePack-CSharp/security/advisories/GHSA-qhrr-8q5h-9q3h).
