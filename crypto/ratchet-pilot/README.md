# Piloto criptográfico Nivra

Piloto local ejecutable con `@signalapp/libsignal-client` **0.106.1**, fijado en el lockfile. Usa la implementación Rust de Signal para establecer sesiones y avanzar el ratchet; el payload Nivra se cifra con una clave AES-256-GCM aleatoria por mensaje. La clave de contenido viaja únicamente dentro del mensaje protegido por libsignal. Esta composición es experimental y requiere revisión independiente.

```powershell
cd crypto/ratchet-pilot
npm ci --ignore-scripts
npm test
```

Requiere Node **24.18.1 o posterior** y una plataforma con binario nativo compatible. No se importa desde Angular, Electron ni la API. No publica capacidades, modifica las identidades actuales ni cambia la entrega de mensajes existentes.

## Lo que comprueba

- Negociación real mediante preclaves clásicas y Kyber de libsignal, seguida de intercambio bidireccional y evolución del ratchet.
- Clave AES-256-GCM nueva por mensaje; conversación, mensaje, emisor y destinatario ligados al contexto autenticado.
- Recepción fuera de orden, rechazo de mensajes repetidos, identidad fijada explícitamente y rechazo de cambios sin verificar.
- Operaciones serializadas por dispositivo; avance de sesión y bytes de reintento confirmados juntos.
- Rollback del estado ante fallo de autenticación del payload: un paquete alterado no consume el mensaje legítimo posterior.
- Límites de tamaño, rechazo de formatos desconocidos y ausencia de conversión automática al cifrado anterior.

## Alcance y trabajo necesario para activación

`PilotDevice` conserva el estado **solo en memoria**. No es un almacén de producción: todavía necesita persistencia cifrada con transacciones y recuperación ante cierre/reinicio, una bandeja persistente y confirmaciones de entrega, límites y retención de claves saltadas revisados, consumo atómico de preclaves en el servidor y gestión de sesiones multidispositivo.

La migración requiere un directorio versionado con identidades verificadas y capacidades autenticadas, puentes nativos para Android/iOS/escritorio y una solución revisada para web. No se debe copiar el material privado entre dispositivos para activar el ratchet. El historial v1/v2 conserva su protocolo y necesita una política explícita de transferencia.

El servidor debe identificar v3, validar destinatarios y rechazar clientes incompatibles antes de encender envíos v3. El backend actual no anuncia ese soporte. El cliente de producción rechaza versiones explícitas desconocidas; eso protege el límite de compatibilidad, pero no establece todavía negociación ni resistencia completa a degradación de protocolo.

Las pruebas de este directorio validan integración local; no constituyen auditoría criptográfica ni demuestran secreto hacia adelante de la aplicación publicada. JavaScript y el runtime nativo tampoco permiten garantizar borrado físico de todas las copias de claves en memoria. El código limpia los buffers temporales que controla.

La dependencia libsignal tiene licencia **AGPL-3.0-only** y sus autores indican que el uso por terceros no está soportado. Antes de distribuir la integración hay que revisar las obligaciones de licencia y fijar las plataformas/versiones soportadas. No se modifica el cifrador interno de libsignal.

Fuentes: [libsignal](https://github.com/signalapp/libsignal), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [PQXDH](https://signal.org/docs/specifications/pqxdh/).
