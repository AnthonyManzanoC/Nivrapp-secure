# Historias en Inicio y protección del historial

Revisión de código: 2026-09-13. Complementa `security-production-readiness.md`; no representa una auditoría criptográfica externa ni validación en dispositivos físicos.

## Cambios implementados

- La cabecera de Chats presenta una fila horizontal de historias personales y de grupos, con avatares circulares, nombres y una insignia para grupos. Las historias propias aparecen primero; después, las novedades y las ya vistas.
- Se consume exclusivamente `SocialService.stories`, el feed con audiencia ya autorizada. Las historias de un grupo se agrupan por conversación, aunque tengan autores diferentes. No se incorpora el feed público de Mundo ni se crean conversaciones para mostrar historias.
- Se reutilizan el visor existente, sus reacciones, respuestas cifradas y permisos. Un toque abre las historias directamente, comenzando por la primera no vista. Los anillos de la lista de conversaciones mantienen su comportamiento anterior.
- La fila reacciona a las señales existentes de publicación, borrado y vistas. Las historias caducadas se retiran como máximo a los 30 segundos en primer plano y se filtran de nuevo antes de abrir. La fila se oculta durante la búsqueda para mantener espacio para resultados.
- Si falla la apertura de SQLite o su protector, ya no se recrea la base ni se pasa silenciosamente a otro historial en IndexedDB. La apertura se puede reintentar después de desbloquear el dispositivo. Si falla el descifrado de una clave local ya envuelta, se conserva esa clave en lugar de sustituirla.
- Chats muestra un aviso de historial no disponible y un botón para reintentar. Es necesario porque las operaciones de sincronización ya capturan errores de caché para permitir seguir usando la conexión.

## Lo que existe y lo que falta

| Superficie | Evidencia en código | Límite y próximo trabajo |
| --- | --- | --- |
| Historial nativo de mensajes | `local-history.service.ts`: SQLite se abre con `encrypted=true`; el secreto de 32 bytes proviene del almacén seguro. El payload tiene además AES-GCM. | El secreto no se deriva del PIN del usuario. Verificar la compilación nativa, migraciones, recuperación de errores y copia/restauración en APK real. SQLCipher protege archivos de base de datos; no elimina todos los demás rastros del producto. |
| Protector Android | `NivraNativePlugin.java`: Android Keystore, AES-GCM, secreto envuelto en preferencias; manifiesto con `allowBackup=false` y reglas de extracción. | La clave Keystore no exige autenticación del usuario por operación. El bloqueo visual por PIN/biometría es independiente del protector criptográfico. Diseñar el desbloqueo de claves sin perder llamadas/notificaciones de fondo y probar reinicio/invalidación de biometría antes de cambiarlo. |
| Escritorio y web | Escritorio usa Electron `safeStorage`; web puro conserva la clave privada JWK en IndexedDB y la sesión en almacenamiento del origen cuando no hay protector nativo. | No prometer protección equivalente entre plataformas. Una sesión web o un origen comprometido pueden acceder al material que necesita el cliente para descifrar. |
| Metadatos locales | Perfiles e historias usan IndexedDB incluso en nativo. Chats guarda búsquedas recientes y preferencias de conversación en `localStorage`. | El contenido privado de las historias conserva su sobre cifrado, pero nombres, participantes, fechas y otros metadatos no quedan todos dentro de SQLite cifrado. Inventariar y migrar esos almacenes con una política explícita de retención. |
| PIN actual | `AppLockService`: PIN de cuatro cifras, verificador PBKDF2/AES-GCM y bloqueo de interfaz. | No es la clave de cifrado del historial. Un PIN corto no basta como único secreto contra intentos fuera de línea. Separar bloqueo de interfaz, autorización de claves y recuperación en el diseño. |
| Mensajes directos y privados | `CryptoService.encryptForPublicKey` deriva AES-GCM de ECDH P-256 con claves de dispositivo y un IV aleatorio. | No hay ratchet que deseche claves de mensajes anteriores. Cambiar únicamente el IV o una clave de sesión no aporta las propiedades del protocolo Double Ratchet. Adoptar una implementación mantenida, con migración versionada, verificación de identidad, mensajes fuera de orden y estado multidispositivo. |
| Grupos e historias privadas | Se genera una clave de contenido AES-GCM y se envuelve para los dispositivos destinatarios. Las historias públicas de Mundo son públicas por definición. | Envolver claves nuevas mediante claves ECDH estáticas tampoco equivale a PFS. Definir revocación de miembros/dispositivos, historial para dispositivos nuevos y protocolo de grupo antes de afirmar protección poscompromiso. |
| Llamadas grupales | LiveKit usa un worker E2EE por publicador, con claves aleatorias de 256 bits distribuidas por la señal cifrada por dispositivo y rotadas cuando cambia la sesión o la membresía. | Requiere pruebas físicas de todos los clientes compatibles y una auditoría del protocolo de distribución. No convierte los mensajes en un protocolo Signal ni aporta PFS de mensajes. |

El diseño de [SQLCipher](https://www.zetetic.net/sqlcipher/design/) describe protección del almacenamiento SQLite. La especificación de [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) describe derivación de claves por mensaje y evolución del estado para limitar el efecto de un compromiso. [LiveKit](https://docs.livekit.io/transport/encryption/) distingue cifrado del transporte de E2EE e indica que la distribución segura de claves corresponde a la aplicación. Estas propiedades deben implementarse y probarse por separado.

## Validación y prioridades

Pruebas automatizadas específicas: agrupación por dueño/grupo, separación de historias personales y grupales, deduplicación, caducidad, prioridad de novedades, orden del visor; fallo de apertura del almacén nativo sin recreación ni segundo historial, recuperación posterior y conservación de claves envueltas ante un fallo del protector.

Pendiente en dispositivos reales: probar dos cuentas/dispositivos, historias creadas y borradas durante la navegación, grupos abandonados, audiencias revocadas, reinstalación/actualización y errores del almacén seguro. La fila y las pruebas no cambian las comprobaciones de acceso del servidor.

Antes de anunciar una privacidad superior a otros mensajeros: inventario de metadatos y exportaciones, modelado de amenazas, migración a un protocolo mantenido de mensajería con PFS, verificación de identidad, validación y auditoría del E2EE de medios grupales, pruebas físicas y revisión externa. La memoria de una sesión desbloqueada, capturas del destinatario y copias externas siguen siendo superficies diferentes; no corresponde garantizar “cero rastros”, “imposible de peritar” o “indescifrable”.
