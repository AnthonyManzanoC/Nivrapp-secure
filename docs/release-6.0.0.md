# Nivra 6.0.0

Cliente/API 6.0.0, Android build 36 y protocolo de llamadas 2. Esta entrega incorpora dos cuentas por instalación, difusión cifrada y preferencias de apariencia sincronizadas, con aislamiento de datos y operaciones entre sesiones.

## Dos cuentas en una instalación

Cuenta permite conservar hasta dos sesiones autenticadas, añadir una segunda, cambiar entre ellas y quitar una cuenta del dispositivo. El primer acceso a cada cuenta requiere su autenticación habitual; los cambios posteriores utilizan la sesión guardada. Cancelar el acceso de la segunda cuenta vuelve a la primera. Cerrar sesión en la cuenta activa conserva la otra y la abre cuando está disponible. Quitar una sesión conserva su historial local.

Las credenciales de ambas cuentas se guardan dentro de un registro cifrado con AES-GCM. Android y Windows utilizan el protector seguro de la instalación; la web conserva una clave no exportable en una base IndexedDB separada del historial. Las contraseñas no forman parte del registro. La migración de una sesión anterior sólo elimina su copia antigua después de guardar la sustitución protegida. Un protector inaccesible o un registro ilegible mantiene los datos y muestra un error recuperable.

Las vistas, servicios y cachés utilizan la identidad de cuenta y dispositivo. El cambio desmonta el contenido de la sesión anterior antes de presentar el siguiente. Las respuestas HTTP y los resultados tardíos de acceso, QR o cierre de sesión pierden autoridad cuando cambia la sesión. Una renovación correcta conserva el token rotado únicamente en la cuenta, dispositivo y credencial anterior correspondientes; puede actualizar las credenciales de una cuenta guardada sin copiar su perfil ni su navegación a la cuenta abierta.

La Bóveda oculta sus notas, salas y vistas previas de la cuenta anterior de forma síncrona, cierra su clave en memoria y descarta resultados tardíos de cifrado, archivos y audio. La sala seleccionada queda asociada a cuenta y dispositivo; la selección global antigua no se importa entre cuentas. El escudo de privacidad aplica la intención vigente mediante una cola, evitando que una página destruida cambie la protección de la siguiente. El historial local de llamadas también comprueba el propietario antes de conciliar o guardar una lectura atrasada.

Los controles de cambio, adición y retirada de la cuenta activa permanecen bloqueados durante una llamada activa o recuperable. El usuario debe finalizarla antes de cambiar de cuenta.

## Notificaciones y borrado por cuenta

El mismo destino push puede pertenecer a las dos cuentas guardadas. Los registros, renovaciones, avisos y acciones incluyen la cuenta y el dispositivo exactos; retirar una cuenta no elimina el registro de la otra. El toque de una notificación utiliza la cuenta de destino antes de abrir su conversación. La recepción de un aviso por sí sola no cambia la cuenta visible.

Una orden de revocación o borrado se limita a su cuenta y dispositivo. El PIN de pánico también cierra la cuenta actual y elimina sus datos locales de esta instalación, conservando la otra cuenta guardada. La pantalla de privacidad explica este alcance. Los protectores compartidos por la instalación se conservan para que la otra cuenta pueda seguir utilizándolos.

El borrado pendiente queda registrado antes de limpiar los datos. Si una operación falla, la sesión afectada permanece bloqueada para su activación y la limpieza puede reintentarse. El marcador sólo se confirma después de terminar. Una orden atrasada para un dispositivo sustituido no elimina los datos de su nueva sesión.

Los cálculos y diálogos del PIN de pánico conservan la cuenta, dispositivo y generación con que comenzaron. Un cálculo, modal o temporizador anterior no puede activar el borrado de la cuenta siguiente. La limpieza incluye las cachés externas de listas, vistas previas y agenda del propietario mediante claves completas, conservando los datos y protectores de la otra cuenta.

En Windows, mientras el proceso de Nivra permanece abierto, una segunda conexión de sólo recepción atiende a la cuenta guardada inactiva con su propia credencial. Sólo transforma identificadores de mensajes y llamadas en avisos genéricos: no descifra el contenido ni cambia la conversación visible. Un toque utiliza el cambio de cuenta protegido y respeta una llamada en curso. La reconexión utiliza esperas progresivas y recuperación lenta después de agotar los intentos rápidos, sin consultas periódicas durante una conexión sana. Cerrar por completo el EXE detiene ese canal; no se incorpora un servicio de Windows que despierte el proceso cerrado.

## Identidad y conexiones

La identidad de una cuenta privada se distingue de su visibilidad en el directorio. El perfil muestra el ID Nivra de nueve dígitos con formato legible y permite copiarlo o compartirlo. Las cuentas antiguas con un alias interno generado presentan una identidad adecuada; pueden elegir un alias memorable y comprobar su disponibilidad, conservando su ID estable y sus chats. El acceso acepta el ID o el alias correspondiente.

