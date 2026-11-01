# Piloto criptográfico Nivra

Piloto local ejecutable con `@signalapp/libsignal-client` **0.106.1**, fijado en el lockfile. Usa la implementación Rust de Signal para establecer sesiones y avanzar el ratchet; el payload Nivra se cifra con una clave AES-256-GCM aleatoria por mensaje. La clave de contenido viaja únicamente dentro del mensaje protegido por libsignal. Esta composición es experimental y requiere revisión independiente.

```powershell
cd crypto/ratchet-pilot
npm ci --ignore-scripts
npm test
```

Requiere Node **24.18.1 o posterior** y una plataforma con binario nativo compatible. No se importa desde Angular, Electron ni la API. No publica capacidades, modifica las identidades actuales ni cambia la entrega de mensajes existentes.

El desarrollo posterior está en el [puente WASM](../ratchet-wasm/README.md) y en la [integración por etapas](../../docs/double-ratchet-etapas-2026-11-01.md): ya hay ensayos aprobados de navegador, persistencia cifrada, reserva PostgreSQL y recuperación Android con SQLCipher/Keystore. Siguen separados de los clientes publicados y de la activación de producción.

## Lo que comprueba

- Negociación real mediante preclaves clásicas y Kyber de libsignal, seguida de intercambio bidireccional y evolución del ratchet.
- Clave AES-256-GCM nueva por mensaje; conversación, mensaje, emisor y destinatario ligados al contexto autenticado.
- Recepción fuera de orden, rechazo de mensajes repetidos, identidad fijada explícitamente y rechazo de cambios sin verificar.
- Operaciones serializadas por dispositivo; avance de sesión y bytes de reintento confirmados juntos.
- Rollback del estado ante fallo de autenticación del payload: un paquete alterado no consume el mensaje legítimo posterior.
- Límites de tamaño, rechazo de formatos desconocidos y ausencia de conversión automática al cifrado anterior.

## Alcance y trabajo necesario para activación

`new PilotDevice(...)` conserva el estado en memoria. `PilotDevice.open(userId, deviceId, storage)` permite probar persistencia con `EncryptedPilotState`: cifra snapshots con AES-256-GCM y una clave externa de 32 bytes, vincula cuenta/dispositivo/revisión mediante AAD y confirma en una transacción SQLite el avance de sesión y los bytes exactos de reintento. Los escritores con revisión antigua son rechazados; una clave errónea o datos alterados no crean una identidad de reemplazo. La publicación de preclaves y el fijado de identidades también esperan a la confirmación local. `pinIdentity` ahora es asíncrono y debe esperarse con `await`.

Las **15 pruebas** incluyen reapertura de sesiones en un proceso Node nuevo, mensajes fuera de orden y repetidos después de reabrir, fallo de escritura en envío/recepción, aislamiento entre cuentas/equipos y escritura concurrente. Estos resultados no certifican los clientes publicados.

El adaptador es exclusivo del laboratorio Node: **no es IndexedDB, SQLCipher ni un gestor de secretos**. El llamador debe conservar la clave fuera del archivo y cerrar el almacén; el piloto no la guarda. Los identificadores de ámbito y revisiones son metadatos visibles. El WAL o una copia antigua del archivo podrían retener snapshots cifrados anteriores; no hay garantía de borrado físico ni defensa ante restauración completa de una copia antigua. No exportar este estado para vincular otro equipo.

Todavía faltan los adaptadores transaccionales de IndexedDB y SQLCipher, el enlace a los gestores de claves de cada plataforma, confirmaciones/retención de la bandeja (limitada a 256 mensajes), límites y retención de claves saltadas revisados, consumo atómico de preclaves en PostgreSQL y gestión de sesiones multidispositivo. El almacenamiento limita cada snapshot a 32 MiB y falla sin confirmar el avance si se supera.

La migración requiere un directorio versionado con identidades verificadas y capacidades autenticadas, puentes nativos para Android/iOS/escritorio y una solución revisada para web. No se debe copiar el material privado entre dispositivos para activar el ratchet. El historial v1/v2 conserva su protocolo y necesita una política explícita de transferencia.

El servidor debe identificar v3, validar destinatarios y rechazar clientes incompatibles antes de encender envíos v3. El backend actual no anuncia ese soporte. El cliente de producción rechaza versiones explícitas desconocidas; eso protege el límite de compatibilidad, pero no establece todavía negociación ni resistencia completa a degradación de protocolo.

Las pruebas de este directorio validan integración local; no constituyen auditoría criptográfica ni demuestran secreto hacia adelante de la aplicación publicada. JavaScript y el runtime nativo tampoco permiten garantizar borrado físico de todas las copias de claves en memoria. El código limpia los buffers temporales que controla.

La dependencia libsignal tiene licencia **AGPL-3.0-only** y sus autores indican que el uso por terceros no está soportado. Antes de distribuir la integración hay que revisar las obligaciones de licencia y fijar las plataformas/versiones soportadas. No se modifica el cifrador interno de libsignal.

Fuentes: [libsignal](https://github.com/signalapp/libsignal), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [PQXDH](https://signal.org/docs/specifications/pqxdh/).
