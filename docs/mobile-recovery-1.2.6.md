# Nivra 1.2.6: reproducción y recuperación local

- El reproductor vuelve a intentar `play()` cuando llegan metadatos, el track deja de estar silenciado, se añade un track o la app vuelve a ser visible. Mantiene `playsInline` y sincroniza `muted` antes de asignar el stream. Retira los listeners al destruirse sin detener tracks compartidos.
- La apertura de SQLite comparte un máximo de tres intentos (pausas de 200 y 600 ms). Un fallo definitivo conserva la base y la clave y permite Reintentar; no crea un historial alternativo ni elimina datos.
- Los primeros 30 chats restauran su último mensaje local no caducado antes de publicar el índice. La sincronización remota existente continúa después.
- Los anillos de Chats combinan contactos y Mundo, deduplican historias y conservan las reglas de caducidad y visto/no visto. La caché separa historias públicas de las del feed de contactos.

Validación: nueve pruebas focalizadas de historial cifrado, agrupación de historias y recuperación del reproductor. Compilación de producción y empaquetado Android/Windows.

## Límites y comprobación física

No se ha reproducido el fallo en un HONOR 90 conectado. Los cambios del reproductor cubren un fallo posible de reproducción, pero no demuestran por sí solos que todo fallo de negociación o de decodificación esté resuelto.

Android controla la vida del proceso: cerrar la actividad o eliminar el proceso puede obligar a recrear la interfaz. Conservar la sesión y recuperar datos locales no equivale a mantener el WebView vivo indefinidamente. Referencia: https://developer.android.com/guide/components/activities/process-lifecycle

El servicio FCM nativo existente sigue encargado de las notificaciones cuando no hay actividad visible; esta versión no modifica su entrega. No se afirma validación física de notificaciones en reposo.

Prueba pendiente con dos teléfonos: iniciar audio, activar ambas cámaras, volver desde Inicio, cerrar y abrir con/sin red, y comprobar historias públicas y de contactos vistas/no vistas. Verificar llamadas y mensajes tras reposo prolongado. APK generado con firma debug para pruebas.
