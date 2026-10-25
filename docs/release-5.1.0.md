# Nivra 5.1.0

Cliente/API 5.1.0; Android `com.nivra.app`, versionCode **34**. Protocolo de llamadas **2**. El cliente conserva compatibilidad con la API 5.0.0, pero la corrección del comando de revocación requiere desplegar la API nueva.

- Fuente de historial recomendada por destinatarios reales, cuenta, confianza y dispositivos disponibles, dando preferencia al APK habitual. No fuerza un origen que haya perdido las claves ni bloquea recuperaciones legítimas desde web. La aprobación compara el código y usa identidades persistidas.
- Acordeón de historias Android que se pliega por gesto incluso sin una lista larga, conservando la apertura desde el tope, el desplazamiento horizontal y la reducción de movimiento.
- Selección de audio real en llamadas/vídeo: auricular, altavoz y accesorios expuestos por la plataforma; cambio de dispositivo, revisiones de estado, permisos Bluetooth y limpieza al colgar. Escucha, micrófono y ruta permanecen separados.
- Vista grande de adjuntos con varias imágenes, añadir/quitar, documentos, vídeo, caption, giro, recorte y restauración. Los fallos parciales conservan los archivos pendientes.
- Grabación protegida frente a permisos tardíos, navegación y cambios de cuenta; se descartan capturas demasiado breves o vacías.
- Mantenimiento persistente del registro FCM con reintentos acotados y comprobación periódica, sin mantener la WebView abierta. Cancelación por cierre de sesión y protección de cuenta/época.
- Web Push distingue recepción y toque, incluso durante una actualización entre versiones.
- Comando de revocación limitado al usuario/dispositivo exactos que puede alcanzar ese equipo después de marcarlo revocado. Los eventos normales siguen excluyendo equipos revocados y tokens revocados.

Validación: **872 Angular**, **52 JVM Android**, **61 Node**, **322 comprobaciones .NET** y **20 del canal de actualización** aprobadas. QA visual de componentes reales con datos ficticios en móvil y escritorio; las conexiones de audio físicas y las particularidades de cada fabricante permanecen sin verificar.

APK, instalador y ZIP portátil compilados y verificados. Se compararon 1430 archivos web de Windows, 1429 del APK y 1430 del ZIP con la distribución de producción. Android identifica versión 5.1.0/build 34 y conserva el certificado SHA256 `e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`. Los hashes y el manifiesto de actualización se generaron a partir de los binarios finales. El paquete inicial web conserva un aviso de presupuesto: 3,10 MB, frente a un objetivo de 2 MB y un límite de error de 5 MB.

El informe [producto y métricas](product-analysis-2026-10-24.md) detalla las funciones, el conteo reproducible de fuentes y las limitaciones operativas. Los ejemplos visuales aislados de pruebas no se incluyen en la aplicación distribuida.
