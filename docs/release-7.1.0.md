# Nivra 7.1.0 — protección del dispositivo y continuidad

## Cambios

- APK compilado como release, sin `debuggable` ni depuración de WebView. Se conserva el certificado existente para actualizar las instalaciones actuales. El nombre público `-debug.apk` se mantiene por compatibilidad con actualizadores antiguos y no representa el tipo de compilación desde 7.1.
- La verificación de publicación rechaza APK depurables desde 7.1 y exige el certificado fijado en `assetlinks.json`.
- Android protege la ventana durante el arranque y al ir al fondo; en Android 13+ solicita al sistema ocultar las capturas del selector de apps recientes. Modo Seguro mantiene la protección de capturas en todas las pantallas de la app. Las políticas del contacto siguen aplicándose al salir de Modo Seguro.
- Windows inicia con protección de contenido, protege las vistas en segundo plano y desactiva DevTools en paquetes distribuidos. Modo Seguro controla la protección de contenido de la ventana.
- El tercer Render se incorpora también a la lista permitida de Windows y al registro/renovación nativa de push en Android. Los respaldos continúan requiriendo salud y huella del clúster compatibles antes de recibir credenciales.
- Los adjuntos distinguen la negativa del proveedor por cuota/facturación de un fallo de conexión y conservan selección y texto para reintentar.
- Al enviar texto, la burbuja aparece inmediatamente con reloj de pendiente, sin esperar al aviso de escritura, las llaves o la respuesta HTTP. El mismo identificador del cliente permite reemplazarla por la confirmación sin duplicarla, incluso si SignalR llega primero. Ante fallo se recupera el borrador; una respuesta tardía no cambia el borrador de otra cuenta. La vista pendiente existe solo en memoria y no se anuncia como una cola persistente sin conexión.

## Incidente de subidas, 30 de octubre de 2026

La ruta S3 de Supabase respondió HTTP 402 con la razón pública `exceed_egress_quota`. La cuota agotada es la transferencia del proveedor, no el espacio libre del teléfono. Las historias y adjuntos comparten ese almacenamiento. Los tres Render apuntan al mismo bucket; cambiar de API no elimina esa restricción.

Se debe revisar Usage/Billing del proyecto con su propietario y restaurar el servicio mediante la opción que corresponda al plan o al reinicio de cuota confirmado por Supabase. Esta versión no modifica facturación, elimina archivos existentes ni afirma haber levantado la restricción. `/health/ready` comprueba la configuración compartida y las dependencias de API; no realiza una escritura S3 de prueba en cada solicitud.

## Límites de seguridad

Estas medidas reducen la exposición por depuración y capturas. No garantizan resistencia a un sistema operativo comprometido, un teléfono desbloqueado, coerción o herramientas con privilegios elevados. Las protecciones de captura dependen del sistema operativo; la web no puede bloquear todas las capturas. Modo Seguro es un control de acceso de la aplicación y no convierte un PIN de cuatro cifras en una clave criptográfica fuerte para resistir ataques sin conexión.

El protocolo de mensajes sigue usando ECDH P-256 y AES-GCM. No incorpora todavía Double Ratchet ni secreto hacia adelante comparable con Signal. La siguiente fase criptográfica requiere una implementación mantenida, migración multidispositivo y auditoría independiente, según `nivra-app/docs/cryptography-modernization-roadmap.md`. No se anuncia como indescifrable, indetectable ni equivalente a Signal.

## Compilación Android

Usar JDK 21 y el keystore existente, con sus contraseñas solo en las variables `NIVRA_ANDROID_STORE_PASSWORD` y `NIVRA_ANDROID_KEY_PASSWORD`. Ejecutar `tools/build-android-production.ps1 -Version 7.1.0` después de compilar la web y sincronizar Capacitor; después ejecutar `tools/verify-release.ps1` junto con los artefactos Windows. El script no crea ni sustituye claves de firma.

## Verificación

- Angular final: 1.398 casos aprobados. Los dos casos de conexión real de audio/vídeo pasaron ambos en la ejecución aislada; en la ejecución general anterior agotaron el tiempo de ICE y se ejecutaron por separado, sin modificar su código. Esto no equivale a una prueba física entre redes móviles distintas.
- Casos específicos de privacidad, bloqueo y conservación/reintento de adjuntos: 45 aprobados.
- Node/escritorio y comprobaciones de cuentas push: 57 aprobados.
- Android/JVM: 72 aprobados.
- Envío inmediato, deduplicación con confirmación en tiempo real, restauración de borrador, bloqueo y cambio de cuenta: 41 casos específicos de texto, adjuntos y llaves aprobados.
- APK final instalado sobre 7.0 en el emulador sin borrar datos: versión 7.1.0/código 43, inicio funcional, `run-as` denegado, ningún socket de depuración WebView del proceso y `FLAG_SECURE` al perder el foco. El selector de apps recientes muestra una tarjeta sin contenido. Capturas y registro de comprobación en `artifacts/Nivra-7.1.0-emulator-*`.
- La compilación web conserva los avisos existentes de tamaño inicial (3,08 MB), estilos de Cuenta (39,62 kB) y obsolescencia de Sass `@import`; no se aumentaron los límites para ocultarlos.
