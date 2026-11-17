# Nivra 10.0.0

16 de noviembre de 2026. Android build 61.

## Comportamiento

- Web y Windows conservan la barra blanca de 68 px, ahora con microetiquetas centradas de 10 px y tooltips. El botón circular alterna el panel verde bosque con etiquetas laterales y contador, con transición de 200 ms y preferencia persistente.
- La guía presenta un paso a la vez, permite entrar directamente a Chats y separa las funciones de la ayuda de entrega. Ver la guía evita repetir su redirección; las prácticas siguen siendo opcionales.
- En móvil, el doble toque en la pestaña activa de Chats, Mundo, Bóveda o Llamadas vuelve al inicio. Cuenta conserva su gesto de cambio de cuenta. La bienvenida y el visor de historias coordinan el contraste de las barras del sistema y restauran el tema al cerrar.
- Un enlace de contacto espera la restauración de sesión antes de abrirse. Si hace falta entrar o crear una cuenta, conserva el contacto y continúa después. El enlace HTTPS verificado abre Android cuando el sistema lo permite y la Web en los demás casos.
- El recordatorio de notificaciones respeta el permiso del sistema, los ajustes y una pausa tras descartarlo. La reparación del registro se reintenta con espera progresiva al recuperar conexión o volver a la app.
- El cambio de pestañas móvil sigue el movimiento del dedo y permite completar o cancelar el gesto. Las vistas previas adyacentes son inertes y permanecen únicamente en memoria de la sesión; se excluyen formularios, secretos y contenido protegido. Una pestaña aún no visitada presenta una superficie de carga, sin activar sus funciones antes de confirmar el cambio.
- La llamada propia usa una sola barra de retorno integrada al espacio de la página, con duración y reparación de audio cuando hace falta. El botón Comunidades conserva su acceso con fondo neutro, icono verde y sin sombra verde.
- Los mensajes temporales muestran su fecha de caducidad y los de una sola vista su estado. Caducar, consumir desde otro equipo o bloquear la sesión invalida los visores y sus cachés. La intención de apertura se guarda cifrada antes de mostrar el contenido y el recibo se reintenta al recuperar conexión.
- El programador de textos permite elegir una demora o fecha y hora locales, consultar y cancelar pendientes. Usa la cola local cifrada: necesita esta cuenta abierta, desbloqueada y con conexión; si no puede enviar a la hora elegida, lo hará al volver. Los textos futuros no bloquean envíos inmediatos y su caducidad empieza al iniciar el envío, conservándose en los reintentos.
- Bóveda oculta notas, archivos y sus metadatos al bloquearse. La cuadrícula de notas aprovecha el ancho Web. Cerrar la vista de una sala persistente permite volver a abrirla sin expulsar al usuario ni cerrar la sala para todos; se respetan las reglas de borrado al salir y caducidad. Los PIN compartidos van únicamente dentro del mensaje cifrado de invitación, nunca en la URL ni en avisos push.

## Envío y dispositivos

Se corrigió un bloqueo del cliente que exigía preparar todos los equipos antiguos aunque cada participante ya tuviera un dispositivo híbrido autenticado listo. Cada participante sigue siendo obligatorio; no se degrada el cifrado ni se acepta una identidad distinta para sacar un mensaje de la cola. Las pruebas de enlace antiguas que ya no coinciden con las identidades actuales se descartan y se solicitan de nuevo.

Los reintentos HTTP de mensajes conservan identificador y cuerpo cifrado. La API deduplica la escritura. Una desconexión del emisor después de guardar el mensaje ya no cancela el aviso a sus destinatarios. El envío push tiene una cola PostgreSQL persistente, arrendamiento entre procesos, caducidad, progreso por registro y reintentos acotados. Los tokens revocados, otras cuentas y conversaciones sin membresía quedan excluidos.

Cancelar o caducar un pendiente retira también su copia de reintento cifrada. La intención de cancelación se persiste antes de limpiar para impedir reenvíos si falla un borrado. Se probó llenar el límite de 200 pendientes, retirarlos y volver a cifrar y descifrar con el WASM real, conservando identidad y otros chats.

