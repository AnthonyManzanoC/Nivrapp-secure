# Activar el respaldo de Nivra 2.1.0 en tus dos Render

Primaria: `https://nivra-webapp-secure.onrender.com`. Respaldo: `https://nivrapp-secure.onrender.com`.

La versión 2.1.0 puede funcionar en modo de una sola API durante la preparación. No activar `MultiInstance__Enabled=true` hasta completar Redis, S3 y firma durable compartidos: la API rechaza una configuración incompleta para evitar pérdida de eventos o archivos. El hotfix de readiness agrega `apiFailoverReady` para recuperar mensajes aunque queden credenciales push pendientes, y conserva `multiInstanceReady` como estado completo incluyendo push.

## 1. Preparar un Redis accesible desde ambas cuentas

Utilizar **un mismo Redis TCP** al que puedan conectarse los dos servicios, preferiblemente con TLS. Una dirección privada accesible únicamente desde la primera cuenta no sirve al segundo servicio. El proveedor debe admitir conexiones persistentes, pub/sub para SignalR, comandos Redis normales, TTL y scripts Lua. Una API REST de almacenamiento no sustituye la conexión Redis usada aquí.

Obtener del panel del proveedor el host, puerto, contraseña y, si utiliza ACL, usuario. Guardarlos exclusivamente en las variables de los dos servicios. No compartirlos en un chat ni subirlos a Git. Revisar límites de conexiones, memoria y pub/sub del plan; Redis debe permanecer disponible para ambos nodos.

## 2. Configurar las variables en ambos servicios

Añadir estos mismos valores en Environment de cada Render; los textos entre `<…>` son marcadores que se reemplazan en su panel:

```text
MultiInstance__Enabled=true
MultiInstance__Namespace=nivra
ConnectionStrings__RealtimeRedis=<host>:<puerto>,password=<contraseña>,ssl=true,abortConnect=false,connectTimeout=10000,syncTimeout=5000
```

Si el proveedor exige un usuario Redis, agregar `user=<usuario>` a la cadena. StackExchange.Redis utiliza el formato anterior; no pegar directamente una URL `rediss://`. Cuando TLS esté disponible, usar `ssl=true` y conservar la validación de certificados.

### Redis Cloud Free sin TLS: corrección del 11 de octubre

