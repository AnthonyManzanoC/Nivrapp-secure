# Nivra 8.0.0

**Android build 50.** La actualización conserva el identificador y el certificado de firma de las instalaciones Android existentes. El cifrado activo sigue usando el protocolo de producción que ya distribuye Nivra. El piloto Double Ratchet AES-256-GCM queda aislado; no se integra en la app ni altera sesiones o llaves existentes.

- Renovación visual del acceso, los chats y la bienvenida, compatible con los diez idiomas y los temas claro y oscuro.
- Búsqueda local ordenada por coincidencia y filtros de conversaciones más claros.
- Menos trabajo repetido al mostrar la lista de chats y controles adaptativos para tareas de fondo.
- Revisión del estado vigente de usuarios, sesiones y dispositivos en autenticaciones posteriores a revocaciones.
- Límites de solicitudes separados por cuenta y dispositivo; protección adicional de cabeceras y de respuestas privadas.
- El instalador por usuario de Windows conserva el perfil local y no cierra la app a la fuerza si todavía está abierta.

## Validación

- Compilación de la API completada: 0 errores y 0 advertencias.
- Pasaron 36 comprobaciones de seguridad HTTP/API sobre datos sintéticos y 83 pruebas Node de escritorio y componentes nativos.
- Pasaron 20 comprobaciones automatizadas offline del contrato de publicación.
- El verificador de artefactos confirmó 1.438 recursos web compartidos por escritorio y ZIP, 1.437 dentro del APK, la versión Android `8.0.0` build 50 y la firma fijada para `com.nivra.app`.
- El APK público 7.7.0 y la clave disponible localmente verifican la misma huella de firma Android fijada para `com.nivra.app`.
- Se ejecutó el análisis de dependencias del frontend y escritorio: quedan avisos moderados en dependencias de herramientas.
- La compilación web y los tres paquetes locales terminaron. Angular informa 3,09 MB de recursos iniciales y avisos de Sass/presupuesto; los presupuestos no se ocultaron. El análisis de dependencias detectó avisos moderados en herramientas de desarrollo, sin hallazgos altos/críticos.
- La API primaria y la secundaria de Render respondieron `503`; la tercera (`nivrapp-secure-eaqi.onrender.com`) respondió 200 con protocolo 2, fingerprint compartido, PostgreSQL/estado en tiempo real y FCM/Web Push listos. El frontend de producción ahora usa esa API primero y conserva las otras como failover.
- La API sana todavía informa versión 7.7.0. Es compatible con llamadas de protocolo 2. La persona responsable del despliegue iniciará la actualización del backend 8.0 en Render; el frontend 8.0 no depende de ese deploy para seguir hablando con el servicio sano.
- `webrtcRelayConfigured=false` en la API sana: los medios que requieren TURN pueden fallar en algunas redes aunque la señalización de llamadas responda. La configuración TURN debe resolverse en Render.
- Antes de crear una release se confirmó que el feed aún estaba en 7.7.0. La publicación de 8.0 y las comprobaciones de descarga pública se ejecutan después de llevar el commit a GitHub.

## Reproducir el empaquetado y la publicación

Con el frontend compilado, Android JDK 21 y la clave de firma original disponibles:

```powershell
npm --prefix nivra-app run build
 npx cap sync android
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-android-production.ps1 -Version 8.0.0
npm --prefix Nivra.Desktop run build-exe
npm --prefix Nivra.Desktop run build-installer
# Generar Nivra-8.0.0-win32-x64.zip desde Nivra.Desktop/dist/Nivra-win32-x64.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/verify-release.ps1 -Version 8.0.0 -DesktopDirectory (Resolve-Path Nivra.Desktop/dist/Nivra-win32-x64).Path
```

Publica el commit verificado en GitHub/Vercel y usa `tools/publish-android-release.ps1` con su SHA de 40 caracteres. El script solo publica una release después de verificar todos los assets y el manifiesto. Comprueba entonces las descargas públicas y `latest.json` con `tools/check-published-release.cjs`. Después del deploy de Render iniciado por la persona responsable, confirma `/health/ready` versión 8.0.0, protocolo 2 y configuración TURN si se requieren llamadas confiables en redes restrictivas.
