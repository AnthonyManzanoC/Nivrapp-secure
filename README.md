# Nivra Backend

Backend MVP para Nivra: una app de mensajería privada, gratuita primero, con base técnica para cifrado extremo a extremo en cliente, paquetes opacos en servidor, bóveda cifrada, archivos cifrados, llamadas WebRTC y sincronización segura.

La capa de datos ya usa PostgreSQL/Supabase con Entity Framework Core y migraciones automáticas al arrancar.
El backend funciona como API pura + SignalR. El SPA vanilla original se conserva en `Nivra.Api/wwwroot_legacy` como historial y guia de migracion; el nuevo frontend vive en `nivra-app` con Angular + Ionic.

## Principios

- El backend no lee contenido de mensajes, archivos ni metadata sensible.
- Los clientes cifran antes de enviar; el servidor enruta y almacena paquetes cifrados pendientes.
- El borrado remoto es una solicitud sincronizada entre clientes, no una promesa absoluta.
- Las notificaciones deben enviarse sin contenido sensible.
- No se implementan funciones orientadas a evasión legal, ocultamiento de evidencia o abuso.

## Ejecutar

```powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"
dotnet run --project .\Nivra.Api\Nivra.Api.csproj --urls http://localhost:5055
npm --prefix .\nivra-app run start -- --host 127.0.0.1 --port 8100
```

El script del frontend usa `ng serve --force-esbuild` para que el servidor local soporte rutas profundas como `/auth` y `/app/chats`.

La API expone:

- `GET /health`
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET/PATCH /me`
- `GET/POST/DELETE /devices`
- `GET /keys/{alias}`
- `POST /keys/prekeys`
- `GET/POST/DELETE /contacts`
- `POST /contacts/radar/scan`
- `GET/POST/PATCH /conversations`
- `POST /conversations/{conversationId}/messages`
- `GET /messages/pending`
- `GET /messages/sync`
- `POST /messages/sync/ack`
- `POST /messages/{messageId}/receipt`
- `POST/GET/PUT /files`
- `GET/POST/PATCH/DELETE /vault/items`
- `POST /vault/rooms/{roomId}/invite-links`
- `POST /vault/invites/{code}/accept`
- `POST /calls/start`
- `POST /calls/{callId}/signal`
- `POST /calls/{callId}/end`
- `GET/PATCH /privacy`
- `POST/DELETE /push-tokens`
- `GET /monetization/entitlements`
- `GET /monetization/ad-catalog`
- `POST /monetization/ad-impressions`
- `GET /sync/bootstrap`
- `POST /data/delete-request`
- SignalR: `/hubs/realtime`
- Frontend Angular/Ionic: `http://localhost:8100`
- SPA legacy preservado: `Nivra.Api/wwwroot_legacy`

## Producción

Antes de producción:

1. Cambiar `Security:TokenSigningKey` por un secreto real cargado desde variables de entorno o secret manager.
2. Mover `ConnectionStrings:Supabase` a variable de entorno o secret manager antes de publicar el repo.
3. Configurar Supabase Storage S3 por variables de entorno: `Storage__Provider=SupabaseS3`, `Storage__Bucket=nivra-vault`, `Storage__Endpoint=https://<project>.supabase.co/storage/v1/s3`, `Storage__AccessKeyId` y `Storage__SecretAccessKey`.
4. Activar push real con FCM: `Push__Enabled=true`, `Push__Fcm__ProjectId=<firebase-project-id>` y `Push__Fcm__ServiceAccountJsonBase64=<service-account-json-base64>`. El cliente registra tokens en `/push-tokens`; en Capacitor se usa `@capacitor-firebase/messaging` y `@capacitor/local-notifications`.
5. Agregar rate limiting por IP, alias y dispositivo.
6. Agregar verificación de abuso sin leer contenido: límites, reputación de cuenta, reportes de perfil y bloqueo.
7. Auditar criptografía del cliente. El servidor nunca debe inventar cifrado propio para mensajes.

