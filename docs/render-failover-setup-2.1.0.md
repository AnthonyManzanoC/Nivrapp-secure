# Activar el respaldo de Nivra 2.1.0 en tus dos Render

Primaria: `https://nivra-webapp-secure.onrender.com`. Respaldo: `https://nivrapp-secure.onrender.com`.

Todavía no hay un Redis compartido configurado. La versión 2.1.0 puede funcionar en modo de una sola API durante la preparación. No activar `MultiInstance__Enabled=true` hasta completar las dependencias: la API rechaza una configuración incompleta para evitar pérdida de eventos o archivos.

## 1. Preparar un Redis accesible desde ambas cuentas

Utilizar **un mismo Redis TCP con TLS** al que puedan conectarse los dos servicios. Una dirección privada accesible únicamente desde la primera cuenta no sirve al segundo servicio. El proveedor debe admitir conexiones persistentes, pub/sub para SignalR, comandos Redis normales, TTL y scripts Lua. Una API REST de almacenamiento no sustituye la conexión Redis usada aquí.

Obtener del panel del proveedor el host, puerto, contraseña y, si utiliza ACL, usuario. Guardarlos exclusivamente en las variables de los dos servicios. No compartirlos en un chat ni subirlos a Git. Revisar límites de conexiones, memoria y pub/sub del plan; Redis debe permanecer disponible para ambos nodos.

## 2. Configurar las variables en ambos servicios

Añadir estos mismos valores en Environment de cada Render; los textos entre `<…>` son marcadores que se reemplazan en su panel:

```text
MultiInstance__Enabled=true
MultiInstance__Namespace=nivra
ConnectionStrings__RealtimeRedis=<host>:<puerto>,password=<contraseña>,ssl=true,abortConnect=false,connectTimeout=10000,syncTimeout=5000
```

Si el proveedor exige un usuario Redis, agregar `user=<usuario>` a la cadena. StackExchange.Redis utiliza el formato anterior; no pegar directamente una URL `rediss://`. No desactivar TLS ni la validación de certificados.

Conservar en ambos los valores que ya comparten: PostgreSQL/Supabase, clave de firma de sesiones, S3, LiveKit y claves Web Push. Comprobar además:

```text
Push__Enabled=true
Push__Fcm__ProjectId=nivra-af67e
```

Las credenciales FCM deben estar disponibles y ser válidas en **cada** servicio mediante una fuente admitida por la API, por ejemplo `Push__Fcm__ServiceAccountPath`. No alcanza con copiar el nombre de una ruta si el archivo no existe en el segundo host. En la comprobación previa, la secundaria informó FCM desactivado: revisar este punto aunque el resto de variables coincida.

Para límites de autenticación por IP detrás de un proxy, usar exclusivamente saltos IP/CIDR verificados en `ReverseProxy__KnownProxies__0` o `ReverseProxy__KnownNetworks__0`, con `ReverseProxy__Enabled=true`. No usar redes universales ni valores inventados. Sin esos datos, conservar el modo sin confianza en cabeceras reenviadas; la IP anónima puede agrupar usuarios detrás del proxy. El límite por usuario autenticado sigue compartido.

## 3. Hacer Manual Deploy en los dos servicios

Elegir el mismo commit publicado para la 2.1.0 en ambos. Esperar a que cada despliegue termine correctamente. No rotar la clave de firma ni crear otra base/bucket para el respaldo. Esta versión no necesita una migración nueva de base de datos para varias APIs.

## 4. Comprobar la activación

Desde la carpeta del proyecto:

```powershell
./tools/check-api-cluster.ps1
```

Sólo un resultado `Cluster compatible` con salida 0 confirma que ambos nodos publican la misma huella y tienen PostgreSQL, almacenamiento compartido, Redis, FCM y Web Push preparados. El diagnóstico no envía credenciales ni cambia variables. Si aparece `Cluster not ready`, corregir el campo que falta; un timeout también puede significar un arranque frío. No considerar el respaldo activado con salida 2.

Abrir la web o APK 2.1.0 cuando la primaria esté lista permite guardar su huella pública de compatibilidad. Después, un fallo de red o infraestructura puede seleccionar automáticamente el otro nodo sano. Las operaciones de escritura cuya respuesta se perdió no se repiten a ciegas. Para permitir una instalación completamente nueva con la primaria ya caída, se puede compilar la huella pública verificada en `apiClusterFingerprint`; requiere volver a generar los clientes.

## Tráfico y servidores futuros

El acceso S3 temporal para adjuntos normales evita transportar sus bytes cifrados por Render cuando el CORS del almacenamiento lo permite. Configurar GET/HEAD desde los orígenes de la web/WebView y comprobar una descarga propia. Si no está disponible, el cliente conserva el proxy autorizado. Historias de una sola vista, mensajes eliminados al leer y archivos de bóveda conservan ese proxy.

Añadir servicios futuros requiere incluir sus orígenes exactos en el registro del cliente y su shell nativo, compartir las mismas dependencias y repetir el diagnóstico. Redis/PostgreSQL/S3 siguen siendo dependencias comunes. Un servicio gratuito dormido puede tardar en arrancar; varios servicios gratuitos no garantizan capacidad ilimitada ni llamadas sin cortes. Ver [arquitectura y limitaciones](multi-instance-api-2.1.0.md) y [condiciones de Render Free](https://render.com/docs/free).
