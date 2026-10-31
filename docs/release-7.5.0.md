# Nivra 7.5.0 — acceso y acciones de contacto

Android build 47. Compatible con la API 7.0 y el protocolo de llamadas 2; no requiere migraciones.

- El idioma elegido en bienvenida o acceso pasa a los ajustes de la cuenta que inicia sesión, incluso si tenía una preferencia local anterior. Los cambios directos entre cuentas abiertas conservan sus propios ajustes.
- Las superficies públicas siguen el tema del sistema, incluida Recuperación cuando existe una sesión abierta. La preferencia de tema de la cuenta se conserva al regresar a sus chats.
- Recuperación usa los diez idiomas disponibles, campos de contraseña visibles en claro y oscuro, respuestas localizadas y mensajes que no revelan si un identificador existe. Conserva el token en el fragmento sólo hasta leerlo, no lo consume al abrir la página y exige una acción explícita.
- Al cerrar la última cuenta se regresa a Bienvenida. Cerrar una cuenta cuando existe otra mantiene la sesión restante y sus credenciales.
- Fijar, Silenciar y Archivar comparten la bandeja derecha de la lista de chats. El menú de opciones sigue disponible.
- Tocar una foto de la lista abre una tarjeta de contacto con chat, voz, video e información. Tocar su imagen abre el visor existente. Las historias tienen su acceso propio. Los chats protegidos pasan por su pantalla de desbloqueo antes de acciones que requieren acceso.
- La agenda y el historial de Llamadas tienen iconos de tamaño explícito, controles táctiles amplios, avatares redondos, separadores suaves y mejor ajuste de nombres. Los cambios de estilo se limitan a la vista sin llamada activa.
- Guardar un adjunto permitido en Android crea una copia en Galería o Descargas mediante el almacenamiento público nativo. Esta acción manual no depende de activar el guardado automático. Los adjuntos restringidos y de una sola visualización conservan sus límites. Una cuenta que cambió durante la descarga no puede iniciar el guardado; un cambio durante el envío de fragmentos aborta el archivo pendiente.

## Validación

Pasaron 1.430 pruebas de la suite principal y una prueba adicional de continuidad del idioma al salir y volver a entrar. También pasan las dos pruebas WebRTC y las 48 de Windows: 1.481 comprobaciones funcionales en total. Incluyen tema público, cierre de la última cuenta, tarjeta de contacto, cambio de cuenta durante navegación y exportación, y rechazo de archivos protegidos. Se revisan los componentes reales a 320, 390 y 1.200 píxeles, en claro y oscuro.

En un emulador Android se actualizó el APK sobre la 7.1.0 conservando sus datos, se abrió el acceso y se cambió el idioma a inglés. También se abrió Recuperación y se comprobó visualmente el modo oscuro al cambiar el ajuste del sistema. La prueba detectó una colisión con los textos de correo de recuperación de Cuenta: se separaron las claves de traducción, se verificaron los diez catálogos y se repitió la revisión visual de la corrección. No se afirma validación en un teléfono físico.

La publicación verifica versión, contenido web incluido en APK y Windows, certificado Android y hashes de los instaladores. El build conserva avisos de presupuesto de estilos y del bundle inicial; no se elevaron esos límites.

La recuperación de llaves de la 7.4.0 se conserva. Los mensajes cifrados con una llave original perdida siguen necesitándola. El bloqueo de adjuntos por cuota de Supabase sigue siendo un asunto del proveedor, independiente del guardado local.
