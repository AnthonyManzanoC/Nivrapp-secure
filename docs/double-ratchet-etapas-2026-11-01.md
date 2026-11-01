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

El laboratorio usa únicamente claves y mensajes sintéticos. La clave de almacenamiento todavía debe proporcionarla el llamador; esta etapa no implementa su conservación en un gestor de secretos de producción. IndexedDB y SQLite de pruebas no garantizan borrado físico ni protección contra restaurar una copia completa antigua. El estado y la bandeja tienen límites deliberados de laboratorio.

El snapshot completo prioriza la comprobación de atomicidad. Su coste crece con las sesiones y preclaves guardadas; antes de integrarlo deben medirse dispositivos modestos y diseñarse registros/transacciones incrementales si hace falta. No se atribuye una mejora de rendimiento de la app a este laboratorio.

## Condiciones pendientes antes de activación pública

| Parte | Integración y criterio de aceptación |
| --- | --- |
| Navegador y Angular | Cargar y aislar el motor en el cliente real, ligar el estado a la cuenta/equipo autenticado y a la clave del almacén. Recuperación tras cierre de pestaña, múltiples pestañas, bloqueo, cambio de cuenta, cuota llena y pérdida de almacenamiento. |
| Android y Windows | Acoplar el estado al gestor de claves de la plataforma; transacciones SQLCipher en Android y protección local de Windows. Probar WebView/Electron reales, cierre del proceso, bloqueo del dispositivo y actualización sobre un historial existente. Un ensayo de Chrome no certifica Android. |
| Bandeja entrante e historial | Confirmar el mensaje recibido o una bandeja recuperable junto al avance del ratchet. Evitar que un cierre entre descifrado y guardado del historial pierda un mensaje ya consumido. Confirmaciones, retención y límites de las bandejas pendientes requieren integración. |
| Preclaves PostgreSQL | Lotes públicos por dispositivo autenticado, identificadores no reutilizables, validación de firmas y reserva/consumo atómico. Probar peticiones concurrentes desde varias instancias y reintentos idempotentes del mismo iniciador. El servidor nunca recibe claves privadas. |
| Directorio y migración | Vincular la nueva identidad a la identidad/dispositivo ya verificado mediante un protocolo autenticado. Capacidades y revisión del directorio autenticadas; rechazo de degradación y cambios inesperados. No aceptar una capacidad declarada únicamente por el servidor. |
| Multidispositivo | Sesión independiente por pareja de equipos y entrega a todos los equipos autorizados, incluidos los propios. Altas, revocaciones, equipos desconectados y sesiones simultáneas. Nunca copiar un snapshot privado para vincular otro equipo. |
| Compatibilidad | Leer historial v1/v2; elegir el protocolo solo después de verificar soporte del equipo destinatario. Rechazar versiones futuras y destinatarios incompatibles antes del envío. Grupos, adjuntos, dos cuentas y transferencia de historial necesitan pruebas de extremo a extremo. |
| Activación gradual | Primero cuentas de prueba entre clientes reales, después un grupo limitado. Desactivar nuevos envíos v3 debe conservar el descifrado de los ya enviados. Medir errores sin registrar claves ni contenido. Revisar la composición y las obligaciones AGPL antes de distribución. |

Las pruebas automatizadas del laboratorio validan componentes e interoperabilidad; no equivalen a una auditoría criptográfica independiente ni atribuyen secreto hacia adelante a mensajes v1/v2 ya enviados.

## Evidencia

El flujo `.github/workflows/ratchet-wasm.yml` construye el puente sin publicar una versión de la app. Ejecuta pruebas contra libsignal nativo y Chrome real. El navegador espera el resultado de IndexedDB en tiempo real; el reloj virtual de `dump-dom` puede terminar antes de completar operaciones de almacenamiento y no sirve como evidencia suficiente para ese caso.

La evidencia de la primera sesión portátil está en [CI de interoperabilidad](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41275371294). La [validación conjunta del almacenamiento y la restauración](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41275999332), commit `bbfa8bb7089e248f8bd137ef27c963a4390cacd6`, aprobó las **15 pruebas del puente** y la página de pruebas en **Chrome real sobre Linux**. El mismo artefacto WASM aprobó las 15 pruebas en Node 24.18.1 sobre Windows. Las 15 pruebas existentes del piloto nativo también aprobaron. El lanzamiento local de Chrome fue bloqueado por revisión automática; no se atribuye esa validación al navegador Windows, a Electron ni a Android.

Fuentes del protocolo: [libsignal](https://github.com/signalapp/libsignal), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [PQXDH](https://signal.org/docs/specifications/pqxdh/) y [Sesame](https://signal.org/docs/specifications/sesame/).
