# Nivra 4.2.1

Corrige la recuperación del historial entre dispositivos y la continuidad del almacenamiento cifrado, y mejora la carga de conversaciones y mensajes. Android versionCode 30; protocolo de llamadas 2. Conserva las claves, los formatos cifrados y el canal permanente de actualización de 4.2.0.

## Recuperación autorizada del historial

Los eventos recibidos durante una consulta se procesan después de terminarla; no se pierden cuando otra petición está en vuelo. Una solicitud que devuelve 404 o 410 deja de reutilizarse y se renueva de forma acotada. Un fallo al consultar solicitudes para autorizar otros equipos ya no impide consultar la respuesta del equipo actual.

La aceptación en el origen solo comparte el paquete cifrado después de comparar y confirmar el código. La interfaz distingue espera, comprobación, importación y recuperación incompleta. No da por terminado el historial simplemente porque haya llegado una respuesta: el destinatario vuelve a descifrar los mensajes pendientes y actualiza las conversaciones afectadas. Si falla esa actualización, conserva el aviso y permite repetir la lectura con las claves ya importadas, incluso si la solicitud anterior venció o no hay conexión.

Una transferencia autorizada válida puede reparar una copia histórica de la misma cuenta cuya clave privada guardada resulte ilegible o inválida. Se sigue comprobando el par de claves P-256, la cuenta, los dispositivos, el código, el vencimiento y la correspondencia del paquete. No se exportan claves de otra cuenta por coincidencia de alias y no se transmite texto sin cifrar.

Las recuperaciones simultáneas se ordenan y esperan al bootstrap anterior para evitar que una lectura antigua vuelva a introducir mensajes protegidos después de recuperar sus claves. Una lectura tardía de caché tampoco puede reemplazar un mensaje ya legible o una edición actual. La consulta de mensajes por HTTP y la caché local no esperan a que conecte SignalR.

## Almacenamiento local

La aplicación distingue apertura, reintento, disponibilidad y error. El reintento comparte una reapertura real de SQLite, repite la reconciliación que hubiera fallado y evita volver a abrir un handle que ya está abierto. Los fallos transitorios del puente o del almacén seguro disponen de una recuperación acotada, sin eliminar la base ni sustituir sus secretos.

La primera clave de cifrado local se crea sin sobrescribir la que haya ganado otra operación concurrente. Las transacciones de IndexedDB se abren después de terminar la criptografía asíncrona, para evitar cierres prematuros y pérdida de escrituras de lotes. Las operaciones antiguas no pueden repoblar almacenamiento que está siendo borrado por un cierre seguro.

Recibir conversaciones desde la nube no oculta un fallo real de SQLite. El aviso desaparece cuando la apertura local se confirma; mientras se reintenta muestra actividad y evita solicitudes duplicadas.

## Carga y diseño

Las listas vacías muestran siluetas durante su carga real. Cuando ya hay datos, estos permanecen visibles con un indicador compacto. La conversación muestra siluetas mientras obtiene sus mensajes, con estados ligados al trabajo real y sin esperas artificiales. Los mensajes legibles se conservan durante una actualización.

La vinculación tiene una presentación más compacta, código legible y controles de confirmación, progreso y reintento. Respeta los temas claro y oscuro, las zonas seguras, RTL, teclado y reducción de movimiento. Los textos nuevos están traducidos a los diez idiomas.

## Validación y límites

Pasaron 144 pruebas focalizadas de Angular, 28 comprobaciones de seguridad del historial en .NET y 32 pruebas unitarias Android. Las regresiones incluyen criptografía Web Crypto real entre un origen protegido y un destinatario independiente, transporte conforme al contrato HTTP sin SignalR, fallos de red, reparación de claves ilegibles, almacenamiento nativo simulado e IndexedDB real aislado.

Se verificó también el recorrido en el navegador con el bundle de producción, dos orígenes y almacenes independientes: el destino no podía descifrar el mensaje inicial; después de comparar el código y autorizar en la interfaz del origen, lo recuperó sin recargar. SignalR estuvo indisponible durante esta prueba. Se comprobaron las siluetas móviles con peticiones retenidas y la conservación del mensaje legible durante la siguiente actualización.

La compilación web de producción terminó correctamente. Mantiene el aviso existente de presupuesto inicial (3,05 MB frente al objetivo de 2 MB); no se elevó el límite ni se añadieron dependencias.

La verificación de distribución comparó por SHA-256 los 1430 recursos web del paquete Windows, los 1429 incluidos en Android y los 1430 del ZIP con el build final. Comprobó las versiones de los ejecutables, Android build 30 y la misma firma APK fijada de las versiones anteriores. El manifiesto de actualización contiene los tamaños y hashes de esos binarios.

Las pruebas locales usan cuentas ficticias y no envían conversaciones a producción. No sustituyen una instalación física Android o Windows. Recuperar mensajes requiere que algún dispositivo autorizado conserve las claves necesarias y que los mensajes sigan disponibles según su política; esta versión no reconstruye claves perdidas ni mensajes ya eliminados.

El instalador Windows conserva su distribución sin firma Authenticode. El protocolo criptográfico de las conversaciones y sus límites no cambian.
