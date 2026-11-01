# Consolidación, diseño y seguridad de Nivra

Revisión de la versión 8.0.0: 31 de octubre de 2026. Se generaron los paquetes locales de Android y Windows y se validaron sus versiones, recursos web y firma Android. Todavía no se han publicado. El servicio de producción de la API responde `Service Suspended`; el feed de actualizaciones sigue en 7.7.0. No se alteró el canal público de actualizaciones.

## Cambios funcionales y visuales

- Paleta grafito/jade y tema claro, tipografía y superficies compartidas, marco de escritorio y navegación móvil conservando las áreas seguras.
- Acceso refinado, encabezado y filtros de chats, acciones de conversación visibles con teclado o interacción, y bienvenida con accesos funcionales a chat, grupo e historia para usuarios recurrentes.
- Estado de conexión ligado al estado real de SignalR; no se presenta como una comprobación del cifrado ni de entrega.
- Búsqueda local ordenada por coincidencia exacta, inicio y contenido; reconoce acentos, mayúsculas y palabras en distinto orden. No envía la búsqueda local a servicios de IA. La búsqueda de personas conserva su flujo remoto existente.
- Vista de diseño separada con datos ficticios: `npm --prefix nivra-app run preview:design`. No se incluye en producción.

## Rendimiento

- El índice deduplicado y ordenado de conversaciones se conserva en un `computed` y se invalida con sus dependencias. Se eliminan ordenamientos repetidos en cada lectura de carpeta; el filtro de no leídos mantiene la evaluación del estado actual.
- Los diagnósticos de rendimiento detienen su temporizador en segundo plano, impiden sondeos simultáneos y descartan respuestas posteriores a la destrucción del servicio. Un error del diagnóstico no desactiva la protección térmica conocida.
- La validación de autenticación usa una consulta `EXISTS` que comprueba sesión, usuario y dispositivo sin cargar perfiles, hashes de contraseñas o bundles de claves. Consulta el estado vigente en cada petición. La API compila, pero el despliegue de producción no está operativo y estas modificaciones no están activas en el servidor.

La compilación de producción tiene **3,09 MB iniciales**, con transferencia estimada por Angular de **631,00 kB**. Supera el aviso de 2 MB y tres hojas de componente superan su presupuesto de advertencia; no se aumentaron los presupuestos para ocultarlo. Falta medir arranque y memoria en teléfonos reales e historiales grandes; no se atribuye una mejora porcentual de velocidad sin ese ensayo.

## Correcciones de seguridad

- Eliminada la caché de decisiones de autenticación de 15 segundos. La siguiente petición comprueba revocación, vencimiento, cuenta habilitada y pertenencia/estado del dispositivo, incluso entre instancias que comparten la base de datos.
- Tokens de acceso con tamaño acotado y rechazo de campos/vencimientos inválidos; renovación sujeta al mismo estado vigente.
- Respuestas API con `no-store`, controles de MIME, referencias, permisos y encuadre, también ante errores. Cabecera `Server` de Kestrel desactivada. Los datos locales siguen sujetos al almacenamiento por cuenta de la aplicación.
- Límite de subidas repartido por cuenta/IP para evitar que una cuenta agote una única cuota compartida por todos.
- Cabeceras de protección del frontend configuradas para Vercel. Su presencia en producción requiere desplegar esa configuración. La CSP del frontend cubre encuadre, objetos, base y formularios; todavía no es una política estricta de scripts con nonces/hashes.
- El descifrado rechaza algoritmos o versiones explícitas desconocidas y claves públicas que contienen material privado. Las claves de grupo no admiten sobres de grupo anidados; se validan longitudes AES-256/nonce. Se conserva lectura de los formatos existentes comprobados en pruebas.
- `follow-redirects` actualizado en el lockfile del frontend; Electron actualizado a **42.11.18** y `undici` a una revisión corregida de su rama compatible. Consultas: [aviso de Electron](https://github.com/advisories/GHSA-jr5w-w6x2-84p9), [aviso de undici](https://github.com/advisories/GHSA-2m5v-pch6-74hx).

La invalidación de sesiones y las cabeceras se revisaron contra las guías [OWASP de sesiones](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) y [cabeceras HTTP](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).

## Evolución criptográfica

Se incorpora un [piloto ejecutable](../crypto/ratchet-pilot/README.md) basado en libsignal 0.106.1 con negociación por preclaves, evolución real del ratchet y payload AES-256-GCM con clave por mensaje. Comprueba recepción fuera de orden, repetición, cambio de identidad, reintentos exactos y rollback frente a manipulación.

**No está activado en los clientes publicados.** El estado del piloto vive en memoria y faltan persistencia cifrada/transaccional, directorio y capacidades autenticadas, reserva atómica de preclaves, puentes de todas las plataformas, migración multidispositivo/historial y revisión independiente. El paquete oficial necesita componentes nativos y no es una dependencia directa del navegador. La composición del sobre Nivra también necesita auditoría. La rotación demostrada en el piloto no permite atribuir secreto hacia adelante a los mensajes v1/v2 actuales.

La protección completa de metadatos, la seguridad del dispositivo y el funcionamiento real de TURN/push siguen dependiendo del despliegue y de las plataformas. No corresponde prometer una app «indescifrable» o invulnerable.

## Evidencia y reproducción

- **1.482 pruebas Angular aprobadas**, incluidas las nuevas de búsqueda, protección de sobres y rendimiento adaptativo.
- **36 comprobaciones de seguridad HTTP/API aprobadas** con cuentas sintéticas y almacenamiento en memoria.
- **83 pruebas Node aprobadas** de escritorio y componentes nativos.
- **12 suites .NET existentes aprobadas**: AccountMetadata, AppLock, Call, ContactBlock, Database, History, Identity, Infrastructure, Push, Release, Social y StoryUpload.
- **7 pruebas del piloto aprobadas con Node 24.18.1**.
- API y frontend compilan. Revisión visual de Chats en 390×844 y 1440×900, ambos temas, búsqueda, filtro de fijados y apertura del grupo con datos ficticios.
- Auditorías npm sin hallazgos altos/críticos tras las actualizaciones. Frontend de producción: cero avisos conocidos. Permanecen avisos moderados en herramientas: frontend 45, raíz nativa 4 y escritorio 5. .NET no reporta paquetes vulnerables en las fuentes consultadas. Los resultados reflejan las bases de avisos consultadas en esta fecha, no una garantía de ausencia de fallos.
- El comprobador general de traducciones detecta carencias anteriores a esta revisión y un bloque anidado `CALL_TRANSLATION` que no acepta su formato plano. Las cuatro claves nuevas tienen traducción en los diez catálogos. La cobertura completa de idiomas sigue pendiente.

```powershell
dotnet build Nivra.sln
powershell -NoProfile -File checks/run-security-checks.ps1
npm --prefix nivra-app run build
```

Para ejecutar la batería Angular sin interfaz, con Chrome instalado:

```powershell
cd nivra-app
$env:CHROME_BIN = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadlessNoGpu --progress=false
```

Para el piloto, usar Node 24.18.1 o posterior, ejecutar `npm ci --ignore-scripts` dentro de `crypto/ratchet-pilot` y `npm test`. Los logs y capturas de esta revisión se conservan localmente en `artifacts/`, que está excluido de Git.

Estos ensayos son locales. No incluyen una prueba de penetración externa, una auditoría criptográfica independiente, teléfonos físicos ni una nueva validación de llamadas, push y redes restrictivas contra el despliegue real.
