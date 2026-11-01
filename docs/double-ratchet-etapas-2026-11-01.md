# Double Ratchet: integración por etapas

La versión pública 8.0.1 conserva el cifrado vigente. El desarrollo nuevo está en `codex/ratchet-bridge`, sin importaciones desde los clientes publicados ni anuncios de capacidades v3. No se han reemplazado instaladores, claves actuales ni conversaciones.

## Etapa implementada: núcleo portátil y persistencia de laboratorio

- Núcleo Rust de libsignal 0.106.1 fijado al commit `904c8dc8216073b078a5f2f5090e3da8382e6a92`, compilado a WebAssembly con Rust 1.93.1. Dependencias fijadas en `Cargo.lock` y compilación `--locked`.
- Interoperabilidad con el módulo nativo oficial: identidades, firmas, establecimiento por preclaves clásicas/PQ y mensajes en ambas direcciones. Claves fijadas explícitamente antes de iniciar o recibir una sesión.
- Composición experimental Nivra con WebCrypto AES-256-GCM y una clave aleatoria por mensaje, protegida dentro de la cápsula libsignal. Conversación, identificador de mensaje, emisor y equipo destinatario forman parte del contexto autenticado.
- Cola serial por dispositivo y reintentos con los mismos bytes. Un identificador reutilizado con contenido distinto se rechaza. Se comprueban mensajes fuera de orden, repeticiones y manipulación tanto de la cápsula como del payload exterior.
- Exportación/restauración privada del motor, identidades fijadas, preclaves, sesiones, claves saltadas y marcadores de uso PQ. La exportación solo se utiliza para cifrar el snapshot completo; no debe registrarse ni transferirse a otro equipo.
- Adaptador IndexedDB separado de la base de producción. AES-256-GCM con clave externa no exportable, ámbito y revisión autenticados y comparación/escritura de revisión en una sola transacción. La operación de cifrado termina antes de abrir la transacción.
- El estado candidato del ratchet y los bytes de reintento se confirman juntos antes de devolver el mensaje cifrado al llamador. Una escritura fallida o un escritor obsoleto exige cerrar y reabrir; no devuelve un paquete para enviarlo con estado sin confirmar.
- La reapertura normal rechaza un estado ausente. Crear una identidad exige inicialización explícita. Datos ilegibles, alterados o asociados a otra cuenta/equipo no provocan un reemplazo automático.
- Bandeja entrante recuperable, confirmada junto al avance del ratchet. Conserva hasta 64 recepciones pendientes hasta que el llamador confirme su escritura en el historial. Reabrir permite recuperarlas sin volver a descifrar ni aceptar una repetición del paquete. La integración con el historial real sigue pendiente. El snapshot de la envoltura de laboratorio ahora es v2; un snapshot v1 anterior no se convierte silenciosamente.

El laboratorio usa únicamente claves y mensajes sintéticos. La clave de almacenamiento todavía debe proporcionarla el llamador; esta etapa no implementa su conservación en un gestor de secretos de producción. IndexedDB y SQLite de pruebas no garantizan borrado físico ni protección contra restaurar una copia completa antigua. El estado y la bandeja tienen límites deliberados de laboratorio.

El snapshot completo prioriza la comprobación de atomicidad. Su coste crece con las sesiones y preclaves guardadas; antes de integrarlo deben medirse dispositivos modestos y diseñarse registros/transacciones incrementales si hace falta. No se atribuye una mejora de rendimiento de la app a este laboratorio.

## Condiciones pendientes antes de activación pública

| Parte | Integración y criterio de aceptación |
| --- | --- |
| Navegador y Angular | Cargar y aislar el motor en el cliente real, ligar el estado a la cuenta/equipo autenticado y a la clave del almacén. Recuperación tras cierre de pestaña, múltiples pestañas, bloqueo, cambio de cuenta, cuota llena y pérdida de almacenamiento. |
| Android y Windows | El módulo Android aislado aprobó dos instrumentaciones con WebView, SQLCipher y Android Keystore, separadas por cierre del proceso. Aún no está integrado en Capacitor. Faltan el acoplamiento a las claves/historial reales, Electron, bloqueo del dispositivo y actualización sobre un historial existente. |
| Bandeja entrante e historial | La bandeja recuperable ya está implementada en el laboratorio. Integrarla con el historial de la app: confirmar la entrega local solo después de guardar el mensaje y deduplicar por identificador. Confirmaciones del servidor, retención y límites pendientes requieren integración. |
| Preclaves PostgreSQL | El piloto .NET/PostgreSQL ya prueba publicación y reserva atómica, cuotas y reintentos concurrentes. Falta enlazarlo al directorio autenticado y a los clientes reales, con rotación y retención de producción. Los clientes verifican identidad y firmas mediante libsignal antes de establecer una sesión. |
| Directorio y migración | Vincular la nueva identidad a la identidad/dispositivo ya verificado mediante un protocolo autenticado. Capacidades y revisión del directorio autenticadas; rechazo de degradación y cambios inesperados. No aceptar una capacidad declarada únicamente por el servidor. |
| Multidispositivo | Sesión independiente por pareja de equipos y entrega a todos los equipos autorizados, incluidos los propios. Altas, revocaciones, equipos desconectados y sesiones simultáneas. Nunca copiar un snapshot privado para vincular otro equipo. |
| Compatibilidad | Leer historial v1/v2; elegir el protocolo solo después de verificar soporte del equipo destinatario. Rechazar versiones futuras y destinatarios incompatibles antes del envío. Grupos, adjuntos, dos cuentas y transferencia de historial necesitan pruebas de extremo a extremo. |
| Activación gradual | Primero cuentas de prueba entre clientes reales, después un grupo limitado. Desactivar nuevos envíos v3 debe conservar el descifrado de los ya enviados. Medir errores sin registrar claves ni contenido. Revisar la composición y las obligaciones AGPL antes de distribución. |