Las cuentas privadas nuevas reciben un alias de dos palabras legibles y cuatro cifras, generado con aleatoriedad criptográfica y comprobación de disponibilidad. «Inspirarme» prepara una sugerencia editable, sin cambiar el perfil hasta guardar. Los chats de una cuenta Nivra ID muestran una pequeña insignia de identidad privada; no constituye verificación de una persona. El origen privado se conserva aunque cambien su alias o visibilidad.

Mundo reúne contactos guardados, solicitudes recibidas, solicitudes enviadas y movimientos recientes. Aceptar, rechazar y cancelar respetan el participante autorizado y el estado de la solicitud; los cambios concurrentes no reabren solicitudes cerradas. Las actualizaciones de relaciones y perfiles se proyectan para cada cuenta destinataria. El teléfono se comparte entre contactos mutuos, y la foto sigue su política de privacidad. La búsqueda exacta por ID, alias o QR compartido continúa disponible para una cuenta oculta del directorio.

## Listas de difusión

Las listas permiten seleccionar entre 1 y 256 contactos guardados, asignar un nombre y enviar texto de hasta 10.000 caracteres. Guardar o editar una lista no envía mensajes. Cada envío utiliza conversaciones privadas independientes: las respuestas llegan a cada chat y los destinatarios no reciben la lista de las demás personas.

El nombre, los destinatarios y el seguimiento del último envío permanente se guardan dentro de un sobre cifrado para los dispositivos autorizados de la cuenta. El servidor conserva el identificador de la lista, su propietario, el número de destinatarios, las fechas, la revisión y el contenido cifrado. El envío muestra resultados por destinatario y permite continuar los destinos pendientes o sin confirmar usando identificadores estables para evitar repetir los mensajes ya confirmados. Restaurar una operación nunca la envía automáticamente.

Las difusiones respetan la duración predeterminada de mensajes temporales de la cuenta. La fecha de vencimiento se fija una vez y no se extiende con los reintentos. Su texto y operación no se conservan en la metadata de la lista: el seguimiento permanece sólo en memoria mientras la pantalla siga abierta y no venza. Antes de enviar se reemplaza por revisión cualquier seguimiento persistido anterior. Una difusión temporal vencida no se reintenta.

Las revisiones detectan cambios simultáneos. Eliminar una lista conserva sus chats y una marca de eliminación evita que una copia antigua vuelva a crearla. Un dispositivo que aún no tiene las claves necesarias muestra la lista como pendiente de recuperación. El límite del servidor es de 100 listas activas por cuenta.

## Icono de la cuenta

Original, Esmeralda y Marfil se guardan como preferencia de cuenta con revisión y sincronización entre dispositivos. Los errores de sincronización o de aplicación del icono muestran una opción de reintento y no se presentan como un cambio confirmado.

Android aplica la variante de su lanzador y Windows utiliza el puente de apariencia de la aplicación. La web cambia el icono de la pestaña y el manifiesto utilizado por el navegador. El icono de una aplicación web ya instalada puede requerir actualizar o reinstalar esa instalación según el navegador. Una instalación tiene un único icono físico: refleja la preferencia aplicada para la cuenta activa, aunque conserve otra sesión.

## Biometría y seguridad de dependencias

