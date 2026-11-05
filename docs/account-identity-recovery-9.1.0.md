# Identidad recuperable y dispositivos firmados — 9.1.0

La identidad de la cuenta firma los subdispositivos. Cada certificado vincula el ID inmutable del equipo, su llave pública P-256 anterior y su identidad híbrida de vodozemac. Los mensajes conservan el motor Double Ratchet con ML-KEM-768 existente. La raíz de cuenta no descifra el historial ni reinicia contadores de mensajes.

## Recuperación

- La raíz se genera en el cliente con ECDSA P-256 y firmas SHA-256, separada de las llaves de mensajes.
- Se guarda una copia con AES-256-GCM. La contraseña usa PBKDF2-SHA256 con 600.000 iteraciones, sal aleatoria de 32 bytes e IV aleatorio de 12 bytes. La identidad y la cuenta forman parte de los datos autenticados.
- La alternativa de respaldo usa 256 bits aleatorios expresados como 24 palabras BIP39 en español, mediante `@scure/bip39` 2.4.0, licencia MIT. HKDF-SHA256 deriva una llave independiente para su copia de recuperación.
- Las copias que recibe la API son cifradas. Las revisiones firmadas se actualizan con comparación y sustitución dentro de una transacción para impedir sobrescrituras y reproducciones antiguas.
- La copia local usa el almacén cifrado y transaccional existente, bajo un ámbito separado por cuenta y dispositivo. No se incluye en exportaciones ordinarias de llaves de mensajes.
- La vinculación por QR aprobada puede transferir la identidad dentro de su sobre cifrado, incluso cuando se elige vincular sin historial.

La activación se intenta después de un inicio de sesión con contraseña. Las sesiones existentes pueden activarla en Cuenta → Perfil → Recuperación de cuenta. Las rutas de Firebase por teléfono conservan su comportamiento. Un restablecimiento de contraseña no sustituye la raíz. Si ya no queda una copia local, se solicita la frase de recuperación para volver a cifrar la misma raíz con la contraseña actual.

## Confianza

Un contacto ya fijado solo adopta una raíz cuando su dispositivo de cifrado previamente autenticado la respalda. Una raíz autofirmada no puede reclamar una identidad anterior. La primera identidad sigue el modelo de confianza inicial ya existente. Una vez fijada la raíz, sus dispositivos nuevos se autentican aunque los equipos anteriores hayan sido revocados. Sustituir una llave en un ID de dispositivo ya conocido sigue siendo un error. Un cambio de instalación o pérdida de llaves utiliza una dirección nueva.

La raíz no se sustituye automáticamente. Si todos los secretos y las copias de recuperación se pierden, no es posible inventar la identidad anterior. Tampoco es posible autenticar retroactivamente una raíz que un contacto nunca llegó a conocer sin una prueba anterior válida.

## Validación

Las pruebas cubren firmas y alteraciones, cuentas cruzadas, recuperación por contraseña y frase, alta simultánea, revisiones antiguas, persistencia en PostgreSQL, transferencia sin historial y una conversación real con el motor híbrido después de retirar el dispositivo anterior. Los flujos visuales usan datos ficticios y servicios sin red. Las llamadas y las rutas físicas de audio siguen necesitando pruebas con teléfonos y redes reales antes de afirmar cobertura de esos equipos.
