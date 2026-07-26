# Nivra: estado de seguridad y preparación para producción

Fecha de revisión: 2026-07-25

## Resumen ejecutivo

Nivra ya cifra en el cliente los mensajes y adjuntos antes de enviarlos, conserva llaves privadas localmente y evita incluir contenido en notificaciones push. Esta revisión también migra las historias privadas a sobres cifrados por dispositivo y elimina el texto de historia que antes quedaba como `caption` legible en el servidor.

El producto todavía no debe presentarse como equivalente criptográfico de Signal ni como "indetectable". La confidencialidad del contenido y la minimización de metadatos son objetivos distintos. Un servicio operativo necesita conocer, como mínimo, cuentas destinatarias, rutas de entrega, tiempos aproximados y tamaños de paquetes; además, una llamada P2P puede revelar direcciones IP entre participantes.

## Estado por superficie

| Superficie | Estado actual | Riesgo o trabajo pendiente |
| --- | --- | --- |
| Mensajes directos | Payload por dispositivo con ECDH P-256 + AES-GCM; adjuntos AES-GCM; relleno uniforme de payload | No implementa X3DH/PQXDH + Double Ratchet. No hay secreto hacia adelante ni recuperación poscompromiso comparable con Signal |
| Mensajes de grupo | Clave de contenido AES-GCM envuelta por dispositivo | Falta rotación de clave de grupo ante cambios de miembros y un protocolo de sender keys/MLS auditado |
| Historias privadas | Sobre E2EE por dispositivo; claves de medios dentro del payload cifrado; `caption` legible eliminado | Un dispositivo agregado después de publicar no puede abrir historias anteriores; requiere estrategia explícita de historial multidispositivo |
| Historias de Mundo | Contenido público por definición; el payload sigue codificado para interoperabilidad | No ofrece confidencialidad frente al servidor porque cualquier visitante autorizado puede leerlo |
| Llamadas directas | WebRTC DTLS-SRTP, señalización cifrada con recuperación temporal, STUN/TURN configurable, negociación perfecta y recuperación ICE/cambio de red | Para conectar bajo NAT simétrico o firewalls restrictivos debe existir TURN; para ocultar IP entre pares debe activarse `WebRtc:RelayOnly`. El relay seguirá viendo metadatos de conexión |
| Llamadas grupales | LiveKit con TLS/WebRTC, reconexión, audio/video y pantalla | LiveKit E2EE de medios no está activado. Hace falta distribución de claves exclusivamente por cliente antes de afirmar E2EE grupal |
| Llaves locales | IndexedDB con envoltura mediante almacén seguro nativo cuando la plataforma lo soporta | Web puro depende de las garantías del navegador y del dispositivo; falta verificación de identidad visible y alertas de cambio de llave |
| Push | Sin contenido sensible en el payload | Proveedor push observa token, evento y tiempo aproximado |

## Cambios aplicados en esta revisión

- Visor de historias único y responsive para Mundo y anillos de chat.
- Vistas, reacciones y comentarios visibles únicamente al dueño.
- Reacción de historia idempotente: tocar la misma reacción la quita.
- Permiso de repost por historia antes de publicar y validación en API.
- Historias privadas cifradas para cada dispositivo de la audiencia.
- Audiencia de "mutuos" exacta y acceso a medios públicos/reposteados validado contra la historia vigente.
- Enlaces y correos reconocidos sin insertar HTML no confiable.
- Copia y descarga sujetas a la política de reenvío y bloqueadas para "ver una vez".
- ICE servers entregados por endpoint autenticado, soporte TURN/relay-only, ICE restart y tolerancia a desconexiones transitorias.
- Señales cifradas de oferta, respuesta e ICE conservadas solo diez minutos para recuperarlas cuando SignalR o la red cambian durante la conexión.
- Negociación resistente a ofertas simultáneas, vigilancia de conexión, reintento manual/automático y recuperación al alternar Wi‑Fi/datos.
- Cámara y micrófono pueden reabrirse si el sistema operativo termina sus pistas; video directo adaptativo hasta 1080p/30 fps.
- Videollamada continúa con audio si la cámara falla.
- Compartir audio de pantalla fuerza renegociación en llamadas directas.
- LiveKit refleja reconexión y no deja indefinidamente la interfaz en "conectando".

## Bloqueos para una afirmación tipo Signal

1. Sustituir el esquema estático actual por una implementación mantenida y auditada de PQXDH/X3DH, Double Ratchet y Sesame multidispositivo.
2. Incorporar números de seguridad, verificación QR, transparencia de llaves y avisos de cambio de identidad.
3. Diseñar rotación y revocación de claves de grupo con historial definido.
4. Distribuir claves E2EE de LiveKit por los canales cifrados del cliente y habilitar el worker E2EE en todas las plataformas.
5. Desplegar TURN con credenciales efímeras; activar relay-only para el modo de máxima privacidad.
6. Ejecutar modelado de amenazas, pruebas de penetración, auditoría criptográfica externa y revisión de dependencias/cadena de suministro.
7. Mover todos los secretos de producción a un gestor de secretos, habilitar TLS/HSTS y documentar retención/borrado de metadatos.

## Regla de comunicación de seguridad

Hasta completar los bloqueos anteriores, la descripción correcta es: "contenido cifrado en el cliente con limitaciones documentadas". No usar "igual que Signal", "cero metadatos", "imposible de detectar" o "indescifrable" como garantía.
