# Puente WebAssembly: etapa de portabilidad

Rama de desarrollo aislada. Usa el núcleo Rust de libsignal 0.106.1, fijado al commit `904c8dc8216073b078a5f2f5090e3da8382e6a92`. Incluye sesiones en memoria para pruebas; no anuncia capacidades y no está incluido en clientes ni instaladores publicados.

Esta primera comprobación construye el mismo núcleo para WebAssembly y contrasta identidades y firmas con el módulo nativo del piloto, en Node y en Chrome real. Usa exclusivamente claves sintéticas. La generación aleatoria debe proceder del sistema/WebCrypto; un fallo no se sustituye por un generador débil.

La compilación en CI usa Rust 1.93.1 y wasm-bindgen 0.2.130, con dependencias fijadas en `Cargo.lock` y `cargo build --locked`. Los artefactos generados no se publican en el feed de actualizaciones. Esto no implica soporte oficial de Signal para navegador.

La segunda comprobación contrasta sesiones bidireccionales, preclaves clásicas/PQ, mensajes fuera de orden, rechazo de repeticiones, identidades fijadas explícitamente y rollback con el piloto nativo. El checkpoint en memoria permite que el llamador valide la autenticación exterior antes de confirmar. No sustituye una transacción de disco. Después se integrarán las transacciones IndexedDB/SQLCipher, la reserva PostgreSQL, el directorio y la migración multidispositivo. El cifrado activo no se reemplaza durante esa construcción.

`web-device.mjs` reproduce en WebCrypto la composición AES-256-GCM del piloto nativo: contexto autenticado por conversación/mensaje/emisor/dispositivo destinatario, clave aleatoria por mensaje, cápsula protegida por libsignal, operaciones serializadas y bytes exactos de reintento. Su bandeja está en memoria y limitada a 256 mensajes; todavía no ofrece aceptación duradera ni confirmaciones del servidor. Un fallo del payload exterior revierte también el estado de libsignal.

`indexeddb-state.mjs` es un adaptador de snapshots cifrados, en una base **de laboratorio separada**. Recibe una clave AES-GCM de 256 bits no exportable y exige que el llamador la conserve fuera de esa base. Cifra antes de abrir la transacción IndexedDB; dentro de una única transacción compara la revisión y escribe el estado completo. Ámbito y revisión están autenticados y visibles como metadatos. No protege frente a restaurar toda una copia antigua, ni proporciona borrado físico. Todavía no está conectado a la serialización del motor WASM ni al gestor de claves real. Sus pruebas en Chrome comprueban reapertura, escritores simultáneos, rechazo de clave incorrecta y alteraciones de datos, ámbito y revisión.

Ejecución local con Node 24.18.1, después de descargar los artefactos de CI y de `npm ci --prefix crypto/ratchet-pilot --ignore-scripts`:

```powershell
node --test crypto/ratchet-wasm/tests/*.test.mjs
node crypto/ratchet-wasm/serve.mjs 8124
```

La página `http://127.0.0.1:8124/browser.html` usa exclusivamente datos sintéticos. El servidor de pruebas escucha solo en loopback y sirve una lista cerrada de archivos de laboratorio.
