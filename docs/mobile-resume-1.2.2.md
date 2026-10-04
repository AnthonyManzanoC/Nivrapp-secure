# Nivra 1.2.2 — regreso a Android y verificación

## Cambios
- Verificación de identidad: contenedor desplazable, QR adaptable al ancho y controles táctiles; conserva la comparación explícita y el bloqueo si cambian las claves.
- Enlaces Android: `/recover` conserva el fragmento al abrir la app en frío o cuando ya está abierta. La confirmación sigue requiriendo el botón del usuario, para que los escáneres de correo no consuman el token.
- Cuenta: consulta nuevamente el correo confirmado al recuperar foco/visibilidad o recibir la reanudación nativa. Publica el resultado dentro de NgZone, limpia el formulario al confirmar y conserva el último estado conocido si no hay red.
- Reanudación: agrupa eventos simultáneos de sincronización. Atrás en la raíz Android minimiza la actividad; los modales y la navegación de Ionic mantienen prioridad.

## Alcance real
Esta entrega mantiene Angular/Ionic dentro de Capacitor y los módulos Android existentes. No es una reescritura de toda la interfaz en Kotlin/Compose. No añade sesiones de autenticación al reanudar. La reconexión de SignalR es distinta de iniciar sesión.

No hay un teléfono conectado por ADB durante esta revisión. No se ha identificado todavía si el teléfono reportado recrea la actividad por presión de memoria, restricciones del fabricante u otra causa. Android puede terminar procesos; esta entrega no garantiza mantener un WebView o una llamada indefinidamente tras una terminación del sistema.

## Validación física pendiente
1. Abrir llamada entre dos teléfonos, compartir pantalla, salir con Inicio, volver desde recientes/icono y repetir con bloqueo/rotación. Comprobar que el ID del dispositivo no cambia y que continúa el audio.
2. Abrir el correo de verificación con Nivra abierta y cerrada, pulsar Confirmar mi correo y regresar a Cuenta. Comprobar estado verificado sin reenviar correo.
3. En pantalla pequeña y teclado abierto, desplazar QR hasta Comparar y Volver. Comparar con el contacto antes de aceptar; no aprobar códigos de prueba.

CoTURN y protocolos experimentales permanecen fuera de esta versión. APK de pruebas con firma debug.

Validación automatizada: 111 pruebas Angular correctas; build web de producción correcto. Persisten advertencias de presupuesto del bundle y SCSS existentes. La vista previa no pudo recuperar las llaves del contacto usado, por lo que no se validó visualmente un QR real completo en esta sesión.
