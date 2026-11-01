# Puente WebAssembly: etapa de portabilidad

Rama de desarrollo aislada. Usa el núcleo Rust de libsignal 0.106.1, fijado al commit `904c8dc8216073b078a5f2f5090e3da8382e6a92`. Incluye sesiones en memoria para pruebas; no anuncia capacidades y no está incluido en clientes ni instaladores publicados.

Esta primera comprobación construye el mismo núcleo para WebAssembly y contrasta identidades y firmas con el módulo nativo del piloto, en Node y en Chrome real. Usa exclusivamente claves sintéticas. La generación aleatoria debe proceder del sistema/WebCrypto; un fallo no se sustituye por un generador débil.

La compilación en CI usa Rust 1.93.1 y wasm-bindgen 0.2.130. Los artefactos generados no se publican en el feed de actualizaciones. La primera ejecución produce el lockfile que debe fijarse después de revisar las dependencias; todavía no se afirma una compilación reproducible ni soporte oficial de Signal para navegador.

La segunda comprobación contrasta sesiones bidireccionales, preclaves clásicas/PQ, mensajes fuera de orden, rechazo de repeticiones, identidades fijadas explícitamente y rollback con el piloto nativo. El checkpoint en memoria permite que el llamador valide la autenticación exterior antes de confirmar. No sustituye una transacción de disco. Después se integrarán las transacciones IndexedDB/SQLCipher, la reserva PostgreSQL, el directorio y la migración multidispositivo. El cifrado activo no se reemplaza durante esa construcción.
