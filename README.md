# Nivra Private Messenger

Código actual: **9.2.0**, Android **build 58**. Revisión: 6 de noviembre de 2026.

Nivra es un mensajero con chats privados y grupales, contactos, comunidades, historias, listas de difusión, bóveda y llamadas. Comparte una interfaz Angular/Ionic entre Web, Android (Capacitor) y Windows (Electron); la API .NET usa PostgreSQL y SignalR.

## Empezar a usar Nivra

La primera entrada a Chats en una cuenta sin guía completada abre **Guía de Nivra**. Explica cinco tareas: revisar el perfil, agregar un contacto, enviar un mensaje, llamar y preparar la recuperación. Permite explorar por cuenta propia y volver desde **Cuenta → Guía de Nivra**. El progreso es una lista de prácticas marcada por el usuario, guardada por cuenta en ese dispositivo; no certifica que la recuperación esté configurada.

La guía incluye doce áreas funcionales con accesos directos. Los enlaces de invitación, chats específicos y acciones de llamadas mantienen su destino. Cuenta también incorpora **Notificaciones → Comprueba tus notificaciones**, disponible directamente en /app/notification-check.

**Recuperación:** recuperar el acceso permite entrar de nuevo. El correo verificado ayuda a restablecer la contraseña y la frase protege la identidad de cuenta. Sincronizar el historial necesita contenido y llaves disponibles en un equipo autorizado. Perder todas las copias puede impedir recuperar mensajes antiguos.

## Matriz del estado real

Esta tabla describe el repositorio, no una certificación del despliegue público. Los resultados de la entrega se registran en [validación 9.2.0](docs/release-9.2.0.md).

| Área | Estado en código | Dependencias y límites |
| --- | --- | --- |
| Web | Implementada | Servidor web con rutas SPA y API autorizada por CORS. |
| Android | Proyecto nativo, push, almacenamiento y llamadas | APK firmado con el certificado existente. Validar permisos, batería y fabricantes en teléfonos físicos. |
| Windows | Electron e instalador NSIS | Avisos del sistema mientras la app está ejecutándose; no requiere token FCM. |
| iOS | Dependencias compartidas | No hay proyecto iOS generado ni instalador. Requiere macOS/Xcode, firma y configuración Apple. |
| Bienvenida y guía | Implementadas en el cliente compartido | Progreso local por cuenta. Nuevos textos completos en español e inglés; otros idiomas usan el fallback existente. |
| Diagnóstico de avisos | Permiso, conexión, servicio y registro por dispositivo | En Android consulta permiso nativo. Windows explica sus avisos del sistema. No simula una prueba de entrega FCM. |
| Acceso y dispositivos | Alias/ID, QR, sesiones, revocación | La autenticación Firebase por teléfono se conserva; su activación sigue pendiente por decisión del propietario. |
| Contactos | Solicitudes, invitaciones y bloqueo | Las cuentas privadas requieren identificación exacta o pase. |
| Chats y grupos | Mensajes, adjuntos, edición, reacciones, recibos y cola de textos | Los reintentos requieren cliente abierto y desbloqueado; dependen de red y compatibilidad de dispositivos. |
| Notas propias y difusión | Implementadas | Las difusiones se entregan por conversaciones privadas. |
| Comunidades | Agrupación de grupos, miembros e invitaciones | Permisos por rol; límites de código no equivalen a capacidad de carga comprobada. |
| Historias/Mundo | Texto y multimedia, audiencia y respuestas | Revisar audiencia antes de publicar. Formato criptográfico propio. |
| Chat incógnito | Vista temporal con estado del contacto, salida al chat y diseño claro/oscuro | Ambos deben entrar antes de enviar. Una salida o desconexión cierra la sala; los participantes pueden conservar capturas. |
| Bóveda y salas | Elementos, acceso e invitaciones | Revisar duración y condiciones de cada sala. Voz requiere LiveKit. |
| Mensajes cifrados | Double Ratchet con vodozemac, saludo híbrido X25519/ML-KEM-768 | Composición propia de Nivra; auditoría independiente pendiente. No es el formato de Signal. |
| Identidad recuperable | Certificados de dispositivos y copias cifradas | Recuperar identidad no restaura automáticamente el historial. |
| Historial multidispositivo | Transferencia aprobada y reanudable | Necesita un origen autorizado que conserve datos/llaves; no recupera mensajes eliminados o vencidos. |
| Llamadas directas | WebRTC y señalización protegida | TURN sigue pendiente de operación; algunas redes pueden fallar. La conexión directa puede revelar IP entre participantes. |
| Llamadas grupales | LiveKit y cifrado por publicador | Configuración LiveKit y validación física; revisión externa de distribución de claves pendiente. |
| Pantalla, juegos y traducción | Implementadas según plataforma | Permisos del sistema; traducción depende del dispositivo. Juegos se cargan al usarlos. |
| Monetización | Endpoints de planes y anuncios | No implica pasarela de pagos ni suscripciones comerciales operativas. |
| Remitente sellado | Diseño documentado | No activado; no se promete ausencia de metadatos. |