Se conserva Modo Seguro con PIN común por cuenta. Android utiliza el diálogo biométrico del sistema, que puede ofrecer rostro, huella o iris cuando están inscritos y disponibles para aplicaciones. La presencia de una cámara o sensor no acredita esa disponibilidad; el PIN de Nivra sigue como alternativa. La web compatible puede utilizar el autenticador de plataforma ya configurado. Véanse [la explicación de Modo Seguro](release-5.2.0.md) y [la documentación de biometría Android](https://developer.android.com/identity/sign-in/biometric-auth).

Angular se actualizó a 20.3.34 para incorporar la [corrección oficial del tratamiento de URL en XSRF](https://github.com/angular/angular/security/advisories/GHSA-jfgx-762w-99vr). Las herramientas de compilación quedaron en 20.3.41 y se actualizaron dependencias transitivas compatibles. La auditoría npm de producción del cliente y del contenedor nativo no registra vulnerabilidades conocidas; NuGet tampoco identifica paquetes vulnerables de la API. La auditoría completa conserva cinco avisos moderados transitivos de herramientas de desarrollo, todos ligados a UUID/SockJS y webpack-dev-server; su resolución automática exige cambiar la versión principal de las herramientas. No se presenta esta revisión como una auditoría criptográfica independiente.

## Compatibilidad y despliegue

La API actualizada requiere estas migraciones, conservando la base y los secretos existentes:

- `20261025042427_PrivateAccountIdentity`: identidad explícita de cuenta privada.
- `20261025071607_AccountAppearanceBroadcastLists`: preferencia del icono y listas cifradas con revisión.
- `20261025083000_ScopedPushMemberships`: unicidad push por cuenta, dispositivo y destino, para admitir las dos sesiones.

La API aplica sus migraciones al iniciar. Deben publicarse el backend compatible y los clientes coordinados: una API anterior no incorpora por instalar el nuevo APK las rutas de apariencia, difusión ni la pertenencia push a dos cuentas. La guía del [canal de actualizaciones](release-update-feed.md) describe la comprobación de versiones y artefactos antes de publicar las descargas.

## Límites y validación

El registro admite dos cuentas por instalación y origen de almacenamiento. La revocación de una sesión, la pérdida de su protector o la eliminación del almacenamiento pueden exigir autenticación o recuperación nuevamente. Conservar una sesión no sustituye el desbloqueo configurado para la cuenta.

Las notificaciones requieren permisos, un registro push válido y disponibilidad del proveedor y del sistema operativo. FCM admite prioridad alta para avisos visibles durante Doze, con tiempo de procesamiento limitado; mantener un proceso o una tarea periódica no garantiza recepción permanente. Véanse [prioridad de FCM](https://firebase.google.com/docs/cloud-messaging/android-message-priority) y [Doze y App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby). La limpieza local depende de que la instalación pueda recibir y ejecutar la solicitud; no acredita la eliminación de copias guardadas fuera de Nivra. Las listas de difusión envían texto y su confirmación de envío no acredita lectura o entrega final. Un resultado parcial conserva los destinos que aún deben resolverse.

Validación automática de esta versión:

- Angular: **1.149 pruebas aprobadas**, incluidas regresiones de aislamiento de cuentas, respuestas tardías, Bóveda, PIN de pánico, historial de llamadas, difusión y notificaciones.
- Node: **70 pruebas aprobadas** de contenedor, actualizaciones y contratos de puentes y push.
- .NET: **438 comprobaciones aprobadas**: 426 de identidad, relaciones, metadata cifrada, push, Modo Seguro, historial, infraestructura, llamadas y archivos de historias, más doce del contrato del manifiesto de entrega.
- Android JVM: **56 pruebas aprobadas**, sin errores ni omisiones, en diez suites; compilación final Gradle correcta.
- Publicación y actualizaciones: **20 comprobaciones offline aprobadas** del canal de descarga y sus validaciones.
- Auditorías de dependencias de producción del cliente y contenedor nativo sin vulnerabilidades conocidas; NuGet sin paquetes vulnerables identificados. Persisten los cinco avisos moderados de desarrollo descritos arriba.

La revisión visual de las pantallas reales de difusión utilizó contactos ficticios en tamaños de móvil y escritorio. La compilación web final genera **3,04 MB** iniciales y estima **619,77 kB** de transferencia comprimida; conserva avisos por superar los presupuestos de advertencia del paquete inicial y del estilo de Cuenta. Estos valores de compilación no equivalen a una medición en una red 2G.

El código actual suma **136.196 líneas físicas en 517 archivos**: 115.276 de aplicación y herramientas y 20.920 de pruebas. Incluye comentarios, estilos, plantillas y migraciones; excluye dependencias, binarios, resultados generados, JSON, medios y documentación. Las líneas no vacías son 121.212.

La única prueba en emulador utilizó Android 16/API 36, una AVD nueva con datos aislados y el APK final de esta entrega. Se verificaron la instalación, versión 6.0.0/build 36, bienvenida en español y navegación hasta la pantalla de acceso por ID o alias. Durante el arranque aparecieron bloqueos de System UI y otros servicios Android y controles muy lentos; tras «Esperar» el mismo emulador recuperó la navegación. La observación no equivale a una medición de rendimiento de Nivra en un teléfono físico ni a una prueba de acceso con cuentas reales.

Se verificaron los recursos distribuidos: **1.436 archivos web en Windows y ZIP y 1.435 en APK**, con las diferencias nativas contempladas por el verificador. El ejecutable y el instalador identifican 6.0.0; Android identifica `com.nivra.app`, build 36 y conserva el certificado SHA-256 `e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`.

| Paquete | Bytes | SHA-256 |
| --- | ---: | --- |
| APK | 83.492.161 | `17157cb25d9299a05ba6ebfb23fde43dc82c0eb87e4367282bc0f2caa72385b8` |
| Instalador Windows | 107.975.851 | `6df0453f139b8bed95a54af6cf68b42ee892a48f8c9938777277aa88f4fffc4a` |
| ZIP Windows | 156.751.208 | `2d2d37e644431705b03b5fba68157824fa87a77afaf5c79637591e566a55f888` |

Los paquetes y su manifiesto de actualización superaron la validación previa a publicar. La API 6.0.0 requiere desplegar el commit de esta entrega en el servicio Render activo; los cambios de rutas, listas y pertenencia push no se activan sólo al actualizar el cliente. La recepción, toque y renovación push de ambas cuentas en teléfonos físicos, con restricciones de batería y fabricantes, requieren validación de campo; las pruebas automáticas y un emulador no acreditan todos esos entornos.
