# Nivra Angular/Ionic Migration Audit

Fecha: 2026-06-01

## Decision arquitectonica

Signal separa clientes Android, iOS y Desktop en repos independientes y mantiene piezas dedicadas para servidor, llamadas y criptografia. Nivra ya esta en Angular/Ionic + Capacitor y compila para Web/Android/iOS, asi que la decision conservadora es mantener un core compartido con adaptadores por plataforma, no partir todavia en apps nativas separadas.

Capas frontend objetivo:

- `core/services`: auth, API, realtime, crypto, chat, calls.
- `core/storage`: bóveda local híbrida IndexedDB/SQLite.
- `core/repositories`: siguiente paso natural para separar conversaciones, mensajes, adjuntos, reacciones, sesiones y llaves.
- `features/*`: UI Ionic por dominio.

## Matriz SPA legado vs Angular/Ionic

| Funcion SPA legado | Estado Angular/Ionic | Servicio/componente | Contrato backend usado | Accion aplicada |
| --- | --- | --- | --- | --- |
| Firebase OTP telefono | Conectado | `AuthService`, `AuthPage` | `/api/auth/phone/verify-firebase`, `/auth/phone/complete-alias` | Conservado |
| QR multidispositivo | Conectado | `AuthService`, `AccountPage` | `/auth/qr/start`, `/auth/qr/status/{id}`, `/api/auth/qr-login`, SignalR QR | Conservado |
| Sync bootstrap | Conectado | `ChatService` | `/sync/bootstrap`, `/messages/sync?since=` | Ahora hidrata indice local antes de red y usa watermark incremental |
| Chat texto E2EE | Conectado | `ChatService`, `CryptoService` | `/conversations/{id}/messages`, `message.received` | Conservado y payload local cifrado |
| Adjuntos cifrados | Conectado | `ChatService` | `/files`, `/files/{id}/blob` | TTL del mensaje ahora propaga expiracion al archivo |
| Reacciones metadata | Conectado | `ChatService`, `ChatDetailPage` | Mensaje `System` E2EE | Conservado |
| Edicion/eliminacion | Conectado | `ChatService`, `ChatDetailPage` | `/api/messages/{id}`, `/api/chats/{id}/clear` | Conservado |
| Ver una vez/TTL | Parcial en UI | `ChatDetailPage`, `LocalHistoryService` | `deleteAfterRead`, `expiresAt`, receipts | UI agregada y apertura local marcada |
| Notas de voz | Faltaba en UI Angular | `ChatDetailPage`, `ChatService` | Adjuntos cifrados tipo audio | Grabacion MediaRecorder agregada |
| Presencia/typing/read receipts | Conectado | `SignalrService`, `ChatService` | SignalR `Typing`, `Presence`, receipts | Conservado |
| Historial local-first | Conectado | `LocalHistoryService` | IndexedDB Web/Desktop, SQLite nativo Android/iOS | Mensajes nuevos cifrados en repositorio local y watermarks persistidos |
| Llamadas WebRTC | Parcial | `CallsService`, `CallsPage` | `/calls/*`, `call.signal` | Estados endurecidos y senalizacion cifrada |
| Mensajes de llamada | Cliente E2EE | `ChatService`, `CallsService` | Mensaje `System` normal cifrado por cliente | Backend ya no inserta `system:call-log`; Angular crea finalizada/perdida/rechazada |
| UI nativa Ionic | Parcial | `ChatsPage`, `ChatDetailPage` | N/A | `ion-list`, `ion-item-sliding`, `ion-modal`, teclado Capacitor |
| FCM push | Conectado Web/Android, preparado iOS | `PushService`, `PushNotificationService` | `/push-tokens`, FCM HTTP v1 | Web Messaging conservado; Android/iOS usan Firebase Messaging nativo; llamadas entrantes salen como data-push |

## Bloqueos externos

- Android ya compila con el JDK 21 portable del workspace: `tools/jdk/jdk-21.0.11+10`. Si se compila fuera de este workspace, configurar `JAVA_HOME` a JDK 21.
- Push nativo requiere los archivos/credenciales Firebase de plataforma. Android ya tiene `android/app/google-services.json`; iOS todavia requiere proyecto nativo en macOS, `GoogleService-Info.plist` y APNs subido a Firebase. No se crean secretos desde el repo.
