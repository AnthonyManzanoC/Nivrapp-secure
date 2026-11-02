# Nivra 8.2.1: validación de publicación

2 de noviembre de 2026. Código funcional: f5e67fa66b824bac264c1807f7d29dc36cc8f1c9.

- [Las siete verificaciones completas aprobaron](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41518344992): 1578 pruebas Angular y compilación de producción; Rust/WASM y procedencia/licencias; PostgreSQL/HTTP real; Electron Windows/Linux; revisión visual; Android WebView, SQLCipher y Keystore después de reiniciar el proceso.
- Android también aprobó las cuatro pruebas nativas de llamadas entrantes: voz, video privado, cancelación por cuenta y cambio de privacidad durante la recepción. Los datos y paquetes de pruebas son independientes de las cuentas reales.
- Revisión visual de buscador y borrado de recientes, Mundo claro/oscuro y anillos, perfil claro/oscuro, voz/video entrantes, respuestas rápidas, aviso de resultado, historial, llamadas activas, historias y juegos. El perfil usa una maqueta con datos sintéticos y el estilo real; las otras vistas usan sus componentes reales.
- 36 comprobaciones HTTP de seguridad, 85 Node, 125 comprobaciones del servidor de llamadas y 18 de autenticación correctas. Sin alertas altas/críticas en npm audit; permanecen avisos moderados de herramientas de desarrollo. No se aplican cambios mayores automáticos para ocultarlos.
- APK de publicación no depurable, com.nivra.app, versión 8.2.1, código 54 y certificado anterior e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60.
- Verificador de instaladores: 1444 archivos web idénticos en escritorio/ZIP y 1443 en APK (Android omite el archivo web de asociaciones). Cifrado y lectores de historial anteriores conservados.

SHA256:

| Archivo | Huella |
| --- | --- |
| Nivra-8.2.1-debug.apk | 2921b5c41f269e22b6a0dc3c74444fd89136b13869ada389a156204090bad3c3 |
| Nivra-8.2.1-Setup.exe | 0f70d557b963b284b5d45074e58d03e52f98f54f20565221d73184b7bafd31a4 |
| Nivra-8.2.1-win32-x64.zip | d2f293375e918655a7165ed1a120b53ec9ed0c2b1905bbb209a4b96714739e7e |

Las respuestas rápidas pasan por las comprobaciones de acceso al chat y la cola cifrada. Las notificaciones antiguas no rechazan una llamada ya contestada. El regreso solo usa rutas internas válidas de la misma cuenta/dispositivo y respeta la navegación manual.

TURN y Firebase por teléfono se conservan en pausa por decisión del propietario. Siguen pendientes las llamadas entre teléfonos físicos y redes restrictivas, las restricciones de fabricantes y la auditoría criptográfica independiente. Sin red, los textos quedan pendientes hasta recuperar conexión; ningún cliente puede garantizar avisos si Android fuerza la detención o el usuario desactiva sus permisos.