## Arquitectura y carga inicial

- nivra-app: Angular/Ionic; rutas de pantallas con carga diferida.
- Nivra.Api: API .NET 9, PostgreSQL/Entity Framework y SignalR.
- android: integración Capacitor y funciones nativas.
- Nivra.Desktop: Electron, almacenamiento protegido y actualización.
- crypto: motor común Rust/WASM, pruebas y laboratorios históricos.
- checks, tools y .github/workflows: validación y publicación.

LiveKit se importa al conectar una sala que lo necesita. Sus proveedores de llaves se cargan por separado; se conserva el requisito de activar el cifrado antes de publicar medios. El motor de juegos se descarga al crear/recibir una partida y su panel al abrirlo. Bóveda y Comunidades mantienen sus rutas diferidas.

La medición de compilación local pasa de 3,23 MB iniciales a aproximadamente 2,73 MB. Es tamaño de recursos, no una medición de velocidad, batería o memoria en teléfonos. Android incluye todos los recursos dentro del APK y los carga al necesitarlos; no depende de descargarlos de Internet al abrir cada función.

## Ejecutar en desarrollo

Requisitos: .NET 9, PostgreSQL, Node y npm compatibles con Angular 20; JDK 21 y Android SDK para Android. Usar secretos por variables de entorno o gestor del proveedor.

~~~powershell
npm ci
npm --prefix nivra-app ci
npm --prefix Nivra.Desktop ci
$env:ASPNETCORE_ENVIRONMENT = "Development"
dotnet run --project Nivra.Api/Nivra.Api.csproj --urls http://localhost:5055
~~~

En otra terminal:

~~~powershell
npm run web:start
~~~

La configuración de conexión y los secretos son propios del entorno. No copiar credenciales de producción a archivos versionados. La API aplica migraciones al arrancar: revisar y respaldar antes de desplegar.

## Comprobar y empaquetar

~~~powershell
dotnet build Nivra.sln
npm --prefix nivra-app run build
$env:CHROME_BIN = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node nivra-app/node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadlessNoGpu --progress=false
powershell -NoProfile -File checks/run-security-checks.ps1
npm run cap:sync
npm --prefix Nivra.Desktop run build-exe
npm --prefix Nivra.Desktop run build-installer
~~~

Android: tools/build-android-production.ps1 exige la llave existente y sus contraseñas por entorno. tools/verify-release.ps1 verifica versiones, firma, recursos web e integridad antes de producir el feed. Nunca anunciar instaladores sin esta comprobación. Consultar [publicación](docs/release-update-feed.md).

## Configuración de producción

Configurar como mínimo: conexión PostgreSQL; Security__TokenSigningKey estable y secreto; almacenamiento cifrado local o S3; CORS; push FCM/WebPush según plataforma; URL/credenciales LiveKit para salas; TURN para redes restrictivas. No exponer claves de servicio en clientes ni repositorios.

Las opciones de ratchet de producción son Ratchet__Enabled=true, Ratchet__RequireHybrid=true y laboratorios desactivados. /health informa vida; /health/ready permite comprobar preparación efectiva. Los valores del proveedor pueden sustituir los del repositorio.

Consultar [preparación de seguridad](nivra-app/docs/security-production-readiness.md), [identidad y recuperación](docs/account-identity-recovery-9.1.0.md) y [límites de remitente sellado](docs/sealed-sender-deployment-gates.md).

## Límites de la validación

Compilar, aprobar pruebas y recibir una llamada en un teléfono real son evidencias distintas. La auditoría criptográfica externa, las pruebas con usuarios nuevos, los ensayos físicos de llamadas/notificaciones y las pruebas de carga deben registrarse con sus resultados. Ningún indicador de configuración garantiza entrega ni funcionamiento sin fallos en todas las redes y dispositivos.