El plan Free de Redis Cloud Essentials [no ofrece TLS](https://redis.io/docs/latest/operate/rc/security/database-security/tls-ssl/). El hotfix posterior al tag 2.1.0 en `main` respeta `ssl=false` también en producción y elimina la excepción `Multi-instance Redis must use TLS in production`. No modifica las otras comprobaciones del cluster.

Para ese plan, configurar en ambos Render:

```text
ConnectionStrings__RealtimeRedis=<host>:<puerto>,user=default,password=<contraseña-nueva>,ssl=false,abortConnect=false,connectTimeout=10000,syncTimeout=5000
```

La contraseña y el tráfico Redis viajan sin cifrado de transporte en este modo. Limitar el acceso de red a los servicios autorizados cuando el proveedor lo permita. Cambiar cualquier contraseña compartida fuera del panel; nunca guardarla en el repositorio. La web y el APK siguen conectándose a las APIs por HTTPS, pero eso no cifra el enlace de la API a Redis.

En el Manual Deploy elegir el último commit de `main` que contiene este hotfix; volver a desplegar el tag original 2.1.0 conserva la excepción anterior.

Conservar en ambos los valores que ya comparten: PostgreSQL/Supabase, clave de firma de sesiones, S3, LiveKit y claves Web Push. Comprobar además:

```text
Push__Enabled=true
Push__Provider=Fcm
Push__Fcm__ProjectId=nivra-af67e
```

Las credenciales FCM deben estar disponibles y ser válidas en **cada** servicio mediante una fuente admitida por la API, por ejemplo `Push__Fcm__ServiceAccountPath`. No alcanza con copiar el nombre de una ruta si el archivo no existe en el segundo host. En la comprobación previa, la secundaria informó FCM desactivado: revisar este punto aunque el resto de variables coincida.

Si ya se añadieron credenciales pero `pushFcmReady` sigue en `false`, comprobar en Render que el despliegue recibió `Push__Enabled=true`, `Push__Provider=Fcm` y que el secret file existe y puede leerse en la ruta exacta configurada, por ejemplo `/etc/secrets/firebase-key.json`. Debe ser una cuenta de servicio de Firebase con `client_email`, `private_key` PEM válida y proyecto correcto; el JSON de configuración del cliente Android no sustituye esa cuenta. La API da prioridad a `ServiceAccountJson`, después `ServiceAccountJsonBase64` y finalmente `ServiceAccountPath`: eliminar una fuente inline/base64 antigua si se pretende usar el archivo. Revisar en los logs la causa de `FCM could not be configured`, sin compartir el JSON ni la clave privada. `pushWebReady=true` sólo confirma configuración Web Push y también indica que el switch general de push está activo.

Para límites de autenticación por IP detrás de un proxy, usar exclusivamente saltos IP/CIDR verificados en `ReverseProxy__KnownProxies__0` o `ReverseProxy__KnownNetworks__0`, con `ReverseProxy__Enabled=true`. No usar redes universales ni valores inventados. Sin esos datos, conservar el modo sin confianza en cabeceras reenviadas; la IP anónima puede agrupar usuarios detrás del proxy. El límite por usuario autenticado sigue compartido.

## 3. Hacer Manual Deploy en los dos servicios

Elegir el mismo commit de `main` que incluye el hotfix sin bloqueo TLS en ambos. Esperar a que cada despliegue termine correctamente. No rotar la clave de firma ni crear otra base/bucket para el respaldo. Esta versión no necesita una migración nueva de base de datos para varias APIs.

## 4. Comprobar la activación

Desde la carpeta del proyecto:

```powershell
./tools/check-api-cluster.ps1
```

Un resultado `Core cluster compatible` con salida 0 confirma que todos los nodos tienen core readiness, la misma huella, protocolos compatibles y PostgreSQL, configuración de almacenamiento compartido, Redis y firma durable preparados. Se acepta `apiFailoverReady=true`; una API 2.1 anterior sin ese campo sólo se acepta si informa `status=ok` y S3/Redis/firma explícitamente listos. Un campo presente `false`, `null` o de otro tipo nunca permite ese fallback. Los avisos de FCM/Web Push indican notificaciones pendientes; no impiden usar el servicio de mensajes, pero salida 0 no confirma entrega push. `multiInstanceReady` conserva la exigencia de proyecto FCM y ambos transportes configurados. Corregir las credenciales en cada servicio y probar notificaciones reales por separado.

El diagnóstico no envía credenciales ni cambia variables. Si aparece `Core cluster not ready`, corregir el campo que falta; un timeout también puede significar un arranque frío. Sin pin esperado, una primaria caída produce salida 2 porque no pudo verificarse el conjunto completo. Nunca aprender confianza del respaldo únicamente porque la primaria no responde.

Para comprobar la recuperación operacional de los clientes 2.1.1 con el pin público ya publicado, usar:

```powershell
./tools/check-api-cluster.ps1 -ExpectedClusterFingerprint c761492c31e3e9346640c94da63c476eea907d2aad8a26b6d830c60cd5d7fc64
```

Este modo devuelve `Operational failover available` y salida 0 si al menos un origen configurado está core-ready, admite el protocolo y coincide exactamente con el pin esperado. Una primaria con 503 y una secundaria compatible pueden cumplirlo. Los demás orígenes se excluyen con advertencias; el resultado confirma disponibilidad operacional contra una referencia previa, sin confirmar salud de todos los nodos ni alta disponibilidad completa. Si ningún origen cumple, devuelve salida 2. El parámetro requiere 64 caracteres hexadecimales en minúsculas y no modifica el pin de ninguna aplicación. Usar únicamente una huella obtenida de una configuración verificada o del cliente publicado; nunca copiar una nueva desde el respaldo para hacer pasar el diagnóstico.

Los clientes 2.1.1 ya incluyen la huella pública verificada en `apiClusterFingerprint` y en Android: pueden seleccionar el respaldo desde una instalación nueva aunque la primaria esté caída. Los clientes anteriores que exigen `multiInstanceReady` o carecen de esa referencia necesitan actualizarse. Las operaciones de escritura cuya respuesta se perdió no se repiten a ciegas. Ver [la corrección 2.1.1 y sus pruebas](release-2.1.1.md).

Si la primaria agotó su cuota antes de que los clientes aprendieran la huella, desplegar este hotfix en la secundaria corrige el arranque del servidor pero no cambia por sí solo la confianza guardada del cliente. Hace falta recuperar la primaria para aprenderla o publicar clientes con la huella obtenida de una configuración compartida verificada. No usar una huella inventada ni interpretar el timeout de la primaria como confirmación de compatibilidad.

Este hotfix conserva la huella de la configuración existente. Si se rotan proyecto FCM, claves Web Push, firma u otro alcance incluido en ella, verificar el nuevo pin común y coordinar despliegue de ambos servidores y publicación de clientes con pin compilado. Cambiar sólo el archivo de credenciales FCM del mismo proyecto no cambia el pin. No cambiar el alcance de la secundaria mientras clientes publicados siguen fijados al anterior.

## Tráfico y servidores futuros

El acceso S3 temporal para adjuntos normales evita transportar sus bytes cifrados por Render cuando el CORS del almacenamiento lo permite. Configurar GET/HEAD desde los orígenes de la web/WebView y comprobar una descarga propia. Si no está disponible, el cliente conserva el proxy autorizado. Historias de una sola vista, mensajes eliminados al leer y archivos de bóveda conservan ese proxy.

Añadir servicios futuros requiere incluir sus orígenes exactos en el registro del cliente y su shell nativo, compartir las mismas dependencias y repetir el diagnóstico. Redis/PostgreSQL/S3 siguen siendo dependencias comunes. Un servicio gratuito dormido puede tardar en arrancar; varios servicios gratuitos no garantizan capacidad ilimitada ni llamadas sin cortes. Ver [arquitectura y limitaciones](multi-instance-api-2.1.0.md) y [condiciones de Render Free](https://render.com/docs/free).