Las pruebas automatizadas del laboratorio validan componentes e interoperabilidad; no equivalen a una auditoría criptográfica independiente ni atribuyen secreto hacia adelante a mensajes v1/v2 ya enviados.

## Evidencia

El flujo `.github/workflows/ratchet-wasm.yml` construye el puente sin publicar una versión de la app. Ejecuta pruebas contra libsignal nativo y Chrome real. El navegador espera el resultado de IndexedDB en tiempo real; el reloj virtual de `dump-dom` puede terminar antes de completar operaciones de almacenamiento y no sirve como evidencia suficiente para ese caso.

La evidencia de la primera sesión portátil está en [CI de interoperabilidad](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41275371294). La [validación conjunta del almacenamiento y la restauración](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41275999332), commit `bbfa8bb7089e248f8bd137ef27c963a4390cacd6`, aprobó las **15 pruebas del puente** y la página de pruebas en **Chrome real sobre Linux**. El mismo artefacto WASM aprobó las 15 pruebas en Node 24.18.1 sobre Windows. Las 15 pruebas existentes del piloto nativo también aprobaron. El lanzamiento local de Chrome fue bloqueado por revisión automática; no se atribuye esa validación al navegador Windows, a Electron ni a Android.

La [integración web/servidor](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41320951735), commit `c61b40df0132dfbd969bcc5a0b95021dee7b5eb9`, aprobó **16 pruebas del puente**, Chrome real, **18 comprobaciones PostgreSQL/HTTP** y un intercambio de ocho turnos WASM/nativo con preclaves firmadas obtenidas de la API. Incluye recuperación de mensajes entrantes, reserva simultánea e idempotente, claves agotadas, cuotas, participantes, bloqueos, revocación y rechazo de identidades/identificadores reemplazados. Las 16 pruebas del puente aprobaron también en Windows; la API compila sin advertencias ni errores y las 36 comprobaciones de seguridad HTTP previas siguen aprobando.

La [ejecución conjunta con Android](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41324748797), commit `29ef63747c60666a2740253fcfdc4fddbf34fc21`, aprobó los tres trabajos: WASM/navegador, PostgreSQL y Android. Las **dos instrumentaciones Android** se ejecutaron sobre emulador **API 35 x86_64**, con WebView **124.0.6367.219**. La segunda comenzó después de `am force-stop` del paquete de laboratorio y recuperó la identidad, los bytes de reintento, la bandeja entrante y las claves saltadas desde SQLCipher. También comprobó respuesta, conflicto de revisión, clave incorrecta, cabecera de base cifrada y clave de envoltura no exportable de Android Keystore. No es una prueba en teléfono físico, Capacitor publicado o Electron.

El APK de laboratorio tiene identificador `com.nivra.ratchetlab`, sin permiso de internet. Se verificaron ambas configuraciones Gradle: el cliente normal excluye el laboratorio y el modo de ensayo excluye el cliente y los plugins generados. El emulador local se detuvo al detectar presión de memoria; la prueba aprobada se realizó en CI. La revisión automática bloqueó por política borrar el directorio temporal local del emulador, que permanece en `artifacts/android-ratchet-avd`; no contiene cuentas reales.

## Almacén de preclaves de ensayo

La API solo expone `/experimental/ratchet/prekeys` y `/experimental/ratchet/devices/{deviceId}/prekey` si `Ratchet:PreKeyPilotEnabled=true`. El valor predeterminado es desactivado; no se agregó esta opción a la configuración publicada. No anuncia soporte v3 ni cambia `/keys` o la entrega de mensajes. Las dos tablas nuevas de la migración son adicionales; no se ha aplicado esta migración a la base pública durante estas pruebas.

La identidad de dispositivo queda fija, con un número Signal exclusivo por cuenta. Cada identificador de preclave es inmutable y existe una marca máxima que impide volver a publicar identificadores antiguos. Repetir una publicación no libera claves consumidas. La reserva utiliza transacción, bloqueo compartido entre instancias, selección `FOR UPDATE SKIP LOCKED`, identificador de petición y contexto de conversación. Una respuesta solo se devuelve después de confirmar. Una petición repetida devuelve la misma reserva, incluso tras alcanzar la cuota, siempre que el dispositivo, participantes y bloqueo sigan autorizándolo.

Los límites de ensayo son 64 claves por lote, 256 disponibles, 1024 filas por dispositivo y 32 reservas nuevas por iniciador/hora. Se acotan cuerpos, campos y base64; los campos privados/desconocidos se rechazan. El servidor comprueba la estructura pública, **no sustituye la verificación criptográfica de libsignal en los clientes** ni autentica por sí mismo una migración desde las identidades actuales. Agotar claves devuelve un error explícito y no cambia al cifrado anterior. La política de reposición, retención y recuperación debe completarse antes de producción.

Las pruebas usan un PostgreSQL efímero en CI. El ejecutable de pruebas rechaza conexiones fuera de loopback, nombres de base distintos de `nivra_ratchet_tests`, bases no vacías y ejecución sin el modo CI. Nunca lee credenciales de la configuración de la app. La imagen de PostgreSQL y las acciones de CI están fijadas por digest/commit.

Fuentes del protocolo: [libsignal](https://github.com/signalapp/libsignal), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [PQXDH](https://signal.org/docs/specifications/pqxdh/) y [Sesame](https://signal.org/docs/specifications/sesame/).
