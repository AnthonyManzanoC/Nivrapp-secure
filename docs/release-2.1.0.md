# Nivra 2.1.0 — historias, perfil y respaldo de API

Fecha: 11 de octubre de 2026. El protocolo de llamadas permanece en 2; Android utiliza versionCode 22 y conserva el certificado de la versión anterior.

## Experiencia

Historias utiliza un visor compartido con tiempo real de vídeo/audio, pausa al escribir o consultar actividad, navegación entre nuevas/vistas y recuperación ante errores. Descarga y descifra antes de consumir una historia de una sola vista. El creador consulta vistas, reacciones y respuestas reales; compartir y eliminar requieren confirmación y respetan permisos. La caché está acotada y evita precargar medios mayores de 8 MB.

Perfil conserva borradores cuando falla el guardado, muestra cambios pendientes, permite descartar y corrige el borrado de biografía. Comparte enlaces públicos desde Android/Windows y evita aplicar respuestas de otra cuenta o dispositivo.

## Infraestructura y seguridad

La web, APK y Windows incluyen los dos orígenes API autorizados. El cliente sólo cambia al respaldo cuando la salud, huella de instalación, protocolo y push son compatibles. Reconstruye SignalR y suscripciones; vuelve a consultar llamadas/salas. No repite mutaciones con respuestas inciertas. Redis opcional comparte eventos, presencia, QR y límites de autenticación; los refresh tokens, la actividad de historias y la finalización del alias de teléfono usan coordinación PostgreSQL. La cuenta temporal se consulta de nuevo bajo el bloqueo antes de emitir su sesión.

Los adjuntos normales pueden descargar bytes cifrados directamente de S3 con acceso temporal; una vista, bóveda y eliminación al leer mantienen el proxy autorizado. Windows valida el remitente de IPC y bloquea navegación externa en su ventana privilegiada. Se actualizaron dependencias compatibles de Angular, Capacitor, Firebase, Electron y MessagePack; la versión CDN de Firebase también coincide con 12.19.0.

Las auditorías no reportan vulnerabilidades en dependencias de producción del frontend, shell completo, Desktop completo ni paquetes NuGet de la API. Quedan 15 avisos en herramientas de desarrollo/pruebas frontend, documentados en [dependencias](security-dependencies-2.1.0.md). El resultado no equivale a una garantía de ausencia de vulnerabilidades.

## Validación

| Comprobación | Resultado |
| --- | --- |
| Cliente Angular, Chrome Headless | 521 aprobadas |
| WebRTC con conexiones reales Chrome | 2 aprobadas |
| Android, pruebas JVM | 12 aprobadas |
| Windows, orígenes e IPC | 6 aprobadas |
| API: llamadas / historial / push / release / infraestructura | 89 / 28 / 24 / 12 / 51 aprobadas |
| PostgreSQL | Conectividad, esquema y exclusión concurrente comprobados con transacciones reales |
| Web, APK y Windows | Compilación correcta; 1.421 archivos web idénticos verificados |
| APK | Firma v2 válida, mismo certificado que 2.0.0 |

La compilación web mantiene el aviso existente del presupuesto inicial: 3,01 MB sin comprimir y 608,69 kB de transferencia estimada; en 2.0.0 eran 2,94 MB y 596,51 kB. No se elevó el presupuesto para ocultarlo. El ahorro de egreso por descarga directa no se ha medido en producción. Los detalles y límites de pruebas están en [seguridad y rendimiento](security-performance-2.1.0.md).

## Paquetes

| Archivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `Nivra-2.1.0-debug.apk` | 81.737.094 | `5714905776917c824a9be06553963fca0da7ab7b2ee2cffab9640baaef841329` |
| `Nivra-2.1.0-win32-x64.zip` | 156.171.203 | `3af10bb2fc362ee36e380821ccc1bc9d130afe2e1773dc9584b86bd766747234` |

## Activación pendiente en Render

El usuario confirmó que ambas APIs comparten las variables existentes y que todavía no tiene Redis compartido. El respaldo no se presenta como activo: requiere Redis TCP/TLS compartido, FCM operativo en la secundaria y Manual Deploy del mismo commit en ambos servicios. Seguir [configuración paso a paso](render-failover-setup-2.1.0.md) y obtener salida 0 en `tools/check-api-cluster.ps1`.

No se simuló una caída en las cuentas reales ni se efectuó una prueba Redis real entre esos hosts. La comprobación visual por Computer Use se detuvo por URL no verificable; siguen pendientes la validación física de Safari/Mac y de Android dormido. Una API gratuita dormida puede tardar en iniciar; las dependencias compartidas y sus cuotas siguen existiendo.

### Hotfix posterior al tag 2.1.0, 11 de octubre

`main` elimina el bloqueo de arranque que exigía TLS a Redis en producción para admitir el `ssl=false` configurado por el operador. Redis Cloud Free no ofrece TLS; este modo deja sin cifrado de transporte el enlace de API a Redis. El tag original y los paquetes publicados conservan su contenido. Desplegar el commit del hotfix, no volver a desplegar el tag original. La [guía actualizada](render-failover-setup-2.1.0.md) describe la configuración y el caso de clientes sin huella cuando la primaria ya está caída.
