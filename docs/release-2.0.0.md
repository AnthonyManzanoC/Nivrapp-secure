# Nivra 2.0.0

## Chats y bienvenida

La cabecera de Chats reúne compartir el pase, crear un grupo y actualizar en un menú de tres puntos con acciones reales. El buscador separa las conversaciones locales de la búsqueda de personas por alias o ID privado. Las respuestas antiguas no reemplazan una búsqueda nueva ni los datos de otra cuenta. La bienvenida explica cómo iniciar un chat, crear un grupo, publicar una historia y compartir el pase; cada opción abre su recorrido correspondiente. El permiso de notificaciones se solicita con una acción explícita.

## Verificación rápida

Al abrir la pantalla se consultan las llaves actuales y se comprueba su continuidad con la huella guardada en este dispositivo. Un código ya comparado conserva su estado si las llaves coinciden. Una primera comprobación o un cambio de llaves no se convierte automáticamente en una identidad verificada. El cambio real continúa bloqueado hasta comparar con el contacto.

La cámara y la imagen QR comparan y guardan una coincidencia exacta sin copiar ni escribir el código. El código manual y el pegado explícito quedan en Otros métodos. Antes de guardar se vuelve a consultar el directorio y se valida la misma cuenta, dispositivo, contacto y huella. Salir, cancelar, bloquear la app o cambiar de cuenta cancela el escáner y descarta operaciones tardías.

Esta comprobación local no equivale al directorio auditable de transparencia de claves utilizado por WhatsApp. La interfaz describe el resultado real: continuidad de las llaves o identidad comparada por el usuario. Referencia: [WhatsApp Key Transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/).

## Llamadas y salas

La captura de cámara se comparte entre solicitudes concurrentes y su estado se confirma al terminar los permisos y la captura. Esto evita que el estado remoto antiguo apague la vista del participante que acaba de contestar. Las publicaciones LiveKit sincronizan su estado al silenciar, reactivar y reconectar.

En grupos, Salir conserva la sala mientras quedan participantes. El iniciador dispone además de Finalizar para todos; el servidor exige su dispositivo y sesión activos. La cabecera y el aviso del chat muestran Unirse cuando existe una sala activa, incluso después de salir o volver a abrir la app. Las respuestas de una sala terminada no pueden volver a mostrarla ni borrar una sala nueva.

Cada evento final de llamada usa un identificador de resumen compartido por todos los participantes. El servidor serializa su inserción y sólo permite el resumen reservado para un evento terminal real. El cliente valida y presenta los datos canónicos; los duplicados históricos se reúnen al mostrar el chat. El protocolo de llamadas sigue siendo 2 y no se añade una migración de datos en esta versión.

## Android: avisos y actualizaciones

El registro FCM se renueva desde código nativo aunque la WebView esté dormida. La credencial de renovación está cifrada por Android Keystore y sólo sirve para registrar avisos en el dispositivo autorizado; no entrega mensajes ni amplía la sesión. Los avisos validan su cuenta y dispositivo destinatarios. Cerrar sesión o cambiar de cuenta elimina también los avisos y la pantalla de llamada anteriores. La configuración completa y los límites del sistema están en [android-background-calls-2.0.0.md](android-background-calls-2.0.0.md).

El APK consulta una vez al día el manifiesto público del servidor y ofrece descarga con progreso. También se puede consultar desde Cuenta. La descarga sólo acepta el asset versionado del repositorio de Nivra por HTTPS, verifica tamaño y SHA-256 y exige el mismo paquete, certificado y un código de versión superior. Android confirma la instalación; una llamada o el bloqueo de la app suspende la entrega al instalador. Cancelar invalida una instalación pendiente y elimina únicamente su archivo temporal. No se instala automáticamente en segundo plano.

La versión 2.0.0 es el primer APK con este actualizador. Debe instalarse una vez sobre el APK anterior para recibir las ofertas de futuras versiones. Conserva la firma existente y utiliza versionCode 21. El manifiesto `Nivra.Api/android-release.json` se genera a partir del APK final y se publica con el servidor. Cada versión posterior necesita un código superior, sus hashes y un asset público con la URL exacta del manifiesto.

La herramienta [publish-android-release.ps1](../tools/publish-android-release.ps1) crea primero una release borrador del commit publicado, carga APK, ZIP Windows, hashes y manifiesto, comprueba sus digests de GitHub y finalmente la publica. No reemplaza assets ni releases ya publicados.

## Despliegue

La web se despliega desde GitHub en Vercel. El backend necesita `Manual Deploy → Deploy latest commit` en Render. `GET /health/ready` debe devolver versión 2.0.0 y protocolo 2. `pushFcmReady` permite comprobar si FCM está configurado realmente; Web Push por sí solo no habilita los avisos del APK. `GET /client/android-release` debe servir versión 2.0.0, código 21 y el hash del APK publicado.

No se ha realizado una llamada física con el Mac ni una prueba de suspensión prolongada en el teléfono del usuario. Las pruebas automatizadas y las inspecciones visuales no sustituyen esas comprobaciones de cámara, permisos y entrega del sistema.

## Validación y paquetes

Pasaron 442 pruebas unitarias Angular, dos pruebas con conexiones WebRTC reales en Chrome y once pruebas Android. El backend pasó 89 comprobaciones de llamadas, 28 de historial, 24 de push y doce de manifiesto Android. PostgreSQL confirmó cero migraciones pendientes y serialización de ocho transacciones reales. Diez catálogos tienen las mismas 1067 claves y sus parámetros.

La compilación Angular de producción terminó con hash `9f8ea28c2f5f634d`. Conserva los avisos conocidos de Sass `@import` y del presupuesto inicial: 2,94 MB, aproximadamente 597 kB transferidos. No se ampliaron los presupuestos. Se revisaron muestras de CSS real de Chats y verificación en móvil/escritorio, temas claro/oscuro y estados de identidad; estas muestras usan datos ficticios. Los recorridos interactivos se validaron mediante pruebas automatizadas.

APK: `Nivra-2.0.0-debug.apk`, 81.696.214 bytes, código 21, firma v2 y certificado anterior SHA-256 `e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`. Su SHA-256 es `36a9ddc677ab83c7a0b8de57d20c0a1a3b336ddfffae5a7805e1774b0774f4c3`.

Windows: `Nivra-2.0.0-win32-x64.zip`, 151.043.576 bytes; FileVersion y ProductVersion 2.0.0. Su SHA-256 es `345fb02a52adc6c5d6e035e0100f58426b15560939533ee1778bbd09d4fa5a6e`. Los 1421 archivos web del APK y Windows coinciden por SHA-256 con producción; `.well-known/assetlinks.json` se sirve desde la web y aapt lo excluye del APK.
