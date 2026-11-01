# Puente WebAssembly: etapa de portabilidad

Rama de desarrollo aislada. Usa el núcleo Rust de libsignal 0.106.1, fijado al commit `904c8dc8216073b078a5f2f5090e3da8382e6a92`. Incluye sesiones en memoria para pruebas; no anuncia capacidades y no está incluido en clientes ni instaladores publicados.

Validación: [15 pruebas de interoperabilidad/restauración y Chrome real en CI](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41275999332), también 15 pruebas con el mismo WASM en Node sobre Windows. Estas comprobaciones no certifican los clientes de producción. Estado y etapas pendientes: [integración por etapas](../../docs/double-ratchet-etapas-2026-11-01.md).

Esta primera comprobación construye el mismo núcleo para WebAssembly y contrasta identidades y firmas con el módulo nativo del piloto, en Node y en Chrome real. Usa exclusivamente claves sintéticas. La generación aleatoria debe proceder del sistema/WebCrypto; un fallo no se sustituye por un generador débil.

La compilación en CI usa Rust 1.93.1 y wasm-bindgen 0.2.130, con dependencias fijadas en `Cargo.lock` y `cargo build --locked`. Los artefactos generados no se publican en el feed de actualizaciones. Esto no implica soporte oficial de Signal para navegador.

La segunda comprobación contrasta sesiones bidireccionales, preclaves clásicas/PQ, mensajes fuera de orden, rechazo de repeticiones, identidades fijadas explícitamente y rollback con el piloto nativo. El checkpoint en memoria permite que el llamador valide la autenticación exterior antes de confirmar. No sustituye una transacción de disco. Después se integrarán las transacciones IndexedDB/SQLCipher, la reserva PostgreSQL, el directorio y la migración multidispositivo. El cifrado activo no se reemplaza durante esa construcción.

`web-device.mjs` reproduce en WebCrypto la composición AES-256-GCM del piloto nativo: contexto autenticado por conversación/mensaje/emisor/dispositivo destinatario, clave aleatoria por mensaje, cápsula protegida por libsignal, operaciones serializadas y bytes exactos de reintento. `new LabWebDevice(...)` usa memoria; `LabWebDevice.open(...)` permite ensayar persistencia cifrada del motor, preclaves, identidades fijadas, claves saltadas, marcadores de uso PQ y la bandeja de hasta 256 mensajes. Todos avanzan en una única confirmación de almacenamiento, antes de devolver el resultado al llamador. Un fallo del payload exterior revierte también el estado de libsignal; un fallo de almacenamiento exige cerrar y reabrir. No proporciona confirmaciones ni retención de mensajes del servidor.

`indexeddb-state.mjs` es un adaptador de snapshots cifrados, en una base **de laboratorio separada**. Recibe una clave AES-GCM de 256 bits no exportable y exige que el llamador la conserve fuera de esa base. Cifra antes de abrir la transacción IndexedDB; dentro de una única transacción compara la revisión y escribe el estado completo. Ámbito y revisión están autenticados y visibles como metadatos. No protege frente a restaurar toda una copia antigua, ni proporciona borrado físico. Está conectado al motor solo en el laboratorio y todavía no al gestor de claves real. Sus pruebas en Chrome comprueban reapertura de sesiones WASM, escritores simultáneos, rechazo de clave incorrecta y alteraciones de datos, ámbito y revisión.

La inicialización de una identidad nueva exige `createIfMissing: true`; la reapertura habitual rechaza un estado ausente y nunca sustituye automáticamente claves ilegibles. `exportPrivateStateForEncryption()` devuelve material **privado** exclusivamente para cifrarlo inmediatamente como una unidad. No guardarlo en texto claro, exportarlo a otro dispositivo ni incluirlo en registros. El motor conserva el control de uso PQ al restaurar, además de sus preclaves y sesiones. El adaptador Node/SQLite utilizado en las pruebas sigue siendo el laboratorio del piloto; no es SQLCipher de Android ni el almacén de producción.

Ejecución local con Node 24.18.1, después de descargar los artefactos de CI y de `npm ci --prefix crypto/ratchet-pilot --ignore-scripts`:

```powershell
node --test crypto/ratchet-wasm/tests/*.test.mjs
node crypto/ratchet-wasm/serve.mjs 8124
```

La página `http://127.0.0.1:8124/browser.html` usa exclusivamente datos sintéticos. El servidor de pruebas escucha solo en loopback y sirve una lista cerrada de archivos de laboratorio.
