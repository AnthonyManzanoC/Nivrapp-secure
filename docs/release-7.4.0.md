# Nivra 7.4.0 — recuperación desde el teléfono

Android build 46. Compatible con la API 7.0 y el protocolo de llamadas 2; no requiere migraciones.

## Comportamiento

El APK Android comprueba primero sus llaves guardadas y ya no crea solicitudes de recuperación hacia otros dispositivos automáticamente. Sigue recibiendo solicitudes de tus equipos vinculados: compartir las llaves requiere comparar los códigos y autorizar la vinculación. La plataforma se obtiene del entorno nativo, nunca del nombre de dispositivo enviado por el servidor.

La recuperación local mantiene los reintentos de descarga de la 7.3.0. Si una llave antigua no existe en el teléfono, conserva el mensaje protegido. En «Opciones para historial antiguo» se puede elegir «Recuperar desde otro equipo», útil después de reinstalar o cambiar de teléfono. Esta elección se limita a la recuperación actual y se olvida al completarla o cambiar de cuenta. La web y Windows conservan su recuperación y recomendación del móvil cuando corresponde.

Se reduce la frecuencia de consulta del estado pendiente local a una vez cada 30 segundos. No se consulta el directorio de dispositivos para recomendar fuentes mientras el APK permanece en modo local. Una respuesta tardía 404/410 ya no puede volver a crear una solicitud después de que el historial se haya recuperado.

## Diseño y seguridad

El teléfono muestra un aviso propio y deja las opciones excepcionales dentro de un desplegable. Los controles de recuperación y cierre tienen un área táctil de 44 píxeles, foco visible y ajuste a pantallas estrechas. Los errores de identidad conservan prioridad sobre el aviso informativo.

No se modifican algoritmos de cifrado, llaves ni reglas de aprobación. La posibilidad de actuar como fuente no significa que el teléfono posea todas las llaves históricas. Las pruebas incluyen descifrado real, recepción y aprobación de solicitudes, recuperación local sin solicitudes salientes, consentimiento explícito, aislamiento entre cuentas y cancelación de una recuperación ya terminada.

## Validación y límites

1.423 pruebas de la suite principal, dos de WebRTC y 48 de Windows aprobadas: 1.473 comprobaciones funcionales en total. También se revisaron los componentes reales a 320, 390 y 1.200 píxeles, en claro y oscuro, sin desbordamiento horizontal. Se verifican el contenido de los paquetes, versión, certificado Android y SHA-256, y las descargas públicas usadas por los actualizadores.

No se afirma validación en teléfono físico. La llave original sigue siendo necesaria para abrir mensajes cifrados con ella. El bloqueo de subidas por cuota de Supabase es independiente y sigue requiriendo resolver la cuota del proveedor.
