# Nivra 4.0.1

La portada de presentación permanece exclusiva del navegador. Las aplicaciones Android y Windows incorporan una bienvenida propia antes del primer acceso, con selección de idioma y botón «Siguiente». Android versionCode 27; protocolo de llamadas 2, compatible con 4.0.0.

## Acceso y descargas

- La bienvenida recuerda que se completó en el dispositivo. Las sesiones existentes se restauran y abren sus chats. Las invitaciones conservan el flujo pendiente de acceso.
- Los diez idiomas disponibles en el acceso también se pueden seleccionar en la bienvenida. El acceso web conserva su comportamiento actual.
- La sección Descargas de la web ofrece enlaces directos `/downloads/Nivra-4.0.1-debug.apk` y `/downloads/Nivra-4.0.1-Setup.exe`, con versión visible y atributo download. Vercel sirve esas rutas mediante rewrites externos a los assets verificados y encabezados Content-Disposition de descarga. No se abre la página de GitHub; no se guardan binarios grandes en el repositorio.
- Windows incluye un instalador por usuario, accesos directos y desinstalador. El perfil y las claves locales se conservan al actualizar o desinstalar. También se ofrece el ZIP portable completo.
- El mismo frontend adapta su base y utiliza rutas hash cuando se abre desde disco en Electron. Web y Android conservan las rutas habituales; la navegación de Windows permanece en el documento local autorizado.

## Construcción y publicación

Construir el frontend de producción, sincronizar Capacitor y compilar Android con JDK 21. Empaquetar Windows con `npm --prefix Nivra.Desktop run build-exe` y generar su instalador con `npm --prefix Nivra.Desktop run build-installer`.

`tools/verify-release.ps1 -Version 4.0.1 -DesktopDirectory <paquete-Windows>` comprueba versiones y hashes del frontend dentro del APK, Windows y ZIP; genera SHA256 de los tres paquetes y actualiza `Nivra.Api/android-release.json`. `tools/publish-android-release.ps1` sube y comprueba los assets antes de publicar la versión.

El APK conserva la firma de las versiones anteriores. El instalador Windows se construye con NSIS y no tiene firma digital de editor. Los paquetes completos y sus hashes se publican en [v4.0.1](https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/tag/v4.0.1).

Para que el actualizador integrado de Android anuncie 4.0.1, las APIs de Render deben desplegar también el nuevo `android-release.json`. Las descargas directas de la web no dependen de ese despliegue.

## Validación

Compilación de producción, 38 pruebas Angular enfocadas en entrada, idioma, sesiones y actualizaciones, 19 pruebas Android, 7 comprobaciones de seguridad Windows y 12 de metadata de actualización aprobadas. El APK declara 4.0.1/code 27 y su certificado SHA256 coincide con 4.0.0. El verificador coteja el frontend de ambos paquetes y el ZIP con la compilación y genera sus hashes de distribución.

La web y la bienvenida se revisaron visualmente en navegador, esta última con un puente nativo simulado y sin cuentas reales. Se comprobó cambio de idioma, paso a auth y persistencia al volver a abrir. No se realizó instalación interactiva de Windows ni ejecución en un teléfono Android: el control de Windows no pudo iniciarse y no había un dispositivo Android conectado.

Los seis textos de bienvenida están completos en los diez idiomas. El chequeo global de catálogos conserva las mismas 14 claves antiguas ausentes en ocho idiomas, sin nuevas faltantes. El build mantiene la advertencia previa del bundle inicial de 3,01 MB; no se ampliaron presupuestos.