Hardening incluido:

- rate limiting global y especifico para auth;
- CORS por lista blanca;
- headers de seguridad;
- manejo centralizado de errores con `traceId`;
- migraciones automaticas al arrancar;
- limite de subida cifrada de 50 MB;
- logging SQL reducido en development;
- SignalR con fallback de polling en el frontend.
- reconexion SignalR con descarga y ACK por lote de `/messages/sync`;
- push FCM sin contenido sensible cuando el receptor esta fuera de SignalR.

Frontend Angular/Ionic:

- login por alias, Firebase Phone Auth y QR;
- shell responsive tipo WhatsApp/Telegram para web, PC y movil;
- lista de chats con busqueda debounce y recientes;
- detalle de chat con `ion-header`, `ion-content`, `ion-footer`, compositor y ajuste de teclado Capacitor;
- adjuntos cifrados E2EE con reserva `/files`, subida binaria, descarga y preview local;
- reacciones, recibos entregado/leido, ACK de sync y eventos de borrado/limpieza;
- historial local-first con IndexedDB en Web/Desktop y SQLite nativo en Android/iOS;
- sync incremental por watermark en `/messages/sync?since=...`;
- llamadas WebRTC con estados, limpieza de streams/tracks y mensajes de sistema creados por cliente E2EE;
- push FCM web/nativo con data-push silencioso para llamadas entrantes;
- pantallas iniciales conectadas para Mundo, Boveda, Llamadas y Cuenta;
- radar cifrado de contactos por hashes SHA-256 calculados en cliente;
- enlaces efimeros de Vault con codigo hasheado en servidor y flujo post-login;
- servicios Angular para JWT, SignalR, Firebase, WebCrypto ECDH P-256 + AES-GCM;
- salida configurada en `nivra-app/dist/nivra-app/browser` para Vercel/Capacitor;
- modo oscuro, responsive web/movil.

Pendiente de portar desde `wwwroot_legacy` en las siguientes iteraciones:

- escaner QR nativo avanzado y previews enriquecidos;
- historias multimedia y monetizacion visual completa;
- iOS requiere macOS/Xcode, `GoogleService-Info.plist` y APNs en Firebase para generar el proyecto nativo.

Artefactos locales generados:

- APK debug: `android/app/build/outputs/apk/debug/app-debug.apk`
- EXE Windows: `Nivra.Desktop/dist/Nivra-win32-x64/Nivra.exe`
- JDK 21 portable usado para Android: `tools/jdk/jdk-21.0.11+10`

## Base de datos

Paquetes usados:

- `Npgsql.EntityFrameworkCore.PostgreSQL`
- `Microsoft.EntityFrameworkCore.Design`
- `Microsoft.EntityFrameworkCore.Tools`

Migraciones:

```powershell
dotnet ef migrations add InitialNivraPostgres --project .\Nivra.Api\Nivra.Api.csproj --startup-project .\Nivra.Api\Nivra.Api.csproj --output-dir Infrastructure\Migrations
dotnet ef database update --project .\Nivra.Api\Nivra.Api.csproj --startup-project .\Nivra.Api\Nivra.Api.csproj
dotnet ef migrations has-pending-model-changes --project .\Nivra.Api\Nivra.Api.csproj --startup-project .\Nivra.Api\Nivra.Api.csproj
```

Migraciones aplicadas:

- `20260528234436_InitialNivraPostgres`
- `20260528235000_CreateSupabaseVaultBucket`
- `20260529223000_PushTokenCiphertext`
- `20260603035228_PhoneRadarVaultInviteLinks`

## Modelo gratis primero

El backend está pensado para que Nivra arranque gratis:

- cuentas gratuitas;
- bóveda limitada por cuota futura;
- llamadas P2P vía WebRTC;
- publicidad ética sin leer mensajes: `ad-catalog` solo acepta región/idioma y `ad-impressions` guarda agregados por día, campaña y placement;
- planes premium después: más bóveda, más dispositivos, backup cifrado y funciones profesionales.
