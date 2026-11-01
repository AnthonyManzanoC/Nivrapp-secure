# Nivra 8.1.0 — cifrado híbrido y continuidad del historial

Android build 52; paquete y certificado existentes. Windows conserva el perfil de
la aplicación. La API aplica migraciones aditivas al arrancar: tablas de
preclaves, directorio y transferencia; identidad pública ampliada y dos columnas
opcionales para el cuerpo cifrado compartido. No se recifran ni borran mensajes
antiguos durante una actualización.

## Mensajes nuevos

- Web, WebView Android y Electron cargan el mismo WASM probado de vodozemac
  0.11.1 Apache-2.0. La distribución se valida contra su fuente y sus hashes
  antes de compilar la app; los textos de licencias viajan en los tres clientes.
  Se conserva la licencia propia de Nivra. Libsignal queda en los laboratorios
  históricos, fuera de los recursos distribuidos de la app.
- Saludo propio `NIVRA-PQXDH-MLKEM768-A256GCM-1`: cuatro acuerdos X25519 y una
  encapsulación RustCrypto ML-KEM-768 alimentan HKDF-SHA-256. El transcript
  firmado enlaza identidades, preclaves, dispositivos y ciphertext poscuántico.
  El secreto privado inicial del trinquete pertenece exclusivamente al emisor.
  Es una composición Nivra de tipo PQXDH, sin compatibilidad de formato con Signal.
- Cada mensaje usa un cuerpo AES-256-GCM y una cápsula ratchet independiente por
  dispositivo. El cuerpo se envía y almacena una vez incluso en grupos. El
  servidor valida las direcciones y el contexto opaco, sin recibir las llaves.
- Los mensajes de las salas Vault también usan cápsulas híbridas. Su contenido
  permanece en memoria y no se agrega al historial permanente. El estado
  ratchet conserva únicamente el paquete cifrado durante el intento de envío;
  se descarta al terminar. Las reservas requieren pertenencia activa a la sala
  y se rechazan al caducar o cerrar la sala.
- La reserva PostgreSQL es atómica, idempotente por UUID y rechaza dispositivos
  revocados o sin permiso en el chat. El receptor confirma el consumo solo
  después de autenticar y guardar la recepción. La API elimina esas preclaves
  usadas; un contador permanente impide resucitarlas mediante publicaciones tardías.
- El estado y los bytes de reintento se guardan juntos bajo cifrado local en
  IndexedDB o SQLCipher. Los conflictos entre ventanas no sobrescriben estados;
  el motor se reabre antes de reintentar. Una pérdida de estado publicado exige
  volver a vincular el dispositivo; nunca se sustituye silenciosamente su identidad.

## Historial y dispositivos

Los sobres anteriores siguen siendo legibles. Para enviar mensajes nuevos todos
los dispositivos activos del chat deben actualizarse. Un destinatario pendiente
de actualización conserva el texto en la cola local, con reintentos; no se
envía una copia nueva con el cifrado anterior. Los equipos que ya no se usan
deben desvincularse desde la cuenta. La API responde 426 a emisores antiguos al
intentar crear mensajes; las lecturas y los reintentos de mensajes ya guardados
mantienen su comportamiento.

Al vincular un equipo se solicita la aprobación de otro dispositivo autorizado.
Las páginas de historial se transfieren por sesiones híbridas independientes,
con avance y confirmaciones persistentes. Se recuperan los mensajes conservados,
sus ediciones y reacciones, incluidos registros de recepción anteriores a un
cierre inesperado. Los controles no aparecen como burbujas de mensajes.
Se verifican metadatos y permisos contra el servidor; no se restauran mensajes
de una sola vista, caducados, borrados o ajenos. Cada equipo conserva sus propias
llaves ratchet; las sesiones privadas nunca se clonan. La llave antigua se
transfiere únicamente dentro del flujo aprobado para leer historia antigua.

La cola persistente cubre textos y conserva identificadores y caducidad. Los
adjuntos mantienen su flujo existente. Los reintentos y la transferencia se
ejecutan con Nivra abierta y desbloqueada; no se promete ejecución JavaScript con
el proceso Android cerrado. El historial solo puede recuperarse si otro equipo
autorizado o el almacenamiento original todavía conserva su contenido o sus llaves.

## Verificación y operación

El workflow `ratchet-olm.yml` ejecuta pruebas Rust, WASM/JavaScript, toda la suite
Angular, PostgreSQL real y HTTP, Electron en Windows y Linux, y WebView Android
con SQLCipher/Keystore antes y después de detener el proceso. Incluye vectores
ML-KEM de referencia independientes con `@noble/post-quantum`, recepción fuera
de orden, replay, alteraciones, sesiones simultáneas, reserva concurrente,
limpieza, guardado fallido, recuperación de historial y fan-out de grupos.

Producción usa `Ratchet:Enabled=true`, `Ratchet:RequireHybrid=true`,
`Ratchet:LaboratoryClientEnabled=false` y `Ratchet:PreKeyPilotEnabled=false`.
Las variables de Render pueden reemplazar la configuración del repositorio;
`/health/ready` anuncia protocolo 5, suite y política efectiva. No se debe
activar el feed hasta que los instaladores completos estén verificados; el
servidor actualizado debe estar desplegado para iniciar sesiones nuevas.

Los resultados prueban escenarios concretos, no garantizan seguridad absoluta.
La auditoría de vodozemac no cubre el saludo ni la extensión de inicialización de
Nivra; esta integración requiere una auditoría criptográfica independiente.
