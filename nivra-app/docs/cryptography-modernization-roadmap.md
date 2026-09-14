# Modernización criptográfica e identidad verificable

Fecha de revisión: 2026-09-13. Este documento es un plan de migración; no anuncia que los protocolos de las fases posteriores estén implementados ni sustituye una auditoría independiente.

## Estado comprobado

- Los mensajes directos actuales derivan una clave AES-GCM desde ECDH P-256 de larga duración por dispositivo (`ECDH-P256-A256GCM`). El campo de preclave firmado no tiene todavía semántica X3DH/PQXDH: el cliente publica la misma clave pública como `identityKey` y `signedPreKey`.
- Los mensajes de grupo crean una clave AES-GCM por payload y la envuelven para cada dispositivo. Esto permite entrega por dispositivo, pero no es Sender Keys ni MLS; no hay épocas de grupo, revocación criptográfica ni recuperación poscompromiso.
- La carpeta de claves contiene dispositivos confiables y permite revocarlos, pero no tiene una identidad raíz por usuario, certificados de dispositivo, log de transparencia ni una confirmación visible de cambios de clave.
- El E2EE de LiveKit sí activa el worker por publicador y rechaza publicar medios si no se confirma el intercambio de claves. LiveKit deja explícitamente a la aplicación generar, almacenar y distribuir las claves; su señalización continúa siendo TLS, no E2EE.
- El endpoint autenticado de ICE admite TURN y `RelayOnly`, pero hoy entrega las credenciales configuradas de forma estática. Una instalación de producción necesita credenciales TURN efímeras.

## Base segura incluida ahora

`src/app/core/utils/identity-fingerprint.ts` define una huella canónica versionada del directorio de dispositivos y un código de comparación de dos directorios. Solo acepta JWK EC P-256 sintácticamente válidas, ordena los dispositivos por id y cambia el resultado si cambia, desaparece o aparece una llave.

El código se llama deliberadamente `deriveUnverifiedSafetyNumber`: no persiste una marca de confianza ni muestra que una identidad esté verificada. Más adelante puede mostrarse como "compara este código en persona" o codificarse en un QR. Solo tras una comparación autenticada fuera de banda y una decisión explícita del usuario podrá guardarse una verificación. Un servidor que entregue directorios distintos a cada persona sigue siendo una amenaza hasta que exista transparencia de llaves.

## Arquitectura objetivo

### 1. Identidad, dispositivos y transparencia

Separar identidad y sesión antes de sustituir cifrado:

1. Crear una identidad raíz persistente por usuario y una identidad firmante por dispositivo. Un dispositivo nuevo debe publicarse como una credencial firmada por la identidad raíz o ser aprobado por un dispositivo ya verificado mediante QR.
2. Versionar el material público: `protocol`, `suite`, `credentialId`, `createdAt`, `expiresAt`, `status` y capacidades. No reutilizar los campos P-256 actuales para material PQ sin una versión explícita.
3. Guardar un registro de directorio solo de anexión con hash encadenado/Merkle, raíz firmada y pruebas de inclusión/consistencia. Los clientes deben fijar el último tamaño y raíz observados, detectar rollback/equivocation y mostrar un aviso de identidad modificada antes de seguir enviando.
4. Añadir una pantalla de seguridad por contacto: lista de dispositivos, código de comparación, QR, fecha de la última verificación y un estado `sin verificar`, `verificado`, `cambió` o `revocado`. "Verificado" debe significar una acción local del usuario, nunca que la API respondió 200.