La preferencia de dispositivo principal se calcula a partir de sesiones y equipos vigentes: Android certificado tiene prioridad, y entre varios Android lidera el de mayor antigüedad verificada. La revocación o caducidad produce sucesión automática, incluso tras retirar todos los equipos y entrar desde uno nuevo. El rol organiza las fuentes de sincronización; no concede permisos criptográficos. Desinstalar un APK sin cerrar sesión no constituye una señal inmediata al servidor.

Los dispositivos nuevos conservan direcciones y sesiones híbridas independientes. Los certificados de la identidad raíz ya confiada permiten reconocer sus nuevos equipos; una raíz distinta o un reemplazo de una llave conocida siguen bloqueándose para revisión. El registro del certificado propaga una invalidación del directorio por SignalR a las conversaciones activas; el evento nunca sustituye la comprobación de firmas.

## Historial cifrado

La identidad raíz recuperable protege un archivo independiente del estado privado de los ratchets. `HistorySyncKey` se deriva con HKDF-SHA256 del secreto de recuperación, separada por cuenta, raíz y versión. Cada mensaje usa AES-256-GCM con nonce aleatorio de 96 bits, contexto autenticado y firma de la raíz. El servidor almacena únicamente el sobre cifrado y metadatos de enrutamiento.

La escritura es inmutable por cuenta y mensaje para que varios equipos no sobrescriban sus copias. La descarga es paginada, con cursor persistente; las escrituras locales siguen protegidas y verificadas. Tanto la API como la importación vuelven a comprobar membresía, identidad del mensaje, expiración y eliminación. Los mensajes de lectura única o eliminados no vuelven por esta vía. Se limita el tamaño por mensaje y por cuenta (`HistorySync:MaxBytesPerAccount`, 128 MiB por defecto), y se podan copias caducadas o eliminadas.

Las copias disponibles pueden recuperarse en un equipo nuevo después de retirar los anteriores si se recupera la misma identidad raíz. Los mensajes que nunca se respaldaron y cuyas copias locales se perdieron no se pueden reconstruir. El archivo recuperable tiene la seguridad de su secreto raíz; no debe atribuirse al archivo la misma protección de borrado de claves pasadas de un Double Ratchet.

El motor `vodozemac` Apache 2.0 y `ML-KEM-768` se mantienen intactos.

## Validación y despliegue

- Pruebas HTTP contra PostgreSQL 17 local aislado: firmas inválidas, aislamiento entre cuentas, revocación, cambio de dispositivo, recuperación con la misma raíz y exclusión de historial borrado/caducado.
- Carga sintética: 240 mensajes, 480 solicitudes de envío concurrentes (máximo 16), cero errores, duplicados o mensajes perdidos y 24 recibos comprobados. Son sobres de prueba y una base local; no es una medición de capacidad de producción.
- Pruebas criptográficas con WebCrypto y el WASM real, regresión Angular y Electron, navegación móvil y descarga de actualizaciones.
- Suite final del cliente: 1.799 pruebas correctas. Electron: 56 pruebas correctas. Revisión visual aislada: 114 capturas en móvil y escritorio, temas claro y oscuro, sin errores de ejecución.
- Inicio de sesión y renovación simultáneos en dos APK, Web y Escritorio mediante HTTP real; revocación de todos los dispositivos y reingreso con recuperación del mismo secreto raíz. Pruebas de cierre/reapertura de salas persistentes y rechazo de accesos revocados, caducados o ajenos.
- Auditoría de paquetes: sin vulnerabilidades conocidas en dependencias de producción JavaScript ni en los paquetes .NET consultados. Persisten avisos moderados en herramientas de desarrollo; sus correcciones mayores requieren una migración aparte. Se aplicaron los parches compatibles de Hono y su servidor Node.

Los resultados finales de CI y las firmas/hashes de los instaladores se comprueban antes de publicar. Esto no constituye una auditoría externa ni una garantía de disponibilidad absoluta. Las políticas de Android, permisos, restricciones de batería, conectividad y la configuración de FCM siguen condicionando las notificaciones.

El propietario despliega las APIs. Deben incluir las migraciones nuevas de cola push, progreso por destino, plataforma y archivo de historial. Hasta actualizar las APIs, el cliente conserva sus rutas compatibles y no da por completada una sincronización que el servidor aún no soporta. No se despliegan APIs desde esta entrega.
