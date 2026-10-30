# Nivra 7.0.0

- El cliente conserva el primario y los dos respaldos en este orden: `nivrapp-secure.onrender.com`, `nivra-webapp-secure.onrender.com` y `nivrapp-secure-eaqi.onrender.com`.
- Cada respaldo debe superar la comprobación de salud, protocolo y huella del clúster antes de recibir credenciales. El cliente conserva la protección contra reenvíos ambiguos de escrituras.
- Incluye las mejoras 6.2 de bloqueo de contactos y conversaciones, privacidad de notificaciones, recuperación de historial, continuidad de identidades conocidas e iconos del PWA.
- Android mantiene `com.nivra.app`, el certificado fijado y el protocolo de llamadas 2. Versión 7.0.0, código 42.

## Cierre de distribución

El push de código y la publicación de instaladores son pasos distintos. La web mostraba 7.0.0 mientras la última release y el catálogo público seguían en 6.1.3. Los equipos instalados no podían descubrir la versión 7 y los enlaces a sus instaladores todavía no tenían archivos publicados.

Además, las instalaciones Windows anteriores rechazan la nueva forma de la ruta CDN de GitHub (`github-production-release-asset` sin sufijo). La ruta pública del EXE ahora transmite el instalador por streaming desde Vercel, conservando la URL original. Esto permite actualizar las instalaciones existentes sin debilitar sus comprobaciones de hash ni reconstruir los paquetes 7.0.0. La función restringe los destinos, transmite sin cargar el archivo completo en memoria y cierra la respuesta si el origen queda incompleto. El APK sigue usando la descarga directa de GitHub, que admite su verificador nativo.

La publicación debe incluir APK, setup Windows, portable, hashes, metadatos Android y `latest.json`, producidos por `tools/verify-release.ps1`. `tools/publish-android-release.ps1` verifica sus hashes antes de publicar. Después, ejecutar:

```powershell
node tools/check-published-release.cjs 7.0.0 d448bb26591f5b33e716e167df868b09342fc9e3
```

Este control comprueba la release pública, el catálogo utilizado por la app, CORS y la descarga completa del APK y EXE desde las rutas de producción, sin ejecutar instaladores. Un cierre de release requiere además comprobar la actualización desde una versión anterior de la app.

La disponibilidad de cada instancia Render depende de su cuota y configuración. El cliente puede usar el tercer respaldo cuando los anteriores no superan la comprobación; no garantiza disponibilidad cuando todas las instancias están fuera de servicio.