La [especificación Sesame](https://signal.org/docs/specifications/sesame/) exige tratar los cambios de identidad como eventos que requieren nueva autenticación; sin ella, no existe garantía criptográfica sobre quién recibe los mensajes.

### 2. Mensajes directos: protocolo mantenido, no una implementación casera

Adoptar una implementación mantenida de Signal Protocol, evaluando [libsignal](https://github.com/signalapp/libsignal). El proyecto publica APIs puenteadas para Java, Swift y TypeScript sobre una base Rust; Android, iOS, escritorio y el cliente web/WASM deben tener una capa común revisada antes de elegirlo como dependencia de producción. No agregar una librería JavaScript no auditada que imite un ratchet.

El protocolo debe usar PQXDH/X3DH para crear sesiones asíncronas y Double Ratchet para cada par de dispositivos. La [especificación PQXDH](https://signal.org/docs/specifications/pqxdh/) describe la protección híbrida de la negociación inicial y la [especificación Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) describe claves de mensaje únicas, secreto hacia adelante y recuperación posterior a un compromiso.

Contratos necesarios antes de encenderlo:

- `DeviceCredential` y `PreKeyBundleV2`: identidad, preclave firmada, lote de preclaves de un uso, suites admitidas y vencimientos. La reserva y consumo de una preclave debe ser atómica en PostgreSQL.
- `RatchetSessionV2`: estado privado por par de dispositivos, id de sesión, contador, claves saltadas limitadas y versión. Se almacena solo cifrado en el almacén del dispositivo; nunca en el backend ni en la copia de seguridad sin una protección de extremo a extremo definida.
- `EncryptedEnvelopeV2`: `protocol`, `suite`, `senderDeviceId`, `recipientDeviceId`, `sessionId`, contador y AAD que una conversación, id de mensaje y destinatario. Los envelopes v1 siguen siendo solo de lectura durante la migración.
- Gestión Sesame: una sesión por pareja de dispositivos, fan-out al resto de dispositivos propios y del destinatario, recepción fuera de orden, borrado de sesiones al revocar un dispositivo y bloqueo/confirmación al cambiar una identidad.

Un mensaje nuevo solo podrá usar v2 cuando todos los dispositivos activos requeridos hayan declarado capacidad v2. Durante una ventana delimitada se admite lectura dual; no se re-cifra en servidor ni se intenta convertir el historial v1. El cliente deberá explicar que un equipo sin actualizar no puede recibir el nuevo protocolo hasta actualizarse o revocarse.

### 3. Grupos: adoptar MLS en vez de ampliar el sobre actual

Para grupos nuevos, elegir MLS RFC 9420 en lugar de hacer evolucionar el sobre AES actual. MLS es un estándar IETF para grupos asíncronos y ofrece secreto hacia adelante y recuperación poscompromiso mediante épocas; su diseño escala logarítmicamente con el tamaño del grupo, frente a la rotación manual de Sender Keys. [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) también describe credenciales, KeyPackages, commits y revocación de miembros.

[OpenMLS](https://openmls.tech/) es una opción a evaluar: es una implementación Rust de MLS, soporta Android, iOS, escritorio y WebAssembly, y tiene mantenimiento comercial. Debe integrarse mediante adaptadores revisados para cada plataforma, vectors de interoperabilidad RFC y una auditoría; no como un paquete WASM sin análisis de almacenamiento, RNG y borrado de estado.

El servidor será un servicio de entrega de blobs MLS y de KeyPackages, no un participante con secretos. Persistirá solo:

- id público del grupo, número de época y hashes de transcript;
- commits/proposals/Welcome cifrados y firmados por clientes;
- referencia de capacidades y políticas de historial;
- acuses de entrega y metadatos mínimos de retención.

Cada alta, baja, revocación de dispositivo o cambio de identidad debe generar un commit que avance la época. La política de historial debe ser explícita: el valor seguro por defecto es que un dispositivo nuevo solo lea desde su época de alta. Transferir historial anterior requiere un flujo separado, aprobado por un dispositivo existente, cifrado para el nuevo dispositivo y visible al usuario. Las historias privadas deben usar el mismo criterio; no se puede prometer que un equipo recién añadido descifre publicaciones anteriores sin diseñar esa transferencia.

No mezclar MLS y v1 dentro de un mismo mensaje sin un campo de protocolo. Los grupos existentes se migran creando una época MLS inicial confirmada por todos los dispositivos compatibles; quienes no acepten la migración permanecen en un grupo v1 de solo lectura hasta una decisión explícita de los administradores.

### 4. Llamadas grupales y LiveKit

Mantener el worker E2EE de LiveKit, pero reemplazar gradualmente la distribución actual de claves de medios por mensajes protegidos con las sesiones directas v2 o por exporters MLS, después de un diseño y auditoría. Las claves de medios deben estar ligadas a `callId`, identidad de sala, época de roster, emisor, receptor y vencimiento; nunca deben viajar en tokens LiveKit ni en la señalización sin E2EE.

La documentación de [LiveKit](https://docs.livekit.io/transport/encryption/) confirma que sus claves son responsabilidad de la aplicación y que señalización/API no son E2EE. La prueba de aceptación debe cubrir Chromium, Android, iOS, escritorio, reinicio de worker, participante que entra/sale, rotación de cámara/pantalla, pérdida de red, renegociación y clientes incompatibles. Una llamada no debe degradarse silenciosamente a medios sin E2EE.

### 5. TURN, IP y secretos operativos

Cambiar `WebRtcOptions.IceServers` estático por un emisor autenticado de credenciales TURN ligadas a usuario, dispositivo y llamada. Con CoTURN en modo TURN REST, el backend calcula un usuario temporal con vencimiento y un HMAC; el servidor TURN valida ese HMAC con un secreto compartido. [CoTURN documenta](https://github.com/coturn/coturn/blob/master/README.turnserver) `--use-auth-secret` y este formato de credenciales temporales.

El secreto TURN debe vivir solo en el gestor de secretos y no en appsettings, respuestas de logs, auditoría ni clientes más allá del TTL. Ofrecer `RelayOnly` como modo de máxima privacidad para llamadas directas y fallar claramente si no hay relay disponible. Esto oculta la IP del par a costa de latencia/ancho de banda, pero el relay conserva metadatos de conexión. Las llamadas grupales dependen además de la topología y configuración de LiveKit; no asumir que la política ICE directa se traslada automáticamente a sus SFU.

Operación mínima: TLS válido en TURN (`turns:`), UDP y TLS/TCP, límites de asignación/ancho de banda, rotación del secreto TURN, firewall de puertos relay, métricas sin contenido, HSTS/TLS en el borde HTTP, gestor de secretos, lista de retención/borrado de metadatos y pruebas de fuga de IP con y sin relay-only.

## Orden de entrega y puertas de seguridad

1. Inventario de metadatos, modelo de amenazas, formato versionado y telemetría de capacidades sin secretos.
2. Identidad raíz, credenciales de dispositivos, código de comparación, QR y alertas; luego transparencia de llaves y verificación persistida localmente.
3. Piloto cerrado de directos v2 con libsignal, vectors, pruebas de mensajes fuera de orden, pérdida de estado, dispositivo nuevo/revocado y auditoría de código.
4. Migración de grupos nuevos a MLS, con interop contra vectors RFC, auditoría de estados/commits y política de historia aprobada.
5. Distribución de claves LiveKit sobre el canal nuevo, revisión independiente de medios y pruebas físicas de todas las plataformas.
6. TURN efímero, relay-only, pentest, revisión de dependencias/SBOM, auditoría criptográfica externa y ejercicio de respuesta a compromisos.

Hasta superar estas puertas, la frase correcta sigue siendo: "contenido cifrado en cliente con limitaciones documentadas". No corresponde afirmar equivalencia o superioridad frente a Signal ni prometer anonimato, cero metadatos o imposibilidad de peritaje.
