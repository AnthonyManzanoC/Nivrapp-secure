using System.Text.RegularExpressions;
using System.Security.Cryptography;
using FirebaseAdmin.Auth;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.SignalR;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    private static readonly Regex AliasPattern = new("^[a-zA-Z0-9_.-]{3,32}$", RegexOptions.Compiled);
    private const long MaxPlainUploadBytes = 256L * 1024 * 1024;
    private const long MaxEncryptedUploadBytes = MaxPlainUploadBytes + 4096;
    private const string MaxUploadLabel = "256 MB";
    private const string ForceWipeCode = "FORCE_WIPE";
    private const string DefaultFirebaseWebApiKey = "AIzaSyC4TZyBBy6Hj_2vgAngbuN8QD6ND48GEyg";
    private const string DefaultFirebaseWebAuthDomain = "nivra-af67e.firebaseapp.com";
    private const string DefaultFirebaseWebProjectId = "nivra-af67e";
    private const string DefaultFirebaseWebStorageBucket = "nivra-af67e.firebasestorage.app";
    private const string DefaultFirebaseWebMessagingSenderId = "1052459577646";
    private const string DefaultFirebaseWebAppId = "1:1052459577646:web:104a77188d9e03b0b10abf";
    private const string DefaultFirebaseWebVapidKey = "BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2n0qOLCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY";
    private const string DefaultFirebaseSdkVersion = "12.14.0";
    private const string StoryTargetContacts = "contacts";
    private const string StoryTargetGroup = "group";

    public static void MapNivraApi(this WebApplication app)
    {
        static object ApiInfo() => new
        {
            name = "Nivra API",
            mode = "privacy-first messaging backend",
            version = "0.2.0-postgres",
            realtime = "/hubs/realtime",
            health = "/health",
            docs = "See README.md and Nivra.Api/Nivra.Api.http"
        };

        app.MapGet("/api", () => Results.Ok(ApiInfo()));
        app.MapGet("/api/info", () => Results.Ok(ApiInfo()));
        app.MapGet("/favicon.ico", static (IWebHostEnvironment environment) =>
        {
            var legacyMark = Path.Combine(environment.ContentRootPath, "wwwroot_legacy", "assets", "nivra-mark.svg");
            return File.Exists(legacyMark)
                ? Results.File(legacyMark, "image/svg+xml")
                : Results.NoContent();
        });

        app.MapGet("/health", () => Results.Ok(new
        {
            status = "ok",
            service = "nivra-api",
            checkedAt = DateTimeOffset.UtcNow
        }));

        app.MapAuthEndpoints();
        app.MapProfileEndpoints();
        app.MapDeviceAndKeyEndpoints();
        app.MapContactEndpoints();
        app.MapDirectoryAndFriendEndpoints();
        app.MapConversationAndMessageEndpoints();
        app.MapStoryEndpoints();
        app.MapFileEndpoints();
        app.MapVaultEndpoints();
        app.MapVaultRoomEndpoints();
        app.MapCallEndpoints();
        app.MapPrivacyEndpoints();
        app.MapNotificationEndpoints();
        app.MapMonetizationEndpoints();
        app.MapDeletionAndSyncEndpoints();
    }

    private static void MapAuthEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/auth").RequireRateLimiting("auth");

        group.MapPost("/register", async Task<IResult> (RegisterRequest request, INivraStore store, NivraDbContext db, PasswordHasher hasher, TokenService tokenService, PushNotificationService pushNotifications, TimeProvider timeProvider, HttpContext http, CancellationToken cancellationToken) =>
        {
            var validation = ValidateRegister(request);
            if (validation is not null)
            {
                return validation;
            }

            var now = timeProvider.GetUtcNow();
            var phone = NormalizePhone(request.Phone);
            if (!string.IsNullOrWhiteSpace(request.Phone) && phone is null)
            {
                return Error("invalid_phone", "Envia un numero de telefono valido.");
            }

            if (phone is not null &&
                await db.Users.AnyAsync(candidate => candidate.Phone == phone && candidate.DisabledAt == null, cancellationToken))
            {
                return Error("phone_taken", "Ese telefono ya esta asociado a otra cuenta Nivra.", StatusCodes.Status409Conflict);
            }

            var user = new UserAccount
            {
                Id = NivraIds.NewId("usr"),
                Alias = PgSqlNivraStore.NormalizeAlias(request.Alias),
                DisplayName = request.DisplayName?.Trim(),
                Email = NormalizeOptional(request.Email),
                Phone = phone,
                PhoneHash = phone is null ? null : PrivacyHashes.PhoneContactHash(phone),
                PasswordHash = hasher.Hash(request.Password),
                CreatedAt = now,
                UpdatedAt = now
            };

            if (!await store.TryAddUserAsync(user, cancellationToken))
            {
                return Error("alias_taken", "Ese alias ya esta ocupado.", StatusCodes.Status409Conflict);
            }

            var device = await UpsertDeviceAsync(db, user.Id, request.DeviceName, request.HardwareId, request.KeyBundle, now, trusted: true, cancellationToken);
            var tokens = await tokenService.CreateSessionAsync(store, user, device, ClientIp(http), http.Request.Headers.UserAgent.ToString(), cancellationToken);
            await store.AddAuditAsync(user.Id, "auth.register", ClientIp(http), "Initial account and trusted device created.", now, cancellationToken);
            await NotifyContactJoinedWatchersAsync(db, pushNotifications, user.Id, user.PhoneHash, cancellationToken);

            return Results.Created("/me", new AuthResponse(ToUserResponse(user), ToDeviceResponse(device), tokens));
        });

        group.MapPost("/login", async Task<IResult> (LoginRequest request, INivraStore store, NivraDbContext db, PasswordHasher hasher, TokenService tokenService, TimeProvider timeProvider, HttpContext http, CancellationToken cancellationToken) =>
        {
            var alias = request.Alias.Trim();
            if (string.IsNullOrWhiteSpace(alias) || string.IsNullOrWhiteSpace(request.Password))
            {
                return Error("invalid_login", "Alias y password son obligatorios.");
            }

            var user = await store.FindUserByAliasAsync(alias, cancellationToken);
            if (user is null || user.DisabledAt is not null || !hasher.Verify(request.Password, user.PasswordHash))
            {
                await store.AddAuditAsync(null, "auth.login_failed", ClientIp(http), $"Alias={alias}", timeProvider.GetUtcNow(), cancellationToken);
                return Error("invalid_login", "Credenciales invalidas.", StatusCodes.Status401Unauthorized);
            }

            var now = timeProvider.GetUtcNow();
            var device = await UpsertDeviceAsync(db, user.Id, request.DeviceName, request.HardwareId, request.KeyBundle ?? new KeyBundleRequest(null, null, null, []), now, trusted: true, cancellationToken);
            var tokens = await tokenService.CreateSessionAsync(store, user, device, ClientIp(http), http.Request.Headers.UserAgent.ToString(), cancellationToken);
            await store.AddAuditAsync(user.Id, "auth.login", ClientIp(http), $"Device={device.Id}", now, cancellationToken);

            return Results.Ok(new AuthResponse(ToUserResponse(user), ToDeviceResponse(device), tokens));
        });

        group.MapPost("/phone/start", (PhoneOtpStartRequest request, PhoneOtpService otpService) =>
        {
            var phone = NormalizePhone(request.Phone);
            if (phone is null)
            {
                return Error("invalid_phone", "Envia un numero de telefono valido.");
            }

            var challenge = otpService.Start(phone);
            return Results.Accepted(value: new PhoneOtpStartResponse(challenge.ExpiresAt, challenge.DeliveryHint));
        });

        group.MapPost("/phone/verify", async Task<IResult> (PhoneOtpVerifyRequest request, NivraDbContext db, PhoneOtpService otpService, PasswordHasher hasher, TokenService tokenService, PushNotificationService pushNotifications, TimeProvider timeProvider, HttpContext http, CancellationToken cancellationToken) =>
        {
            var phone = NormalizePhone(request.Phone);
            if (phone is null || string.IsNullOrWhiteSpace(request.Code) || string.IsNullOrWhiteSpace(request.DeviceName))
            {
                return Error("invalid_phone_login", "Telefono, codigo y dispositivo son obligatorios.");
            }

            if (!otpService.TryVerify(phone, request.Code))
            {
                return Error("invalid_otp", "Codigo invalido o vencido.", StatusCodes.Status401Unauthorized);
            }

            return await CompleteVerifiedPhoneLoginAsync(
                phone,
                request.DeviceName,
                request.KeyBundle,
                request.HardwareId,
                "auth.phone_login",
                "OTP verified",
                db,
                otpService,
                hasher,
                tokenService,
                pushNotifications,
                timeProvider,
                http,
                cancellationToken);
        });

        async Task<IResult> VerifyFirebasePhone(FirebasePhoneVerifyRequest request, NivraDbContext db, PhoneOtpService otpService, PasswordHasher hasher, TokenService tokenService, TimeProvider timeProvider, PushNotificationService pushNotifications, HttpContext http, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(request.FirebaseToken) || string.IsNullOrWhiteSpace(request.DeviceName))
            {
                return Error("invalid_firebase_phone_login", "Token Firebase y dispositivo son obligatorios.");
            }

            if (!pushNotifications.TryEnsureFirebaseAdminApp())
            {
                return Error("firebase_not_configured", "Firebase Admin no esta configurado para validar telefonos.", StatusCodes.Status503ServiceUnavailable);
            }

            FirebaseToken decodedToken;
            try
            {
                decodedToken = await FirebaseAuth.DefaultInstance.VerifyIdTokenAsync(request.FirebaseToken.Trim());
            }
            catch (FirebaseAuthException)
            {
                return Error("invalid_firebase_token", "Firebase no pudo validar ese codigo telefonico.", StatusCodes.Status401Unauthorized);
            }
            catch (InvalidOperationException)
            {
                return Error("firebase_not_configured", "Firebase Admin no esta listo para validar telefonos.", StatusCodes.Status503ServiceUnavailable);
            }

            if (!decodedToken.Claims.TryGetValue("phone_number", out var phoneClaim) ||
                NormalizePhone(Convert.ToString(phoneClaim, System.Globalization.CultureInfo.InvariantCulture)) is not { } phone)
            {
                return Error("firebase_phone_missing", "El token de Firebase no trae un telefono verificado.", StatusCodes.Status401Unauthorized);
            }

            return await CompleteVerifiedPhoneLoginAsync(
                phone,
                request.DeviceName,
                request.KeyBundle,
                request.HardwareId,
                "auth.firebase_phone_login",
                $"FirebaseUid={decodedToken.Uid}",
                db,
                otpService,
                hasher,
                tokenService,
                pushNotifications,
                timeProvider,
                http,
                cancellationToken);
        }

        group.MapPost("/phone/verify-firebase", VerifyFirebasePhone);
        app.MapPost("/api/auth/phone/verify-firebase", VerifyFirebasePhone).RequireRateLimiting("auth");

        group.MapPost("/phone/complete-alias", async Task<IResult> (CompletePhoneAliasRequest request, NivraDbContext db, PhoneOtpService otpService, TokenService tokenService, PushNotificationService pushNotifications, TimeProvider timeProvider, HttpContext http, CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(request.PhoneSetupToken) ||
                string.IsNullOrWhiteSpace(request.Alias) ||
                string.IsNullOrWhiteSpace(request.DeviceName))
            {
                return Error("invalid_phone_alias", "Token, alias y dispositivo son obligatorios.");
            }

            if (!AliasPattern.IsMatch(request.Alias.Trim()))
            {
                return Error("invalid_alias", "El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.");
            }

            if (!otpService.TryGetAliasSetup(request.PhoneSetupToken, out var setup))
            {
                return Error("invalid_phone_setup", "La verificacion del telefono vencio. Pide otro codigo.", StatusCodes.Status401Unauthorized);
            }

            var user = await db.Users.FirstOrDefaultAsync(candidate =>
                candidate.Id == setup.UserId &&
                candidate.Phone == setup.Phone &&
                candidate.DisabledAt == null,
                cancellationToken);
            if (user is null)
            {
                return Error("invalid_phone_setup", "No encontramos la cuenta temporal de este telefono.", StatusCodes.Status404NotFound);
            }

            if (!user.RequiresAlias)
            {
                return Error("alias_already_completed", "Ese telefono ya tiene una cuenta lista.", StatusCodes.Status409Conflict);
            }

            var normalizedAlias = PgSqlNivraStore.NormalizeAlias(request.Alias);
            var aliasTaken = await db.Users.AnyAsync(candidate =>
                candidate.Alias == normalizedAlias &&
                candidate.Id != user.Id &&
                candidate.DisabledAt == null,
                cancellationToken);
            if (aliasTaken)
            {
                return Error("alias_taken", "Ese alias ya esta ocupado.", StatusCodes.Status409Conflict);
            }

            var now = timeProvider.GetUtcNow();
            user.Alias = normalizedAlias;
            user.DisplayName = NormalizeOptional(request.DisplayName) ?? normalizedAlias;
            user.RequiresAlias = false;
            user.IsDiscoverable = true;
            user.PhoneHash = PrivacyHashes.PhoneContactHash(setup.Phone);
            user.UpdatedAt = now;

            var device = await UpsertDeviceAsync(db, user.Id, request.DeviceName, request.HardwareId, request.KeyBundle, now, trusted: true, cancellationToken);
            db.SecurityAuditEvents.Add(new SecurityAuditEvent
            {
                Id = NivraIds.NewId("aud"),
                UserId = user.Id,
                Action = "auth.phone_alias_completed",
                IpAddress = ClientIp(http),
                Details = $"Alias={normalizedAlias}; Device={device.Id}",
                CreatedAt = now
            });

            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException)
            {
                db.ChangeTracker.Clear();
                return Error("alias_or_phone_taken", "Ese alias o telefono ya esta vinculado a otra cuenta.", StatusCodes.Status409Conflict);
            }

            otpService.ConsumeAliasSetup(request.PhoneSetupToken);
            await NotifyContactJoinedWatchersAsync(db, pushNotifications, user.Id, user.PhoneHash, cancellationToken);
            var tokens = await tokenService.CreateSessionAsync(new PgSqlNivraStore(db), user, device, ClientIp(http), http.Request.Headers.UserAgent.ToString(), cancellationToken);
            return Results.Ok(new AuthResponse(ToUserResponse(user), ToDeviceResponse(device), tokens));
        });

        group.MapPost("/qr/start", (QrLoginStartRequest request, QrLoginService qrLogin) =>
        {
            if (string.IsNullOrWhiteSpace(request.DeviceName))
            {
                return Error("invalid_device", "El nombre del dispositivo es obligatorio.");
            }

            var challenge = qrLogin.Start(request.DeviceName, request.KeyBundle, request.PublicKey, request.HardwareId);
            var syncToken = $"{challenge.Id}.{challenge.Code}";
            return Results.Ok(new QrLoginStartResponse(
                challenge.Id,
                challenge.Code,
                syncToken,
                $"nivra://login/qr?qrId={Uri.EscapeDataString(challenge.Id)}&code={Uri.EscapeDataString(challenge.Code)}&syncToken={Uri.EscapeDataString(syncToken)}",
                challenge.ExpiresAt));
        });

        group.MapGet("/qr/status/{qrId}", (string qrId, string code, QrLoginService qrLogin) =>
        {
            var challenge = qrLogin.Get(qrId, code);
            if (challenge is null)
            {
                return Results.NotFound();
            }

            return Results.Ok(new QrLoginStatusResponse(
                challenge.Authorization is null ? "pending" : "authorized",
                challenge.Authorization?.Auth,
                challenge.Authorization?.EncryptedPayload));
        });

        async Task<IResult> AuthorizeQrLogin(QrLoginAuthorizeRequest request, HttpContext http, NivraDbContext db, TokenService tokenService, TimeProvider timeProvider, QrLoginService qrLogin, IHubContext<NivraHub> hub, CancellationToken cancellationToken)
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var challenge = qrLogin.GetPending(request.QrId, request.Code);
            if (challenge is null)
            {
                return Error("invalid_qr", "QR invalido o vencido.", StatusCodes.Status410Gone);
            }

            if (string.IsNullOrWhiteSpace(request.EncryptedPayload))
            {
                return Error("invalid_qr_payload", "El payload cifrado de llaves es obligatorio.");
            }

            var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.Id == current.UserId && candidate.DisabledAt == null, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            var sourceDevice = await db.Devices.FirstOrDefaultAsync(candidate =>
                candidate.Id == current.DeviceId &&
                candidate.UserId == user.Id &&
                candidate.RevokedAt == null,
                cancellationToken);
            if (sourceDevice is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var linkedKeyBundle = KeyBundleToRequest(sourceDevice.KeyBundle);
            var device = await UpsertDeviceAsync(db, user.Id, challenge.DeviceName, challenge.HardwareId, linkedKeyBundle, now, trusted: true, cancellationToken);
            db.SecurityAuditEvents.Add(new SecurityAuditEvent
            {
                Id = NivraIds.NewId("aud"),
                UserId = user.Id,
                Action = "auth.qr_device_link",
                IpAddress = ClientIp(http),
                Details = $"SourceDevice={sourceDevice.Id}; TargetDevice={device.Id}; Qr={challenge.Id}",
                CreatedAt = now
            });
            await db.SaveChangesAsync(cancellationToken);

            var tokens = await tokenService.CreateSessionAsync(new PgSqlNivraStore(db), user, device, ClientIp(http), http.Request.Headers.UserAgent.ToString(), cancellationToken);
            var auth = new AuthResponse(ToUserResponse(user), ToDeviceResponse(device), tokens);
            var authorization = new QrLoginAuthorizedResponse(auth, request.EncryptedPayload.Trim());
            if (!qrLogin.TryAuthorize(request.QrId, request.Code, authorization))
            {
                return Error("invalid_qr", "QR invalido o vencido.", StatusCodes.Status410Gone);
            }

            await hub.Clients.Group(GroupsFor.QrLogin(request.QrId)).SendAsync("QrAuthorized", authorization, cancellationToken);
            await hub.Clients.Group(GroupsFor.QrLogin(request.QrId)).SendAsync("auth.qrAuthorized", authorization, cancellationToken);
            if (!string.IsNullOrWhiteSpace(challenge.ConnectionId))
            {
                await hub.Clients.Client(challenge.ConnectionId).SendAsync("QrAuthorized", authorization, cancellationToken);
                await hub.Clients.Client(challenge.ConnectionId).SendAsync("auth.qrAuthorized", authorization, cancellationToken);
            }
            return Results.Accepted(value: authorization);
        }

        group.MapPost("/qr/authorize", AuthorizeQrLogin);
        app.MapPost("/api/auth/qr-login", AuthorizeQrLogin).RequireRateLimiting("auth");

        async Task<IResult> AuthorizeQrLink(QrLinkAuthorizeRequest request, HttpContext http, IHubContext<NivraHub> hub, CancellationToken cancellationToken)
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(request.TargetConnectionId) || string.IsNullOrWhiteSpace(request.EncryptedPayload))
            {
                return Error("invalid_qr_authorization", "ConnectionId y payload cifrado son obligatorios.");
            }

            await hub.Clients.Client(request.TargetConnectionId.Trim()).SendAsync("qr-login-success", request.EncryptedPayload, cancellationToken);
            return Results.Accepted();
        }

        group.MapPost("/authorize-qr", AuthorizeQrLink);
        app.MapPost("/api/auth/authorize-qr", AuthorizeQrLink).RequireRateLimiting("auth");

        group.MapPost("/refresh", async Task<IResult> (RefreshTokenRequest request, INivraStore store, TokenService tokenService, CancellationToken cancellationToken) =>
        {
            var tokens = await tokenService.RefreshSessionAsync(store, request.RefreshToken, cancellationToken);
            return tokens is null
                ? Error("invalid_refresh_token", "Refresh token invalido o vencido.", StatusCodes.Status401Unauthorized)
                : Results.Ok(tokens);
        });

        group.MapPost("/logout", async Task<IResult> (HttpContext http, INivraStore store, TokenService tokenService, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            await tokenService.RevokeSessionAsync(store, current.SessionId, cancellationToken);
            await store.AddAuditAsync(current.UserId, "auth.logout", ClientIp(http), null, timeProvider.GetUtcNow(), cancellationToken);
            return Results.NoContent();
        });
    }

    private static void MapProfileEndpoints(this WebApplication app)
    {
        app.MapGet("/users/check-alias", async Task<IResult> (string alias, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var normalizedAlias = NormalizeAliasCandidate(alias);
            if (normalizedAlias is null)
            {
                return Results.Ok(false);
            }

            var current = http.GetCurrentUser();
            var occupied = await db.Users.AsNoTracking().AnyAsync(candidate =>
                candidate.Alias == normalizedAlias &&
                candidate.DisabledAt == null &&
                (current == null || candidate.Id != current.UserId),
                cancellationToken);

            return Results.Ok(!occupied);
        });

        app.MapGet("/me", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            return user is null ? Results.Unauthorized() : Results.Ok(ToUserResponse(user));
        });

        app.MapPatch("/me", async Task<IResult> (PatchProfileRequest request, HttpContext http, INivraStore store, NivraDbContext db, PushNotificationService pushNotifications, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            string? normalizedAlias = null;
            if (request.Alias is not null)
            {
                normalizedAlias = NormalizeAliasCandidate(request.Alias);
                if (normalizedAlias is null)
                {
                    return Error("invalid_alias", "El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.");
                }

                if (!string.Equals(normalizedAlias, user.Alias, StringComparison.Ordinal) &&
                    await db.Users.AnyAsync(candidate =>
                        candidate.Id != user.Id &&
                        candidate.Alias == normalizedAlias &&
                        candidate.DisabledAt == null,
                        cancellationToken))
                {
                    return Error("alias_taken", "Ese alias ya esta ocupado.", StatusCodes.Status409Conflict);
                }
            }

            string? normalizedPhone = null;
            if (request.Phone is not null)
            {
                normalizedPhone = NormalizePhone(request.Phone);
                if (!string.IsNullOrWhiteSpace(request.Phone) && normalizedPhone is null)
                {
                    return Error("invalid_phone", "Envia un numero de telefono valido.");
                }

                if (normalizedPhone is not null &&
                    normalizedPhone != user.Phone &&
                    await db.Users.AnyAsync(candidate => candidate.Id != user.Id && candidate.Phone == normalizedPhone && candidate.DisabledAt == null, cancellationToken))
                {
                    return Error("phone_taken", "Ese telefono ya esta asociado a otra cuenta Nivra.", StatusCodes.Status409Conflict);
                }
            }

            var previousPhoneHash = user.PhoneHash;
            var wasDiscoverable = user.IsDiscoverable;
            user.Alias = normalizedAlias ?? user.Alias;
            user.DisplayName = request.DisplayName?.Trim() ?? user.DisplayName;
            user.Email = NormalizeOptional(request.Email) ?? user.Email;
            user.Phone = request.Phone is null ? user.Phone : normalizedPhone;
            user.PhoneHash = request.Phone is null
                ? user.PhoneHash
                : normalizedPhone is null ? null : PrivacyHashes.PhoneContactHash(normalizedPhone);
            user.Bio = request.Bio is null ? user.Bio : NormalizeOptional(request.Bio);
            user.ProfilePhotoDataUrl = request.ProfilePhotoDataUrl is null ? user.ProfilePhotoDataUrl : NormalizeProfilePhoto(request.ProfilePhotoDataUrl);
            user.IsDiscoverable = request.IsDiscoverable ?? user.IsDiscoverable;
            user.UpdatedAt = timeProvider.GetUtcNow();
            try
            {
                await store.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException)
            {
                db.ChangeTracker.Clear();
                return Error("profile_conflict", "Ese alias o telefono ya esta asociado a otra cuenta Nivra.", StatusCodes.Status409Conflict);
            }
            if (user.PhoneHash is not null &&
                user.IsDiscoverable &&
                (!string.Equals(previousPhoneHash, user.PhoneHash, StringComparison.Ordinal) || !wasDiscoverable))
            {
                await NotifyContactJoinedWatchersAsync(db, pushNotifications, user.Id, user.PhoneHash, cancellationToken);
            }
            return Results.Ok(ToUserResponse(user));
        });
    }

    private static void MapDeviceAndKeyEndpoints(this WebApplication app)
    {
        var devices = app.MapGroup("/devices");

        devices.MapGet("/", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            return current is null
                ? Results.Unauthorized()
                : Results.Ok((await store.ActiveDevicesForUserAsync(current.UserId, cancellationToken)).Select(ToDeviceResponse).ToList());
        });

        devices.MapPost("/link", async Task<IResult> (LinkDeviceRequest request, HttpContext http, INivraStore store, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(request.DeviceName))
            {
                return Error("invalid_device", "El nombre del dispositivo es obligatorio.");
            }

            var now = timeProvider.GetUtcNow();
            var device = await UpsertDeviceAsync(db, current.UserId, request.DeviceName, request.HardwareId, request.KeyBundle, now, trusted: true, cancellationToken);
            await store.SaveChangesAsync(cancellationToken);
            await store.AddAuditAsync(current.UserId, "device.link", ClientIp(http), $"Device={device.Id}", now, cancellationToken);
            return Results.Created($"/devices/{device.Id}", ToDeviceResponse(device));
        });

        async Task<IResult> RevokeDevice(string deviceKey, HttpContext http, INivraStore store, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken)
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var normalizedDeviceKey = NormalizeHardwareId(deviceKey);
            var device = await db.Devices.FirstOrDefaultAsync(candidate =>
                candidate.UserId == current.UserId &&
                (candidate.Id == deviceKey ||
                 (normalizedDeviceKey != null && candidate.HardwareId == normalizedDeviceKey)),
                cancellationToken);
            if (device is null)
            {
                return Results.NotFound();
            }

            var revokedAt = timeProvider.GetUtcNow();
            await store.RevokeDeviceAsync(current.UserId, device.Id, revokedAt, cancellationToken);
            await store.AddAuditAsync(current.UserId, "device.revoke", ClientIp(http), $"Device={device.Id}; Hardware={device.HardwareId}", revokedAt, cancellationToken);
            var payload = new
            {
                code = ForceWipeCode,
                deviceId = device.Id,
                device.HardwareId,
                revokedAt
            };
            await hub.Clients.Group(GroupsFor.Device(device.Id)).SendAsync(ForceWipeCode, payload, cancellationToken);
            await hub.Clients.Group(GroupsFor.Device(device.Id)).SendAsync("device.revoked", payload, cancellationToken);
            await pushNotifications.SendForceWipeAsync(current.UserId, device.Id, device.HardwareId, revokedAt, cancellationToken);
            await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("device.listChanged", new
            {
                deviceId = device.Id,
                device.HardwareId,
                revokedAt
            }, cancellationToken);
            return Results.NoContent();
        }

        devices.MapPost("/{deviceKey}/revoke", RevokeDevice);
        devices.MapDelete("/{deviceKey}", RevokeDevice);

        var keys = app.MapGroup("/keys");

        keys.MapGet("/{alias}", async Task<IResult> (string alias, INivraStore store, CancellationToken cancellationToken) =>
        {
            var user = await store.FindUserByAliasAsync(alias, cancellationToken);
            if (user is null || user.DisabledAt is not null)
            {
                return Results.NotFound();
            }

            var publicDevices = (await store.ActiveDevicesForUserAsync(user.Id, cancellationToken))
                .Where(device => device.IsTrusted)
                .Select(device => new PublicDeviceKeyResponse(device.Id, device.Name, device.KeyBundle, device.KeyBundle.LastRotatedAt))
                .ToList();

            return Results.Ok(new PublicKeyDirectoryResponse(user.Id, user.Alias, publicDevices));
        });

        keys.MapPost("/batch", async Task<IResult> (PublicKeyBatchRequest request, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var userIds = (request.UserIds ?? [])
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .Take(128)
                .ToList();
            var aliases = (request.Aliases ?? [])
                .Where(alias => !string.IsNullOrWhiteSpace(alias))
                .Select(PgSqlNivraStore.NormalizeAlias)
                .Distinct(StringComparer.Ordinal)
                .Take(128)
                .ToList();

            if (userIds.Count == 0 && aliases.Count == 0)
            {
                return Results.Ok(Array.Empty<PublicKeyDirectoryResponse>());
            }

            var users = await db.Users
                .AsNoTracking()
                .Where(user => user.DisabledAt == null && (userIds.Contains(user.Id) || aliases.Contains(user.Alias)))
                .OrderBy(user => user.Alias)
                .Take(128)
                .ToListAsync(cancellationToken);

            var ids = users.Select(user => user.Id).ToList();
            var devices = await db.Devices
                .AsNoTracking()
                .Where(device => ids.Contains(device.UserId) && device.RevokedAt == null && device.IsTrusted)
                .OrderBy(device => device.CreatedAt)
                .ToListAsync(cancellationToken);
            var devicesByUser = devices
                .GroupBy(device => device.UserId)
                .ToDictionary(group => group.Key, group => group.Select(device =>
                    new PublicDeviceKeyResponse(device.Id, device.Name, device.KeyBundle, device.KeyBundle.LastRotatedAt)).ToList());

            var response = users
                .Select(user => new PublicKeyDirectoryResponse(
                    user.Id,
                    user.Alias,
                    devicesByUser.TryGetValue(user.Id, out var publicDevices) ? publicDevices : []))
                .ToList();
            return Results.Ok(response);
        });

        keys.MapPost("/prekeys", async Task<IResult> (KeyBundleRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var device = await store.GetDeviceAsync(current.DeviceId, cancellationToken);
            if (device is null)
            {
                return Results.Unauthorized();
            }

            device.KeyBundle = ToKeyBundle(request, timeProvider.GetUtcNow());
            await store.SaveChangesAsync(cancellationToken);
            return Results.Ok(ToDeviceResponse(device));
        });
    }

    private static void MapContactEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/contacts");

        group.MapGet("/", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var responses = new List<ContactResponse>();
            foreach (var contact in await store.ContactsForUserAsync(current.UserId, cancellationToken))
            {
                responses.Add(await ToContactResponseAsync(contact, store, cancellationToken));
            }

            return Results.Ok(responses);
        });

        group.MapPost("/", async Task<IResult> (CreateContactRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var contactUser = await store.FindUserByAliasAsync(request.Alias, cancellationToken);
            if (contactUser is null || contactUser.DisabledAt is not null)
            {
                return Results.NotFound();
            }

            if (contactUser.Id == current.UserId)
            {
                return Error("invalid_contact", "No puedes agregarte como contacto.");
            }

            var contact = new ContactRecord
            {
                Id = $"{current.UserId}:{contactUser.Id}",
                OwnerUserId = current.UserId,
                ContactUserId = contactUser.Id,
                NicknameCiphertext = request.NicknameCiphertext,
                CreatedAt = timeProvider.GetUtcNow()
            };

            await store.AddOrUpdateContactAsync(contact, cancellationToken);
            return Results.Created($"/contacts/{contactUser.Id}", await ToContactResponseAsync(contact, store, cancellationToken));
        });

        group.MapDelete("/{contactUserId}", async Task<IResult> (string contactUserId, HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            await store.DeleteContactAsync(current.UserId, contactUserId, cancellationToken);
            return Results.NoContent();
        });

        group.MapPatch("/{contactUserId}", async Task<IResult> (string contactUserId, PatchContactRequest request, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var contact = await db.Contacts.FirstOrDefaultAsync(candidate =>
                candidate.OwnerUserId == current.UserId &&
                candidate.ContactUserId == contactUserId,
                cancellationToken);
            if (contact is null)
            {
                return Results.NotFound();
            }

            contact.IsFavorite = request.IsFavorite ?? contact.IsFavorite;
            contact.NicknameCiphertext = request.NicknameCiphertext ?? contact.NicknameCiphertext;
            await db.SaveChangesAsync(cancellationToken);
            return Results.Ok(await ToContactResponseAsync(contact, new PgSqlNivraStore(db), cancellationToken));
        });

        group.MapPost("/radar/scan", async Task<IResult> (ContactRadarScanRequest request, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var hashes = (request.PhoneHashes ?? [])
                .Where(hash => !string.IsNullOrWhiteSpace(hash))
                .Select(hash => hash.Trim().ToLowerInvariant())
                .Where(PrivacyHashes.IsSha256Hex)
                .Distinct(StringComparer.Ordinal)
                .Take(512)
                .ToList();
            if (hashes.Count == 0)
            {
                var currentUser = await db.Users.FirstOrDefaultAsync(user => user.Id == current.UserId, cancellationToken);
                return Results.Ok(new ContactRadarScanResponse(0, 0, currentUser?.PhoneHash is not null && currentUser.IsDiscoverable, []));
            }

            var candidates = await db.Users
                .Where(user =>
                    user.DisabledAt == null &&
                    user.Id != current.UserId &&
                    user.PhoneHash != null &&
                    user.IsDiscoverable &&
                    hashes.Contains(user.PhoneHash))
                .OrderBy(user => user.Alias)
                .Take(80)
                .ToListAsync(cancellationToken);

            var people = new List<UserSummaryResponse>();
            foreach (var user in candidates)
            {
                people.Add(await ToUserSummaryAsync(user, current.UserId, db, cancellationToken));
            }

            var self = await db.Users.AsNoTracking().FirstOrDefaultAsync(user => user.Id == current.UserId, cancellationToken);
            return Results.Ok(new ContactRadarScanResponse(
                hashes.Count,
                people.Count,
                self?.PhoneHash is not null && self.IsDiscoverable,
                people));
        });
    }

    private static void MapDirectoryAndFriendEndpoints(this WebApplication app)
    {
        var directory = app.MapGroup("/directory");

        directory.MapGet("/search", async Task<IResult> (string? q, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var query = NormalizeOptional(q) ?? string.Empty;
            var normalizedAlias = query.Length > 0 ? PgSqlNivraStore.NormalizeAlias(query) : string.Empty;
            var contactIds = await ContactIdsFor(db, current.UserId, cancellationToken);

            var candidates = await db.Users
                .Where(user => user.DisabledAt == null && user.Id != current.UserId)
                .Where(user => user.IsDiscoverable || user.Alias == normalizedAlias || contactIds.Contains(user.Id))
                .OrderByDescending(user => user.UpdatedAt)
                .Take(240)
                .ToListAsync(cancellationToken);

            var people = new List<(UserAccount User, int Score)>();
            foreach (var user in candidates)
            {
                var score = ScoreUserSearch(user, query);
                if (query.Length == 0 || score > 0 || contactIds.Contains(user.Id))
                {
                    people.Add((user, score));
                }
            }

            var result = new List<UserSummaryResponse>();
            foreach (var user in people
                .OrderByDescending(item => item.Score)
                .ThenBy(item => item.User.Alias, StringComparer.Ordinal)
                .Take(40)
                .Select(item => item.User))
            {
                result.Add(await ToUserSummaryAsync(user, current.UserId, db, cancellationToken));
            }

            return Results.Ok(new DirectorySearchResponse(query, result));
        });

        directory.MapGet("/users/{userId}", async Task<IResult> (string userId, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.Id == userId && candidate.DisabledAt == null, cancellationToken);
            if (user is null)
            {
                return Results.NotFound();
            }

            if (!user.IsDiscoverable &&
                user.Id != current.UserId &&
                !await AreContactsAsync(db, current.UserId, user.Id, cancellationToken))
            {
                return Results.NotFound();
            }

            return Results.Ok(await ToUserSummaryAsync(user, current.UserId, db, cancellationToken));
        });

        var friends = app.MapGroup("/friends");

        friends.MapGet("/requests", async Task<IResult> (HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var requests = await db.FriendRequests
                .Where(request => request.FromUserId == current.UserId || request.ToUserId == current.UserId)
                .OrderByDescending(request => request.UpdatedAt)
                .Take(100)
                .ToListAsync(cancellationToken);

            var result = new List<FriendRequestResponse>();
            foreach (var request in requests)
            {
                result.Add(await ToFriendRequestResponseAsync(request, current.UserId, db, cancellationToken));
            }

            return Results.Ok(result);
        });

        friends.MapPost("/requests", async Task<IResult> (CreateFriendRequestRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var target = !string.IsNullOrWhiteSpace(request.UserId)
                ? await db.Users.FirstOrDefaultAsync(user => user.Id == request.UserId && user.DisabledAt == null, cancellationToken)
                : !string.IsNullOrWhiteSpace(request.Alias)
                    ? await db.Users.FirstOrDefaultAsync(user => user.Alias == PgSqlNivraStore.NormalizeAlias(request.Alias) && user.DisabledAt == null, cancellationToken)
                    : null;

            if (target is null)
            {
                return Results.NotFound();
            }

            if (target.Id == current.UserId)
            {
                return Error("invalid_friend_request", "No puedes enviarte solicitud a ti mismo.");
            }

            if (await AreContactsAsync(db, current.UserId, target.Id, cancellationToken) &&
                await AreContactsAsync(db, target.Id, current.UserId, cancellationToken))
            {
                return Error("already_friends", "Ya estan agregados mutuamente.", StatusCodes.Status409Conflict);
            }

            var existing = await db.FriendRequests.FirstOrDefaultAsync(candidate =>
                candidate.Status == FriendRequestStatus.Pending &&
                ((candidate.FromUserId == current.UserId && candidate.ToUserId == target.Id) ||
                 (candidate.FromUserId == target.Id && candidate.ToUserId == current.UserId)),
                cancellationToken);
            if (existing is not null)
            {
                return Results.Ok(await ToFriendRequestResponseAsync(existing, current.UserId, db, cancellationToken));
            }

            var now = timeProvider.GetUtcNow();
            var friendRequest = new FriendRequestRecord
            {
                Id = NivraIds.NewId("frq"),
                FromUserId = current.UserId,
                ToUserId = target.Id,
                Status = FriendRequestStatus.Pending,
                Message = NormalizeOptional(request.Message),
                CreatedAt = now,
                UpdatedAt = now
            };

            db.FriendRequests.Add(friendRequest);
            await db.SaveChangesAsync(cancellationToken);
            var response = await ToFriendRequestResponseAsync(friendRequest, current.UserId, db, cancellationToken);
            await hub.Clients.Group(GroupsFor.User(target.Id)).SendAsync("friend.requested", response, cancellationToken);
            await pushNotifications.SendEventAsync(target.Id, "Nivra", "Nueva solicitud de amistad", "friend_request", $"nivra-friend-request-{friendRequest.Id}", new Dictionary<string, string>
            {
                ["requestId"] = friendRequest.Id,
                ["senderUserId"] = current.UserId
            }, cancellationToken);
            return Results.Created($"/friends/requests/{friendRequest.Id}", response);
        });

        friends.MapPost("/requests/{requestId}/accept", async Task<IResult> (string requestId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var friendRequest = await db.FriendRequests.FirstOrDefaultAsync(request => request.Id == requestId, cancellationToken);
            if (friendRequest is null || friendRequest.ToUserId != current.UserId || friendRequest.Status != FriendRequestStatus.Pending)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            friendRequest.Status = FriendRequestStatus.Accepted;
            friendRequest.UpdatedAt = now;
            friendRequest.RespondedAt = now;
            await UpsertContactAsync(db, friendRequest.FromUserId, friendRequest.ToUserId, now, cancellationToken);
            await UpsertContactAsync(db, friendRequest.ToUserId, friendRequest.FromUserId, now, cancellationToken);
            await db.SaveChangesAsync(cancellationToken);

            var response = await ToFriendRequestResponseAsync(friendRequest, current.UserId, db, cancellationToken);
            await NotifyUsers(hub, [friendRequest.FromUserId, friendRequest.ToUserId], "friend.updated", response);
            return Results.Ok(response);
        });

        friends.MapPost("/requests/{requestId}/reject", async Task<IResult> (string requestId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var friendRequest = await db.FriendRequests.FirstOrDefaultAsync(request => request.Id == requestId, cancellationToken);
            if (friendRequest is null || friendRequest.ToUserId != current.UserId || friendRequest.Status != FriendRequestStatus.Pending)
            {
                return Results.NotFound();
            }

            friendRequest.Status = FriendRequestStatus.Rejected;
            friendRequest.UpdatedAt = timeProvider.GetUtcNow();
            friendRequest.RespondedAt = friendRequest.UpdatedAt;
            await db.SaveChangesAsync(cancellationToken);

            var response = await ToFriendRequestResponseAsync(friendRequest, current.UserId, db, cancellationToken);
            await NotifyUsers(hub, [friendRequest.FromUserId, friendRequest.ToUserId], "friend.updated", response);
            return Results.Ok(response);
        });

        friends.MapPost("/requests/{requestId}/cancel", async Task<IResult> (string requestId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var friendRequest = await db.FriendRequests.FirstOrDefaultAsync(request => request.Id == requestId, cancellationToken);
            if (friendRequest is null || friendRequest.FromUserId != current.UserId || friendRequest.Status != FriendRequestStatus.Pending)
            {
                return Results.NotFound();
            }

            friendRequest.Status = FriendRequestStatus.Cancelled;
            friendRequest.UpdatedAt = timeProvider.GetUtcNow();
            friendRequest.RespondedAt = friendRequest.UpdatedAt;
            await db.SaveChangesAsync(cancellationToken);
            return Results.Ok(await ToFriendRequestResponseAsync(friendRequest, current.UserId, db, cancellationToken));
        });
    }

    private static void MapConversationAndMessageEndpoints(this WebApplication app)
    {
        var conversations = app.MapGroup("/conversations");

        conversations.MapGet("/", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var result = (await store.ConversationsForUserAsync(current.UserId, cancellationToken))
                .Select(ToConversationResponse)
                .ToList();
            return Results.Ok(result);
        });

        conversations.MapPost("/", async Task<IResult> (CreateConversationRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var participantIds = request.ParticipantUserIds
                .Append(current.UserId)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .ToList();

            if (request.Type == ConversationType.Direct && participantIds.Count != 2)
            {
                return Error("invalid_conversation", "Un chat directo necesita exactamente dos participantes.");
            }

            if (!await store.UsersExistAsync(participantIds, cancellationToken))
            {
                return Error("invalid_participants", "Uno o mas participantes no existen.");
            }

            var now = timeProvider.GetUtcNow();
            var conversation = new ConversationRecord
            {
                Id = NivraIds.NewId("con"),
                Type = request.Type,
                TitleCiphertext = request.TitleCiphertext,
                CreatedByUserId = current.UserId,
                PrivacySettings = request.PrivacySettings ?? PrivacySettings.Default(),
                CreatedAt = now,
                UpdatedAt = now
            };

            foreach (var participantId in participantIds)
            {
                conversation.Participants.Add(new ConversationParticipant
                {
                    UserId = participantId,
                    Role = participantId == current.UserId ? ParticipantRole.Owner : ParticipantRole.Member,
                    CanInvite = participantId == current.UserId,
                    CanChangePrivacy = participantId == current.UserId,
                    JoinedAt = now
                });
            }

            await store.AddConversationAsync(conversation, cancellationToken);
            await NotifyUsers(hub, participantIds, "conversation.created", ToConversationResponse(conversation));
            foreach (var userId in participantIds.Where(userId => userId != current.UserId).Distinct(StringComparer.Ordinal))
            {
                await pushNotifications.SendEventAsync(userId, "Nivra", "Nuevo chat disponible", "conversation", $"nivra-conversation-{conversation.Id}", new Dictionary<string, string>
                {
                    ["conversationId"] = conversation.Id,
                    ["senderUserId"] = current.UserId
                }, cancellationToken);
            }
            return Results.Created($"/conversations/{conversation.Id}", ToConversationResponse(conversation));
        });

        conversations.MapGet("/{conversationId}", async Task<IResult> (string conversationId, HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await store.GetConversationAsync(conversationId, cancellationToken);
            if (conversation is null || !conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt is null))
            {
                return Results.NotFound();
            }

            return Results.Ok(ToConversationResponse(conversation));
        });

        conversations.MapGet("/{conversationId}/messages", async Task<IResult> (string conversationId, int? take, HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var isParticipant = await db.Conversations.AnyAsync(conversation =>
                conversation.Id == conversationId &&
                conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt == null),
                cancellationToken);
            if (!isParticipant)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            var limit = Math.Clamp(take ?? 120, 1, 240);
            var messages = await db.Messages
                .Where(message => message.ConversationId == conversationId)
                .Where(message => message.ExpiresAt == null || message.ExpiresAt > now)
                .Where(message => message.Recipients.Any(recipient => recipient.UserId == current.UserId))
                .Where(message => !message.Receipts.Any(receipt =>
                    receipt.UserId == current.UserId &&
                    receipt.DeletedAt != null))
                .Where(message => !message.DeleteAfterRead || !message.Receipts.Any(receipt =>
                    receipt.UserId == current.UserId &&
                    (receipt.ReadAt != null || receipt.DeletedAt != null)))
                .OrderByDescending(message => message.ServerReceivedAt)
                .Take(limit)
                .ToListAsync(cancellationToken);

            messages.Reverse();
            return Results.Ok(messages.Select(message => ToMessageResponseForUser(message, current.UserId, current.DeviceId)).ToList());
        });

        conversations.MapPatch("/{conversationId}", async Task<IResult> (string conversationId, PatchConversationRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await store.GetConversationAsync(conversationId, cancellationToken);
            if (conversation is null)
            {
                return Results.NotFound();
            }

            var participant = conversation.Participants.FirstOrDefault(candidate => candidate.UserId == current.UserId && candidate.RemovedAt is null);
            if (participant is null)
            {
                return Results.NotFound();
            }

            if (request.PrivacySettings is not null && !participant.CanChangePrivacy)
            {
                return Error("forbidden", "No tienes permiso para cambiar la privacidad del chat.", StatusCodes.Status403Forbidden);
            }

            conversation.TitleCiphertext = request.TitleCiphertext ?? conversation.TitleCiphertext;
            conversation.PrivacySettings = request.PrivacySettings ?? conversation.PrivacySettings;
            conversation.UpdatedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            await hub.Clients.Group(GroupsFor.Conversation(conversation.Id)).SendAsync("conversation.updated", ToConversationResponse(conversation), cancellationToken);
            return Results.Ok(ToConversationResponse(conversation));
        });

        conversations.MapPost("/{conversationId}/leave", async Task<IResult> (string conversationId, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await store.GetConversationAsync(conversationId, cancellationToken);
            if (conversation is null)
            {
                return Results.NotFound();
            }

            if (conversation.Type != ConversationType.Group)
            {
                return Error("invalid_conversation", "Solo puedes salir de chats grupales.", StatusCodes.Status400BadRequest);
            }

            var participant = conversation.Participants.FirstOrDefault(candidate => candidate.UserId == current.UserId && candidate.RemovedAt is null);
            if (participant is null)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            participant.RemovedAt = now;
            participant.Role = ParticipantRole.Member;
            participant.CanInvite = false;
            participant.CanChangePrivacy = false;

            var remainingActive = conversation.Participants
                .Where(candidate => candidate.RemovedAt is null)
                .OrderBy(candidate => candidate.JoinedAt)
                .ToList();
            var hasActiveAdmin = remainingActive.Any(candidate =>
                candidate.Role is ParticipantRole.Owner or ParticipantRole.Admin ||
                candidate.CanInvite ||
                candidate.CanChangePrivacy);
            if (!hasActiveAdmin && remainingActive.Count > 0)
            {
                var nextAdmin = remainingActive[0];
                nextAdmin.Role = ParticipantRole.Owner;
                nextAdmin.CanInvite = true;
                nextAdmin.CanChangePrivacy = true;
            }

            conversation.UpdatedAt = now;
            await store.SaveChangesAsync(cancellationToken);
            var response = ToConversationResponse(conversation);
            await NotifyUsers(hub, conversation.Participants.Select(item => item.UserId), "conversation.updated", response);
            return Results.Ok(response);
        });

        conversations.MapPost("/{conversationId}/messages", async Task<IResult> (string conversationId, SendMessageRequest request, HttpContext http, INivraStore store, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, RealtimePresence presence, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await store.GetConversationAsync(conversationId, cancellationToken);
            if (conversation is null || !conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt is null))
            {
                return Results.NotFound();
            }

            if (string.IsNullOrWhiteSpace(request.ClientMessageId) || request.Recipients.Count == 0)
            {
                return Error("invalid_message", "ClientMessageId y recipients son obligatorios.");
            }

            var activeParticipantIds = conversation.Participants
                .Where(participant => participant.RemovedAt is null)
                .Select(participant => participant.UserId)
                .ToHashSet(StringComparer.Ordinal);

            var recipientDeviceIds = request.Recipients
                .Select(recipient => recipient.DeviceId)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .ToList();
            var devicesById = await db.Devices
                .AsNoTracking()
                .Where(device => recipientDeviceIds.Contains(device.Id))
                .ToDictionaryAsync(device => device.Id, cancellationToken);

            foreach (var recipient in request.Recipients)
            {
                devicesById.TryGetValue(recipient.DeviceId, out var device);
                if (!activeParticipantIds.Contains(recipient.UserId) ||
                    device is null ||
                    device.UserId != recipient.UserId ||
                    device.RevokedAt is not null ||
                    string.IsNullOrWhiteSpace(recipient.Ciphertext))
                {
                    return Error("invalid_recipients", "Cada destinatario debe ser participante activo y tener dispositivo vigente.");
                }
            }

            var now = timeProvider.GetUtcNow();
            var message = new MessageEnvelope
            {
                Id = NivraIds.NewId("msg"),
                ConversationId = conversation.Id,
                ClientMessageId = request.ClientMessageId,
                SenderUserId = current.UserId,
                SenderDeviceId = current.DeviceId,
                Kind = request.Kind,
                Recipients = request.Recipients.Select(ToRecipientCiphertext).ToList(),
                EncryptedPolicy = request.EncryptedPolicy,
                ExpiresAt = request.ExpiresAt,
                DeleteAfterRead = request.DeleteAfterRead,
                ServerReceivedAt = now
            };

            message.Receipts = message.Recipients.Select(recipient => new DeliveryReceipt
            {
                UserId = recipient.UserId,
                DeviceId = recipient.DeviceId
            }).ToList();

            conversation.LastMessageAt = now;
            conversation.UpdatedAt = now;
            await store.AddMessageAsync(message, cancellationToken);

            foreach (var recipient in message.Recipients)
            {
                await hub.Clients.Group(GroupsFor.Device(recipient.DeviceId)).SendAsync(
                    "message.received",
                    ToMessageResponseForDevice(message, recipient.UserId, recipient.DeviceId),
                    cancellationToken);
            }

            var pushUserIds = message.Recipients
                .Where(recipient => recipient.UserId != current.UserId)
                .Select(recipient => recipient.UserId)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            foreach (var userId in pushUserIds)
            {
                await pushNotifications.SendMessageAsync(userId, conversation.Id, message.Id, current.UserId, cancellationToken);
            }

            return Results.Created($"/messages/{message.Id}", ToMessageResponse(message));
        });

        conversations.MapPost("/{conversationId}/delete-request", async Task<IResult> (string conversationId, DeleteConversationRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await store.GetConversationAsync(conversationId, cancellationToken);
            if (conversation is null)
            {
                return Results.NotFound();
            }

            var participant = conversation.Participants.FirstOrDefault(candidate => candidate.UserId == current.UserId && candidate.RemovedAt is null);
            if (participant is null)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            if (request.RequestRemoteDelete)
            {
                await hub.Clients.Group(GroupsFor.Conversation(conversationId)).SendAsync("conversation.deleteRequested", new
                {
                    conversationId,
                    requestedByUserId = current.UserId,
                    requestedAt = now,
                    reasonCiphertext = request.ReasonCiphertext
                }, cancellationToken);
            }

            participant.RemovedAt = now;
            conversation.UpdatedAt = now;
            await store.SaveChangesAsync(cancellationToken);
            return Results.NoContent();
        });

        var chats = app.MapGroup("/api/chats");

        chats.MapDelete("/{conversationId}", async Task<IResult> (string conversationId, string? scope, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await db.Conversations.FirstOrDefaultAsync(candidate => candidate.Id == conversationId, cancellationToken);
            if (conversation is null)
            {
                return Results.NotFound();
            }

            var participant = conversation.Participants.FirstOrDefault(candidate => candidate.UserId == current.UserId && candidate.RemovedAt == null);
            if (participant is null)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            var deleteForEveryone = string.Equals(scope, "everyone", StringComparison.OrdinalIgnoreCase);
            var messages = await db.Messages
                .Where(message => message.ConversationId == conversationId)
                .ToListAsync(cancellationToken);

            if (deleteForEveryone)
            {
                foreach (var member in conversation.Participants)
                {
                    member.RemovedAt ??= now;
                }

                foreach (var message in messages)
                {
                    foreach (var receipt in message.Receipts)
                    {
                        receipt.DeletedAt ??= now;
                    }
                }

                conversation.UpdatedAt = now;
                await db.SaveChangesAsync(cancellationToken);
                var payload = new
                {
                    conversationId,
                    scope = "everyone",
                    mode = "deleted",
                    requestedByUserId = current.UserId,
                    at = now
                };
                await NotifyUsers(hub, conversation.Participants.Select(item => item.UserId), "ChatCleared", payload);
                return Results.NoContent();
            }

            participant.RemovedAt = now;
            foreach (var message in messages)
            {
                foreach (var receipt in message.Receipts.Where(receipt => receipt.UserId == current.UserId))
                {
                    receipt.DeletedAt ??= now;
                }
            }

            conversation.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken);
            await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("ChatCleared", new
            {
                conversationId,
                scope = "me",
                mode = "deleted",
                requestedByUserId = current.UserId,
                deviceId = current.DeviceId,
                at = now
            }, cancellationToken);
            return Results.NoContent();
        });

        chats.MapPost("/{conversationId}/clear", async Task<IResult> (string conversationId, ChatScopeRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var conversation = await db.Conversations.FirstOrDefaultAsync(candidate => candidate.Id == conversationId, cancellationToken);
            if (conversation is null)
            {
                return Results.NotFound();
            }

            if (!conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt == null))
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            var clearForEveryone = string.Equals(request.Scope, "everyone", StringComparison.OrdinalIgnoreCase);
            var messages = await db.Messages
                .Where(message => message.ConversationId == conversationId)
                .ToListAsync(cancellationToken);

            foreach (var message in messages)
            {
                var receipts = clearForEveryone
                    ? message.Receipts
                    : message.Receipts.Where(receipt => receipt.UserId == current.UserId);
                foreach (var receipt in receipts)
                {
                    receipt.DeletedAt ??= now;
                }
            }

            conversation.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken);

            var payload = new
            {
                conversationId,
                scope = clearForEveryone ? "everyone" : "me",
                mode = "cleared",
                requestedByUserId = current.UserId,
                deviceId = current.DeviceId,
                at = now
            };
            if (clearForEveryone)
            {
                await NotifyUsers(hub, conversation.Participants.Select(item => item.UserId), "ChatCleared", payload);
            }
            else
            {
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("ChatCleared", payload, cancellationToken);
            }

            return Results.Ok(new { conversationId, clearedForEveryone = clearForEveryone, at = now });
        });

        var messages = app.MapGroup("/messages");

        var apiMessages = app.MapGroup("/api/messages");

        apiMessages.MapDelete("/{messageId}", async Task<IResult> (string messageId, bool? forEveryone, string? scope, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var message = await db.Messages.FirstOrDefaultAsync(candidate => candidate.Id == messageId, cancellationToken);
            if (message is null)
            {
                return Results.NotFound();
            }

            var conversation = await db.Conversations.FirstOrDefaultAsync(candidate => candidate.Id == message.ConversationId, cancellationToken);
            if (conversation is null ||
                !conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt == null))
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            var deleteForEveryone = forEveryone == true || string.Equals(scope, "everyone", StringComparison.OrdinalIgnoreCase);
            if (deleteForEveryone)
            {
                if (message.SenderUserId != current.UserId)
                {
                    return Error("forbidden", "Solo quien envio el mensaje puede eliminarlo para todos.", StatusCodes.Status403Forbidden);
                }

                foreach (var receipt in message.Receipts)
                {
                    receipt.DeletedAt ??= now;
                }

                await db.SaveChangesAsync(cancellationToken);
                await NotifyUsers(hub, conversation.Participants.Select(item => item.UserId), "MessageDeleted", new
                {
                    messageId,
                    conversationId = message.ConversationId,
                    scope = "everyone",
                    deletedByUserId = current.UserId,
                    at = now
                });
                return Results.NoContent();
            }

            var ownReceipts = message.Receipts
                .Where(receipt => receipt.UserId == current.UserId)
                .ToList();
            if (ownReceipts.Count == 0)
            {
                return Results.NotFound();
            }

            foreach (var receipt in ownReceipts)
            {
                receipt.DeletedAt ??= now;
            }

            await db.SaveChangesAsync(cancellationToken);
            await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("MessageDeleted", new
            {
                messageId,
                conversationId = message.ConversationId,
                scope = "me",
                deletedByUserId = current.UserId,
                deviceId = current.DeviceId,
                at = now
            }, cancellationToken);
            return Results.NoContent();
        });

        messages.MapGet("/pending", async Task<IResult> (HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var pending = (await store.PendingMessagesForDeviceAsync(current.UserId, current.DeviceId, timeProvider.GetUtcNow(), cancellationToken))
                .Select(message => ToMessageResponseForDevice(message, current.UserId, current.DeviceId))
                .ToList();
            return Results.Ok(pending);
        });

        messages.MapGet("/sync", async Task<IResult> (int? take, DateTimeOffset? since, HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var limit = Math.Clamp(take ?? 200, 1, 500);
            var query = db.Messages
                .Where(message => message.Recipients.Any(recipient => recipient.UserId == current.UserId))
                .Where(message => message.ExpiresAt == null || message.ExpiresAt > now)
                .Where(message => !message.Receipts.Any(receipt => receipt.UserId == current.UserId && receipt.DeletedAt != null))
                .Where(message => !message.DeleteAfterRead || !message.Receipts.Any(receipt =>
                    receipt.UserId == current.UserId &&
                    (receipt.ReadAt != null || receipt.DeletedAt != null)));

            List<MessageEnvelope> page;
            if (since is { } watermark)
            {
                page = await query
                    .Where(message => message.ServerReceivedAt > watermark)
                    .OrderBy(message => message.ServerReceivedAt)
                    .Take(limit)
                    .ToListAsync(cancellationToken);
            }
            else
            {
                page = await query
                    .OrderByDescending(message => message.ServerReceivedAt)
                    .Take(limit)
                    .ToListAsync(cancellationToken);
                page.Reverse();
            }

            var pending = page
                .Select(message => ToMessageResponseForUser(message, current.UserId, current.DeviceId))
                .ToList();
            var syncedAt = page.Count > 0 ? page[^1].ServerReceivedAt : now;
            return Results.Ok(new MessageSyncResponse(pending, syncedAt));
        });

        messages.MapPost("/sync/ack", async Task<IResult> (MessageSyncAckRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var ids = (request.MessageIds ?? [])
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .Take(500)
                .ToList();
            if (ids.Count == 0)
            {
                return Results.Ok(new MessageSyncAckResponse(0, now));
            }

            var messagesToAck = await db.Messages
                .Where(message => ids.Contains(message.Id))
                .Where(message => message.Receipts.Any(receipt =>
                    receipt.UserId == current.UserId &&
                    receipt.DeviceId == current.DeviceId &&
                    receipt.DeletedAt == null))
                .ToListAsync(cancellationToken);

            var acknowledged = 0;
            var receiptEvents = new List<(string SenderUserId, string MessageId)>();
            foreach (var message in messagesToAck)
            {
                var receipt = message.Receipts.FirstOrDefault(candidate =>
                    candidate.UserId == current.UserId &&
                    candidate.DeviceId == current.DeviceId);
                if (receipt is null || receipt.DeletedAt is not null || receipt.DeliveredAt is not null)
                {
                    continue;
                }

                receipt.DeliveredAt = now;
                acknowledged++;
                receiptEvents.Add((message.SenderUserId, message.Id));
            }

            if (acknowledged > 0)
            {
                await db.SaveChangesAsync(cancellationToken);
                foreach (var receiptEvent in receiptEvents)
                {
                    await hub.Clients.Group(GroupsFor.User(receiptEvent.SenderUserId)).SendAsync("message.receipt", new
                    {
                        messageId = receiptEvent.MessageId,
                        userId = current.UserId,
                        deviceId = current.DeviceId,
                        kind = ReceiptKind.Delivered,
                        at = now
                    }, cancellationToken);
                }
            }

            return Results.Ok(new MessageSyncAckResponse(acknowledged, now));
        });

        messages.MapPost("/{messageId}/receipt", async Task<IResult> (string messageId, ReceiptRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var message = await store.GetMessageAsync(messageId, cancellationToken);
            if (message is null)
            {
                return Results.NotFound();
            }

            var receipt = message.Receipts.FirstOrDefault(candidate => candidate.UserId == current.UserId && candidate.DeviceId == current.DeviceId);
            if (receipt is null)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            var deletedForUser = false;
            var deleteReason = "deleted";
            switch (request.Kind)
            {
                case ReceiptKind.Delivered:
                    receipt.DeliveredAt = now;
                    break;
                case ReceiptKind.Read:
                    foreach (var userReceipt in message.Receipts.Where(candidate => candidate.UserId == current.UserId))
                    {
                        userReceipt.DeliveredAt ??= now;
                        userReceipt.ReadAt ??= now;
                    }
                    if (message.DeleteAfterRead)
                    {
                        deleteReason = "view_once";
                        foreach (var userReceipt in message.Receipts.Where(candidate => candidate.UserId == current.UserId))
                        {
                            userReceipt.DeletedAt ??= now;
                        }

                        deletedForUser = true;
                    }
                    break;
                case ReceiptKind.Deleted:
                    foreach (var userReceipt in message.Receipts.Where(candidate => candidate.UserId == current.UserId))
                    {
                        userReceipt.DeletedAt ??= now;
                    }

                    deletedForUser = true;
                    break;
            }

            await store.SaveChangesAsync(cancellationToken);
            if (request.Kind == ReceiptKind.Read)
            {
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("sync_read_receipts", new
                {
                    conversationId = message.ConversationId,
                    messageIds = new[] { messageId },
                    userId = current.UserId,
                    sourceDeviceId = current.DeviceId,
                    at = now
                }, cancellationToken);
            }
            await hub.Clients.Group(GroupsFor.User(message.SenderUserId)).SendAsync("message.receipt", new
            {
                messageId,
                userId = current.UserId,
                deviceId = current.DeviceId,
                kind = request.Kind,
                at = now
            }, cancellationToken);
            if (deletedForUser)
            {
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("MessageDeleted", new
                {
                    messageId,
                    conversationId = message.ConversationId,
                    scope = "me",
                    reason = deleteReason,
                    deletedByUserId = current.UserId,
                    deviceId = current.DeviceId,
                    at = now
                }, cancellationToken);
            }

            return Results.Ok(ToMessageResponse(message));
        });
    }

    private static void MapStoryEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/stories");

        group.MapGet("/world", async Task<IResult> (HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var stories = await db.Stories
                .Where(story =>
                    story.Visibility == StoryVisibility.PublicWorld &&
                    story.DeletedAt == null &&
                    story.ExpiresAt > now)
                .OrderByDescending(story => story.CreatedAt)
                .Take(80)
                .ToListAsync(cancellationToken);

            var result = new List<StoryResponse>();
            foreach (var story in stories)
            {
                if (await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
                {
                    result.Add(await ToStoryResponseAsync(story, current.UserId, db, cancellationToken));
                }
            }

            return Results.Ok(result);
        });

        group.MapGet("/feed", async Task<IResult> (HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var stories = await db.Stories
                .Where(story => story.DeletedAt == null && story.ExpiresAt > now)
                .OrderByDescending(story => story.CreatedAt)
                .Take(160)
                .ToListAsync(cancellationToken);

            var result = new List<StoryResponse>();
            foreach (var story in stories)
            {
                if (await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
                {
                    result.Add(await ToStoryResponseAsync(story, current.UserId, db, cancellationToken));
                }
            }

            return Results.Ok(result.Take(80).ToList());
        });

        group.MapPost("/", async Task<IResult> (CreateStoryRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(request.EncryptedPayload))
            {
                return Error("invalid_story", "La historia necesita payload.");
            }

            var durationSeconds = Math.Clamp(request.DurationSeconds ?? 24 * 60 * 60, 30, 7 * 24 * 60 * 60);
            var targetType = NormalizeStoryTargetType(request.TargetType, request.TargetId);
            var targetId = targetType == StoryTargetGroup ? NormalizeOptional(request.TargetId) : null;
            var visibility = targetType == StoryTargetGroup ? StoryVisibility.SelectedUsers : request.Visibility;
            var allowed = (request.AllowedUserIds ?? [])
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .ToHashSet(StringComparer.Ordinal);

            if (targetType == StoryTargetGroup)
            {
                if (targetId is null)
                {
                    return Error("invalid_story_group", "La historia grupal necesita un grupo valido.");
                }

                var groupMemberIds = await ActiveConversationParticipantIdsAsync(db, targetId, cancellationToken);
                if (groupMemberIds.Count == 0 || !groupMemberIds.Contains(current.UserId))
                {
                    return Error("invalid_story_group", "Solo miembros activos del grupo pueden publicar historias ahi.", StatusCodes.Status403Forbidden);
                }

                allowed = groupMemberIds;
            }

            if (visibility == StoryVisibility.CloseFriends && allowed.Count == 0)
            {
                allowed = (await db.Contacts
                    .Where(contact => contact.OwnerUserId == current.UserId && contact.IsFavorite)
                    .Select(contact => contact.ContactUserId)
                    .ToListAsync(cancellationToken))
                    .ToHashSet(StringComparer.Ordinal);
            }

            if ((visibility is StoryVisibility.SelectedUsers or StoryVisibility.CloseFriends) &&
                (allowed.Count == 0 || await db.Users.CountAsync(user => allowed.Contains(user.Id) && user.DisabledAt == null, cancellationToken) != allowed.Count))
            {
                return Error("invalid_story_acl", "Los usuarios permitidos deben existir.");
            }

            if (request.MediaFileObjectId is not null)
            {
                var file = await db.Files.FirstOrDefaultAsync(candidate => candidate.Id == request.MediaFileObjectId, cancellationToken);
                if (file is null || file.OwnerUserId != current.UserId)
                {
                    return Error("invalid_story_media", "El archivo de la historia no existe o no pertenece al usuario.");
                }
            }

            var now = timeProvider.GetUtcNow();
            var story = new StoryRecord
            {
                Id = NivraIds.NewId("sty"),
                OwnerUserId = current.UserId,
                Visibility = visibility,
                TargetType = targetType,
                TargetId = targetId,
                EncryptedPayload = request.EncryptedPayload,
                Caption = NormalizeOptional(request.Caption),
                MediaFileObjectId = request.MediaFileObjectId,
                AllowedUserIds = allowed,
                ViewedByUserIds = [],
                ViewEvents = [],
                Reactions = [],
                Comments = [],
                ViewOnce = request.ViewOnce,
                CreatedAt = now,
                ExpiresAt = now.AddSeconds(durationSeconds)
            };

            db.Stories.Add(story);
            await db.SaveChangesAsync(cancellationToken);

            var response = await ToStoryResponseAsync(story, current.UserId, db, cancellationToken);
            if (story.Visibility == StoryVisibility.PublicWorld)
            {
                await hub.Clients.All.SendAsync("story.worldCreated", response, cancellationToken);
            }
            else
            {
                var audience = await StoryAudienceAsync(db, story, cancellationToken);
                await NotifyUsers(hub, audience, "story.created", response);
                foreach (var userId in audience.Where(userId => userId != current.UserId).Distinct(StringComparer.Ordinal))
                {
                    await pushNotifications.SendEventAsync(userId, "Nivra", "Nueva historia disponible", "story", $"nivra-story-{story.Id}", new Dictionary<string, string>
                    {
                        ["storyId"] = story.Id,
                        ["ownerUserId"] = current.UserId
                    }, cancellationToken);
                }
            }

            return Results.Created($"/stories/{story.Id}", response);
        });

        group.MapPost("/{storyId}/view", async Task<IResult> (string storyId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var story = await db.Stories.FirstOrDefaultAsync(candidate => candidate.Id == storyId, cancellationToken);
            if (story is null ||
                story.DeletedAt is not null ||
                story.ExpiresAt <= timeProvider.GetUtcNow() ||
                !await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            if (story.OwnerUserId != current.UserId)
            {
                var added = story.ViewedByUserIds.Add(current.UserId);
                if (!story.ViewEvents.Any(view => view.UserId == current.UserId))
                {
                    story.ViewEvents.Add(new StoryViewEvent
                    {
                        UserId = current.UserId,
                        ViewedAt = now
                    });
                    added = true;
                }

                if (added)
                {
                    await db.SaveChangesAsync(cancellationToken);
                    await hub.Clients.Group(GroupsFor.User(story.OwnerUserId)).SendAsync(
                        "story.viewed",
                        await ToStoryResponseAsync(story, story.OwnerUserId, db, cancellationToken),
                        cancellationToken);
                }
            }

            return Results.Ok(await ToStoryResponseAsync(story, current.UserId, db, cancellationToken));
        });

        group.MapPost("/{storyId}/react", async Task<IResult> (string storyId, StoryReactRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var emoji = NormalizeStoryEmoji(request.Emoji);
            if (emoji is null)
            {
                return Error("invalid_story_reaction", "Selecciona una reaccion valida.");
            }

            var story = await db.Stories.FirstOrDefaultAsync(candidate => candidate.Id == storyId, cancellationToken);
            if (story is null ||
                story.DeletedAt is not null ||
                story.ExpiresAt <= timeProvider.GetUtcNow() ||
                !await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
            {
                return Results.NotFound();
            }

            if (story.OwnerUserId == current.UserId)
            {
                return Error("invalid_story_reaction", "No puedes reaccionar a tu propia historia.");
            }

            var now = timeProvider.GetUtcNow();
            story.ViewedByUserIds.Add(current.UserId);
            if (!story.ViewEvents.Any(view => view.UserId == current.UserId))
            {
                story.ViewEvents.Add(new StoryViewEvent
                {
                    UserId = current.UserId,
                    ViewedAt = now
                });
            }

            story.Reactions.RemoveAll(reaction => reaction.UserId == current.UserId);
            story.Reactions.Add(new StoryReactionRecord
            {
                Id = NivraIds.NewId("sre"),
                UserId = current.UserId,
                Emoji = emoji,
                ReactedAt = now
            });

            await db.SaveChangesAsync(cancellationToken);
            var ownerResponse = await ToStoryResponseAsync(story, story.OwnerUserId, db, cancellationToken);
            await hub.Clients.Group(GroupsFor.User(story.OwnerUserId)).SendAsync("story.reacted", ownerResponse, cancellationToken);
            return Results.Ok(await ToStoryResponseAsync(story, current.UserId, db, cancellationToken));
        });

        group.MapPost("/{storyId}/comment", async Task<IResult> (string storyId, StoryCommentRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var story = await db.Stories.FirstOrDefaultAsync(candidate => candidate.Id == storyId, cancellationToken);
            if (story is null ||
                story.DeletedAt is not null ||
                story.ExpiresAt <= timeProvider.GetUtcNow() ||
                !await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
            {
                return Results.NotFound();
            }

            if (story.OwnerUserId == current.UserId)
            {
                return Error("invalid_story_comment", "No puedes responder tu propia historia.");
            }

            var now = timeProvider.GetUtcNow();
            story.ViewedByUserIds.Add(current.UserId);
            if (!story.ViewEvents.Any(view => view.UserId == current.UserId))
            {
                story.ViewEvents.Add(new StoryViewEvent
                {
                    UserId = current.UserId,
                    ViewedAt = now
                });
            }
            story.Comments.Add(new StoryCommentRecord
            {
                Id = NivraIds.NewId("scm"),
                UserId = current.UserId,
                MessageId = NormalizeOptional(request.MessageId),
                CommentedAt = now
            });

            await db.SaveChangesAsync(cancellationToken);
            var ownerResponse = await ToStoryResponseAsync(story, story.OwnerUserId, db, cancellationToken);
            await hub.Clients.Group(GroupsFor.User(story.OwnerUserId)).SendAsync("story.commented", ownerResponse, cancellationToken);
            return Results.Ok(await ToStoryResponseAsync(story, current.UserId, db, cancellationToken));
        });

        group.MapPost("/{storyId}/repost", async Task<IResult> (string storyId, StoryRepostRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var original = await db.Stories.FirstOrDefaultAsync(candidate => candidate.Id == storyId, cancellationToken);
            if (original is null ||
                original.DeletedAt is not null ||
                original.ExpiresAt <= timeProvider.GetUtcNow() ||
                !await CanViewStoryAsync(db, original, current.UserId, cancellationToken))
            {
                return Results.NotFound();
            }

            if (original.OwnerUserId == current.UserId)
            {
                return Error("invalid_story_repost", "No necesitas repostear tu propia historia.");
            }

            var now = timeProvider.GetUtcNow();
            var durationSeconds = Math.Clamp(request.DurationSeconds ?? 24 * 60 * 60, 30, 7 * 24 * 60 * 60);
            var visibility = request.Visibility is StoryVisibility.PublicWorld or StoryVisibility.Contacts or StoryVisibility.MutualContacts
                ? request.Visibility.Value
                : StoryVisibility.Contacts;
            var repost = new StoryRecord
            {
                Id = NivraIds.NewId("sty"),
                OwnerUserId = current.UserId,
                Visibility = visibility,
                TargetType = StoryTargetContacts,
                TargetId = null,
                EncryptedPayload = original.EncryptedPayload,
                Caption = original.Caption,
                MediaFileObjectId = original.MediaFileObjectId,
                AllowedUserIds = [],
                ViewedByUserIds = [],
                ViewEvents = [],
                Reactions = [],
                Comments = [],
                OriginalStoryId = original.OriginalStoryId ?? original.Id,
                OriginalAuthorId = original.OriginalAuthorId ?? original.OwnerUserId,
                ViewOnce = false,
                CreatedAt = now,
                ExpiresAt = now.AddSeconds(durationSeconds)
            };

            db.Stories.Add(repost);
            await db.SaveChangesAsync(cancellationToken);

            var response = await ToStoryResponseAsync(repost, current.UserId, db, cancellationToken);
            if (repost.Visibility == StoryVisibility.PublicWorld)
            {
                await hub.Clients.All.SendAsync("story.worldCreated", response, cancellationToken);
            }
            else
            {
                var audience = await StoryAudienceAsync(db, repost, cancellationToken);
                await NotifyUsers(hub, audience, "story.created", response);
                foreach (var userId in audience.Where(userId => userId != current.UserId).Distinct(StringComparer.Ordinal))
                {
                    await pushNotifications.SendEventAsync(userId, "Nivra", "Historia reposteada", "story", $"nivra-story-{repost.Id}", new Dictionary<string, string>
                    {
                        ["storyId"] = repost.Id,
                        ["ownerUserId"] = current.UserId
                    }, cancellationToken);
                }
            }

            return Results.Created($"/stories/{repost.Id}", response);
        });

        group.MapGet("/{storyId}/media", async Task<IResult> (string storyId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, EncryptedFileStorage storage, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var story = await db.Stories.FirstOrDefaultAsync(candidate => candidate.Id == storyId, cancellationToken);
            if (story is null ||
                story.DeletedAt is not null ||
                story.ExpiresAt <= timeProvider.GetUtcNow() ||
                story.MediaFileObjectId is null ||
                !await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
            {
                return Results.NotFound();
            }

            var file = await db.Files.FirstOrDefaultAsync(candidate => candidate.Id == story.MediaFileObjectId, cancellationToken);
            if (file is null ||
                file.State != FileState.Uploaded ||
                !await storage.ExistsAsync(file, cancellationToken))
            {
                return Results.NotFound();
            }

            return Results.File(await storage.OpenReadAsync(file, cancellationToken), "application/octet-stream", $"{file.Id}.bin");
        });

        group.MapDelete("/{storyId}", async Task<IResult> (string storyId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var story = await db.Stories.FirstOrDefaultAsync(candidate => candidate.Id == storyId, cancellationToken);
            if (story is null || story.OwnerUserId != current.UserId)
            {
                return Results.NotFound();
            }

            story.DeletedAt = timeProvider.GetUtcNow();
            await db.SaveChangesAsync(cancellationToken);
            return Results.NoContent();
        });
    }

    private static void MapFileEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/files").RequireRateLimiting("uploads");

        group.MapPost("/", async Task<IResult> (CreateFileRequest request, HttpContext http, INivraStore store, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (request.EncryptedSize < 0)
            {
                return Error("invalid_file", "El tamano cifrado no puede ser negativo.");
            }

            if (request.EncryptedSize > MaxEncryptedUploadBytes)
            {
                return Error("file_too_large", $"El archivo cifrado supera el limite de {MaxUploadLabel}.", StatusCodes.Status413PayloadTooLarge);
            }

            var allowed = (request.AllowedUserIds ?? [])
                .Append(current.UserId)
                .Distinct(StringComparer.Ordinal)
                .ToHashSet(StringComparer.Ordinal);

            if (!await store.UsersExistAsync(allowed, cancellationToken))
            {
                return Error("invalid_file_acl", "Todos los usuarios permitidos deben existir.");
            }

            var vaultRoomId = NormalizeOptional(request.VaultRoomId);
            if (vaultRoomId is not null)
            {
                var nowForRoom = timeProvider.GetUtcNow();
                var canAttachToRoom = await db.VaultRooms.AnyAsync(room =>
                    room.Id == vaultRoomId &&
                    room.ClosedAt == null &&
                    (room.ExpiresAt == null || room.ExpiresAt > nowForRoom) &&
                    db.VaultRoomMembers.Any(member =>
                        member.VaultRoomId == room.Id &&
                        member.UserId == current.UserId &&
                        member.Status == VaultMemberStatus.Active),
                    cancellationToken);
                if (!canAttachToRoom)
                {
                    return Error("invalid_vault_room_file", "No puedes adjuntar archivos a esa boveda.", StatusCodes.Status403Forbidden);
                }
            }

            var file = new FileObject
            {
                Id = NivraIds.NewId("fil"),
                OwnerUserId = current.UserId,
                StorageKey = $"users/{current.UserId}/{NivraIds.NewId("blob")}.enc",
                VaultRoomId = vaultRoomId,
                EncryptedSize = request.EncryptedSize,
                MimeTypeCiphertext = request.MimeTypeCiphertext,
                ClientSha256 = request.ClientSha256,
                State = FileState.Reserved,
                AllowedUserIds = allowed,
                CreatedAt = timeProvider.GetUtcNow(),
                ExpiresAt = request.ExpiresAt
            };

            await store.AddFileAsync(file, cancellationToken);
            return Results.Created($"/files/{file.Id}", ToFileResponse(file));
        });

        group.MapPut("/{fileId}/blob", async Task<IResult> (string fileId, HttpContext http, INivraStore store, EncryptedFileStorage storage, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var file = await store.GetFileAsync(fileId, cancellationToken);
            if (file is null || file.OwnerUserId != current.UserId)
            {
                return Results.NotFound();
            }

            if (http.Request.ContentLength is null or <= 0)
            {
                return Error("invalid_upload", "La subida necesita un cuerpo cifrado valido.");
            }

            if (http.Request.ContentLength > MaxEncryptedUploadBytes)
            {
                return Error("file_too_large", $"El archivo cifrado supera el limite de {MaxUploadLabel}.", StatusCodes.Status413PayloadTooLarge);
            }

            var written = await storage.SaveAsync(file, http.Request.Body, http.Request.ContentLength, cancellationToken);
            if (file.EncryptedSize > 0 && written != file.EncryptedSize)
            {
                await storage.DeleteIfExistsAsync(file, cancellationToken);
                return Error("upload_size_mismatch", "El tamano subido no coincide con la reserva cifrada.");
            }

            file.EncryptedSize = written;
            file.State = FileState.Uploaded;
            file.UploadedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            return Results.Ok(ToFileResponse(file));
        });

        group.MapGet("/{fileId}", async Task<IResult> (string fileId, HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var file = await store.GetFileAsync(fileId, cancellationToken);
            return file is null || !store.UserCanAccessFile(current.UserId, file)
                ? Results.NotFound()
                : Results.Ok(ToFileResponse(file));
        });

        group.MapGet("/{fileId}/blob", async Task<IResult> (string fileId, HttpContext http, INivraStore store, EncryptedFileStorage storage, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var file = await store.GetFileAsync(fileId, cancellationToken);
            if (file is null ||
                !store.UserCanAccessFile(current.UserId, file) ||
                file.State != FileState.Uploaded ||
                !await storage.ExistsAsync(file, cancellationToken))
            {
                return Results.NotFound();
            }

            return Results.File(await storage.OpenReadAsync(file, cancellationToken), "application/octet-stream", $"{file.Id}.bin");
        });
    }

    private static void MapVaultEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/vault/items");

        group.MapGet("/", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var items = (await store.VaultItemsForUserAsync(current.UserId, cancellationToken))
                .Select(ToVaultItemResponse)
                .ToList();
            return Results.Ok(items);
        });

        group.MapPost("/", async Task<IResult> (CreateVaultItemRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(request.EncryptedMetadata))
            {
                return Error("invalid_vault_item", "encryptedMetadata es obligatorio.");
            }

            if (request.FileObjectId is not null)
            {
                var file = await store.GetFileAsync(request.FileObjectId, cancellationToken);
                if (file is null || file.OwnerUserId != current.UserId)
                {
                    return Error("invalid_vault_file", "El archivo no existe o no pertenece al usuario.");
                }
            }

            var now = timeProvider.GetUtcNow();
            var item = new VaultItem
            {
                Id = NivraIds.NewId("vlt"),
                UserId = current.UserId,
                ParentId = request.ParentId,
                FileObjectId = request.FileObjectId,
                Kind = request.Kind,
                EncryptedMetadata = request.EncryptedMetadata,
                CreatedAt = now,
                UpdatedAt = now
            };

            await store.AddVaultItemAsync(item, cancellationToken);
            return Results.Created($"/vault/items/{item.Id}", ToVaultItemResponse(item));
        });

        group.MapPatch("/{itemId}", async Task<IResult> (string itemId, PatchVaultItemRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var item = await store.GetVaultItemAsync(itemId, cancellationToken);
            if (item is null || item.UserId != current.UserId || item.DeletedAt is not null)
            {
                return Results.NotFound();
            }

            item.EncryptedMetadata = request.EncryptedMetadata ?? item.EncryptedMetadata;
            item.ParentId = request.ParentId ?? item.ParentId;
            item.UpdatedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            return Results.Ok(ToVaultItemResponse(item));
        });

        group.MapDelete("/{itemId}", async Task<IResult> (string itemId, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var item = await store.GetVaultItemAsync(itemId, cancellationToken);
            if (item is null || item.UserId != current.UserId)
            {
                return Results.NotFound();
            }

            item.DeletedAt = timeProvider.GetUtcNow();
            item.UpdatedAt = item.DeletedAt.Value;
            await store.SaveChangesAsync(cancellationToken);
            return Results.NoContent();
        });
    }

    private static void MapVaultRoomEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/vault/rooms");

        group.MapGet("/", async Task<IResult> (HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var memberRoomIds = await db.VaultRoomMembers
                .Where(member => member.UserId == current.UserId && member.Status != VaultMemberStatus.Left && member.Status != VaultMemberStatus.Rejected)
                .Select(member => member.VaultRoomId)
                .ToListAsync(cancellationToken);

            var rooms = await db.VaultRooms
                .Where(room => room.ClosedAt == null && (room.OwnerUserId == current.UserId || memberRoomIds.Contains(room.Id)))
                .OrderByDescending(room => room.UpdatedAt)
                .Take(80)
                .ToListAsync(cancellationToken);

            var result = new List<VaultRoomResponse>();
            foreach (var room in rooms)
            {
                result.Add(await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken));
            }

            return Results.Ok(result);
        });

        group.MapPost("/", async Task<IResult> (CreateVaultRoomRequest request, HttpContext http, NivraDbContext db, PasswordHasher hasher, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var name = NormalizeOptional(request.Name);
            if (name is null)
            {
                return Error("invalid_vault_room", "La boveda compartida necesita nombre.");
            }

            if ((request.AccessMode is VaultAccessMode.PinOnly or VaultAccessMode.WaitingRoom) &&
                string.IsNullOrWhiteSpace(request.Pin))
            {
                return Error("pin_required", "Ese modo necesita PIN.");
            }

            var invited = (request.InvitedUserIds ?? [])
                .Where(id => !string.IsNullOrWhiteSpace(id) && id != current.UserId)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            if (invited.Count > 0 &&
                await db.Users.CountAsync(user => invited.Contains(user.Id) && user.DisabledAt == null, cancellationToken) != invited.Count)
            {
                return Error("invalid_invites", "Todos los invitados deben existir.");
            }

            var now = timeProvider.GetUtcNow();
            var room = new VaultRoom
            {
                Id = NivraIds.NewId("vrm"),
                OwnerUserId = current.UserId,
                Name = name,
                PinHash = string.IsNullOrWhiteSpace(request.Pin) ? null : hasher.Hash(request.Pin),
                AccessMode = request.AccessMode,
                RetentionMode = request.RetentionMode,
                EncryptedWelcome = NormalizeOptional(request.EncryptedWelcome),
                CreatedAt = now,
                UpdatedAt = now,
                ExpiresAt = request.RetentionMode == VaultRetentionMode.ExpiresAfterTtl
                    ? now.AddSeconds(Math.Clamp(request.TtlSeconds ?? 3600, 60, 7 * 24 * 60 * 60))
                    : null
            };

            db.VaultRooms.Add(room);
            db.VaultRoomMembers.Add(new VaultRoomMember
            {
                Id = $"{room.Id}:{current.UserId}",
                VaultRoomId = room.Id,
                UserId = current.UserId,
                Role = ParticipantRole.Owner,
                Status = VaultMemberStatus.Active,
                CreatedAt = now,
                JoinedAt = now,
                LastSeenAt = now
            });

            foreach (var userId in invited)
            {
                db.VaultRoomMembers.Add(new VaultRoomMember
                {
                    Id = $"{room.Id}:{userId}",
                    VaultRoomId = room.Id,
                    UserId = userId,
                    Role = ParticipantRole.Member,
                    Status = VaultMemberStatus.Invited,
                    CreatedAt = now
                });
            }

            await db.SaveChangesAsync(cancellationToken);
            var response = await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken);
            await NotifyUsers(hub, invited, "vault.invited", response);
            foreach (var userId in invited)
            {
                await pushNotifications.SendEventAsync(userId, "Nivra", "Te invitaron a una boveda", "vault_invited", $"nivra-vault-{room.Id}", new Dictionary<string, string>
                {
                    ["roomId"] = room.Id,
                    ["ownerUserId"] = current.UserId
                }, cancellationToken);
            }
            return Results.Created($"/vault/rooms/{room.Id}", response);
        });

        group.MapPost("/{roomId}/invite", async Task<IResult> (string roomId, InviteVaultRoomRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate => candidate.Id == roomId && candidate.ClosedAt == null, cancellationToken);
            if (room is null || room.OwnerUserId != current.UserId)
            {
                return Results.NotFound();
            }

            var invited = request.UserIds
                .Where(id => !string.IsNullOrWhiteSpace(id) && id != current.UserId)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            if (invited.Count == 0)
            {
                return Error("invalid_invites", "Selecciona al menos un usuario.");
            }

            if (await db.Users.CountAsync(user => invited.Contains(user.Id) && user.DisabledAt == null, cancellationToken) != invited.Count)
            {
                return Error("invalid_invites", "Todos los invitados deben existir.");
            }

            var now = timeProvider.GetUtcNow();
            foreach (var userId in invited)
            {
                var memberId = $"{room.Id}:{userId}";
                var existing = await db.VaultRoomMembers.FirstOrDefaultAsync(member => member.Id == memberId, cancellationToken);
                if (existing is null)
                {
                    db.VaultRoomMembers.Add(new VaultRoomMember
                    {
                        Id = memberId,
                        VaultRoomId = room.Id,
                        UserId = userId,
                        Role = ParticipantRole.Member,
                        Status = VaultMemberStatus.Invited,
                        CreatedAt = now
                    });
                }
                else if (existing.Status is VaultMemberStatus.Left or VaultMemberStatus.Rejected)
                {
                    existing.Status = VaultMemberStatus.Invited;
                    existing.LeftAt = null;
                }
            }

            room.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken);
            var response = await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken);
            await NotifyUsers(hub, invited, "vault.invited", response);
            foreach (var userId in invited)
            {
                await pushNotifications.SendEventAsync(userId, "Nivra", "Te invitaron a una boveda", "vault_invited", $"nivra-vault-{room.Id}", new Dictionary<string, string>
                {
                    ["roomId"] = room.Id,
                    ["ownerUserId"] = current.UserId
                }, cancellationToken);
            }
            return Results.Ok(response);
        });

        group.MapPost("/{roomId}/invite-links", async Task<IResult> (string roomId, CreateVaultInviteLinkRequest request, HttpContext http, NivraDbContext db, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate =>
                candidate.Id == roomId &&
                candidate.ClosedAt == null &&
                (candidate.ExpiresAt == null || candidate.ExpiresAt > timeProvider.GetUtcNow()),
                cancellationToken);
            if (room is null || room.OwnerUserId != current.UserId)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            var code = CreateVaultInviteCode();
            var ttlSeconds = Math.Clamp(request.TtlSeconds ?? 24 * 60 * 60, 5 * 60, 7 * 24 * 60 * 60);
            var maxUses = Math.Clamp(request.MaxUses ?? 1, 1, 50);
            var invite = new VaultRoomInvite
            {
                Id = NivraIds.NewId("vin"),
                VaultRoomId = room.Id,
                CreatedByUserId = current.UserId,
                CodeHash = PrivacyHashes.OpaqueCodeHash(code),
                RequireApproval = request.RequireApproval ?? room.AccessMode == VaultAccessMode.WaitingRoom,
                MaxUses = maxUses,
                Uses = 0,
                CreatedAt = now,
                ExpiresAt = now.AddSeconds(ttlSeconds)
            };

            db.VaultRoomInvites.Add(invite);
            await db.SaveChangesAsync(cancellationToken);
            return Results.Created($"/vault/invites/{Uri.EscapeDataString(code)}", ToVaultInviteLinkResponse(invite, room, code, http));
        });

        app.MapPost("/vault/invites/{code}/accept", async Task<IResult> (string code, AcceptVaultInviteRequest request, HttpContext http, NivraDbContext db, PasswordHasher hasher, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var trimmedCode = NormalizeOptional(code);
            if (trimmedCode is null)
            {
                return Error("invalid_vault_invite", "Codigo de invitacion invalido.");
            }

            var now = timeProvider.GetUtcNow();
            var codeHash = PrivacyHashes.OpaqueCodeHash(trimmedCode);
            var invite = await db.VaultRoomInvites.FirstOrDefaultAsync(candidate => candidate.CodeHash == codeHash, cancellationToken);
            if (invite is null || invite.RevokedAt is not null || invite.ExpiresAt <= now || invite.Uses >= invite.MaxUses)
            {
                return Error("vault_invite_expired", "Esta invitacion ya no esta disponible.", StatusCodes.Status410Gone);
            }

            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate =>
                candidate.Id == invite.VaultRoomId &&
                candidate.ClosedAt == null &&
                (candidate.ExpiresAt == null || candidate.ExpiresAt > now),
                cancellationToken);
            if (room is null)
            {
                return Results.NotFound();
            }

            if (room.PinHash is not null && !hasher.Verify(request.Pin ?? string.Empty, room.PinHash))
            {
                return Error("invalid_pin", "PIN invalido.", StatusCodes.Status401Unauthorized);
            }

            var memberId = $"{room.Id}:{current.UserId}";
            var member = await db.VaultRoomMembers.FirstOrDefaultAsync(candidate => candidate.Id == memberId, cancellationToken);
            var wasUsableMember = member is { Status: VaultMemberStatus.Active or VaultMemberStatus.Invited or VaultMemberStatus.Waiting };
            var nextStatus = invite.RequireApproval || room.AccessMode == VaultAccessMode.WaitingRoom
                ? VaultMemberStatus.Waiting
                : VaultMemberStatus.Active;

            if (room.OwnerUserId == current.UserId)
            {
                nextStatus = VaultMemberStatus.Active;
            }

            if (member is null)
            {
                member = new VaultRoomMember
                {
                    Id = memberId,
                    VaultRoomId = room.Id,
                    UserId = current.UserId,
                    Role = room.OwnerUserId == current.UserId ? ParticipantRole.Owner : ParticipantRole.Member,
                    Status = nextStatus,
                    CreatedAt = now
                };
                db.VaultRoomMembers.Add(member);
            }

            member.Status = nextStatus;
            member.JoinedAt = nextStatus == VaultMemberStatus.Active ? now : member.JoinedAt;
            member.LastSeenAt = now;
            member.LeftAt = null;
            if (!wasUsableMember)
            {
                invite.Uses++;
            }
            room.UpdatedAt = now;

            await db.SaveChangesAsync(cancellationToken);
            var response = await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken);
            if (nextStatus == VaultMemberStatus.Waiting)
            {
                await hub.Clients.Group(GroupsFor.User(room.OwnerUserId)).SendAsync("vault.joinRequested", response, cancellationToken);
                await pushNotifications.SendEventAsync(room.OwnerUserId, "Nivra", "Solicitud de entrada a boveda", "vault_join_requested", $"nivra-vault-join-{room.Id}-{current.UserId}", new Dictionary<string, string>
                {
                    ["roomId"] = room.Id,
                    ["userId"] = current.UserId
                }, cancellationToken);
            }
            else
            {
                await NotifyUsers(hub, await VaultRoomAudienceAsync(db, room.Id, cancellationToken), "vault.approved", response);
            }

            return Results.Ok(response);
        });

        group.MapPost("/{roomId}/join", async Task<IResult> (string roomId, JoinVaultRoomRequest request, HttpContext http, NivraDbContext db, PasswordHasher hasher, TimeProvider timeProvider, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate =>
                candidate.Id == roomId &&
                candidate.ClosedAt == null &&
                (candidate.ExpiresAt == null || candidate.ExpiresAt > now),
                cancellationToken);
            if (room is null)
            {
                return Results.NotFound();
            }

            var memberId = $"{room.Id}:{current.UserId}";
            var member = await db.VaultRoomMembers.FirstOrDefaultAsync(candidate => candidate.Id == memberId, cancellationToken);
            var isOwner = room.OwnerUserId == current.UserId;
            var isAuthorizedParticipant = member is { Status: VaultMemberStatus.Invited or VaultMemberStatus.Active };

            if (!isOwner && !isAuthorizedParticipant)
            {
                return Error("invite_required", "No estas invitado a esta sala.", StatusCodes.Status403Forbidden);
            }

            if (room.PinHash is not null && !hasher.Verify(request.Pin ?? string.Empty, room.PinHash))
            {
                return Error("invalid_pin", "PIN invalido.", StatusCodes.Status401Unauthorized);
            }

            var nextStatus = VaultMemberStatus.Active;

            if (member is null)
            {
                member = new VaultRoomMember
                {
                    Id = memberId,
                    VaultRoomId = room.Id,
                    UserId = current.UserId,
                    Role = room.OwnerUserId == current.UserId ? ParticipantRole.Owner : ParticipantRole.Member,
                    Status = nextStatus,
                    CreatedAt = now
                };
                db.VaultRoomMembers.Add(member);
            }

            member.Status = nextStatus;
            member.JoinedAt = nextStatus == VaultMemberStatus.Active ? now : member.JoinedAt;
            member.LastSeenAt = now;
            member.LeftAt = null;
            room.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken);

            var response = await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken);
            await hub.Clients.Group(GroupsFor.User(room.OwnerUserId)).SendAsync("vault.joinRequested", response, cancellationToken);
            return Results.Ok(response);
        });

        group.MapPost("/{roomId}/members/{memberUserId}/approve", async Task<IResult> (string roomId, string memberUserId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate => candidate.Id == roomId && candidate.ClosedAt == null, cancellationToken);
            if (room is null || room.OwnerUserId != current.UserId)
            {
                return Results.NotFound();
            }

            var member = await db.VaultRoomMembers.FirstOrDefaultAsync(candidate => candidate.VaultRoomId == roomId && candidate.UserId == memberUserId, cancellationToken);
            if (member is null || member.Status != VaultMemberStatus.Waiting)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            member.Status = VaultMemberStatus.Active;
            member.JoinedAt = now;
            member.LastSeenAt = now;
            room.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken);

            var response = await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken);
            await hub.Clients.Group(GroupsFor.User(memberUserId)).SendAsync("vault.approved", response, cancellationToken);
            await pushNotifications.SendEventAsync(memberUserId, "Nivra", "Entrada a boveda aprobada", "vault_approved", $"nivra-vault-{room.Id}", new Dictionary<string, string>
            {
                ["roomId"] = room.Id,
                ["ownerUserId"] = current.UserId
            }, cancellationToken);
            return Results.Ok(response);
        });

        group.MapPost("/{roomId}/leave", async Task<IResult> (string roomId, HttpContext http, NivraDbContext db, TimeProvider timeProvider, IHubContext<NivraHub> hub, EncryptedFileStorage storage, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate => candidate.Id == roomId && candidate.ClosedAt == null, cancellationToken);
            var member = await db.VaultRoomMembers.FirstOrDefaultAsync(candidate => candidate.VaultRoomId == roomId && candidate.UserId == current.UserId, cancellationToken);
            if (room is null || member is null)
            {
                return Results.NotFound();
            }

            var now = timeProvider.GetUtcNow();
            member.Status = VaultMemberStatus.Left;
            member.LeftAt = now;
            if (room.RetentionMode == VaultRetentionMode.BurnOnExit || room.OwnerUserId == current.UserId)
            {
                room.ClosedAt = now;
                await BurnVaultRoomFilesAsync(db, storage, room.Id, cancellationToken);
            }

            room.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken);
            await NotifyUsers(hub, await VaultRoomAudienceAsync(db, room.Id, cancellationToken), "vault.left", new { roomId, userId = current.UserId, closedAt = room.ClosedAt });
            return Results.NoContent();
        });

        group.MapGet("/{roomId}/voice-token", async Task<IResult> (string roomId, HttpContext http, NivraDbContext db, LiveKitTokenService liveKit, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var now = timeProvider.GetUtcNow();
            var room = await db.VaultRooms.FirstOrDefaultAsync(candidate =>
                candidate.Id == roomId &&
                candidate.ClosedAt == null &&
                (candidate.ExpiresAt == null || candidate.ExpiresAt > now),
                cancellationToken);
            if (room is null)
            {
                return Results.NotFound();
            }

            var member = await db.VaultRoomMembers.FirstOrDefaultAsync(candidate =>
                candidate.VaultRoomId == room.Id &&
                candidate.UserId == current.UserId &&
                candidate.Status == VaultMemberStatus.Active,
                cancellationToken);
            if (member is null)
            {
                return Error("vault_voice_forbidden", "Debes entrar a la sala Vault antes de unirte al audio.", StatusCodes.Status403Forbidden);
            }

            if (!liveKit.IsConfigured)
            {
                return Error("livekit_not_configured", "LiveKit no esta configurado en el servidor.", StatusCodes.Status503ServiceUnavailable);
            }

            var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.Id == current.UserId && candidate.DisabledAt == null, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            var token = liveKit.CreateRoomToken(LiveKitTokenService.VaultVoiceRoomName(room.Id), user);
            return Results.Ok(new LiveKitRoomTokenResponse(token.ServerUrl, token.Token));
        });
    }

    private static void MapCallEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/calls");

        static async Task<IResult> RoomToken(string groupId, HttpContext http, INivraStore store, LiveKitTokenService liveKit, CancellationToken cancellationToken)
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(groupId))
            {
                return Error("invalid_group", "El grupo es obligatorio.");
            }

            var conversation = await store.GetConversationAsync(groupId, cancellationToken);
            if (conversation is null ||
                conversation.Type != ConversationType.Group ||
                !conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt is null))
            {
                return Results.NotFound();
            }

            if (!liveKit.IsConfigured)
            {
                return Error("livekit_not_configured", "LiveKit no esta configurado en el servidor.", StatusCodes.Status503ServiceUnavailable);
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null || user.DisabledAt is not null)
            {
                return Results.Unauthorized();
            }

            var token = liveKit.CreateRoomToken(conversation, user);
            return Results.Ok(new LiveKitRoomTokenResponse(token.ServerUrl, token.Token));
        }

        group.MapGet("/room-token/{groupId}", RoomToken);
        app.MapGet("/api/calls/room-token/{groupId}", RoomToken);

        group.MapPost("/start", async Task<IResult> (StartCallRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var participants = (request.ParticipantUserIds ?? [])
                .Append(current.UserId)
                .Distinct(StringComparer.Ordinal)
                .ToHashSet(StringComparer.Ordinal);

            if (request.ConversationId is not null)
            {
                var conversation = await store.GetConversationAsync(request.ConversationId, cancellationToken);
                if (conversation is null || !conversation.Participants.Any(participant => participant.UserId == current.UserId && participant.RemovedAt is null))
                {
                    return Results.NotFound();
                }

                participants = conversation.Participants
                    .Where(participant => participant.RemovedAt is null)
                    .Select(participant => participant.UserId)
                    .ToHashSet(StringComparer.Ordinal);
            }

            if (participants.Count < 2 || !await store.UsersExistAsync(participants, cancellationToken))
            {
                return Error("invalid_call", "La llamada necesita al menos dos usuarios validos.");
            }

            var call = new CallSession
            {
                Id = NivraIds.NewId("cal"),
                ConversationId = request.ConversationId,
                InitiatorUserId = current.UserId,
                Type = request.Type,
                Status = CallStatus.Ringing,
                ParticipantUserIds = participants,
                StartedAt = timeProvider.GetUtcNow()
            };

            await store.AddCallAsync(call, cancellationToken);
            var response = ToCallResponse(call, current.DeviceId);
            var callerName = await GetCallerNameAsync(store, current.UserId, cancellationToken);
            await NotifyUsers(hub, participants, "call.started", response);
            foreach (var userId in participants.Where(userId => userId != current.UserId))
            {
                await pushNotifications.SendIncomingCallAsync(userId, call.ConversationId, call.Id, current.UserId, callerName, call.Type, cancellationToken);
            }

            return Results.Created($"/calls/{call.Id}", response);
        });

        group.MapGet("/{callId}", async Task<IResult> (string callId, HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var call = await store.GetCallAsync(callId, cancellationToken);
            if (call is null || !call.ParticipantUserIds.Contains(current.UserId))
            {
                return Results.NotFound();
            }

            return Results.Ok(ToCallResponse(call));
        });

        group.MapPost("/{callId}/signal", async Task<IResult> (string callId, CallSignalRequest request, HttpContext http, INivraStore store, IHubContext<NivraHub> hub, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var call = await store.GetCallAsync(callId, cancellationToken);
            if (call is null ||
                !call.ParticipantUserIds.Contains(current.UserId) ||
                !call.ParticipantUserIds.Contains(request.TargetUserId))
            {
                return Results.NotFound();
            }

            if (call.Status == CallStatus.Ended || call.EndedAt is not null)
            {
                return Error("call_ended", "La llamada ya finalizo.", StatusCodes.Status409Conflict);
            }

            var signalType = request.SignalType?.Trim().ToLowerInvariant();
            if (signalType is "accepted" or "offer" or "answer" or "ice")
            {
                call.Status = CallStatus.Active;
            }
            await store.SaveChangesAsync(cancellationToken);
            await hub.Clients.Group(GroupsFor.User(request.TargetUserId)).SendAsync("call.signal", new
            {
                callId,
                fromUserId = current.UserId,
                fromDeviceId = current.DeviceId,
                request.SignalType,
                request.PayloadCiphertext
            }, cancellationToken);
            if (signalType == "accepted")
            {
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("call_answered_elsewhere", new
                {
                    callId,
                    answeredByUserId = current.UserId,
                    answeredByDeviceId = current.DeviceId,
                    at = DateTimeOffset.UtcNow
                }, cancellationToken);
            }

            return Results.Accepted();
        });

        group.MapPost("/{callId}/end", async Task<IResult> (string callId, HttpContext http, INivraStore store, TimeProvider timeProvider, IHubContext<NivraHub> hub, PushNotificationService pushNotifications, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var call = await store.GetCallAsync(callId, cancellationToken);
            if (call is null || !call.ParticipantUserIds.Contains(current.UserId))
            {
                return Results.NotFound();
            }

            call.Status = CallStatus.Ended;
            call.EndedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            var response = ToCallResponse(call);
            await NotifyUsers(hub, call.ParticipantUserIds, "call.ended", response);
            foreach (var userId in call.ParticipantUserIds.Distinct(StringComparer.Ordinal))
            {
                await pushNotifications.SendCallEndedAsync(userId, call.ConversationId, call.Id, current.UserId, call.Type, cancellationToken);
            }

            return Results.Ok(response);
        });
    }

    private static void MapPrivacyEndpoints(this WebApplication app)
    {
        app.MapGet("/privacy", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            return user is null ? Results.Unauthorized() : Results.Ok(user.PrivacySettings);
        });

        app.MapPatch("/privacy", async Task<IResult> (PatchPrivacyRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            ApplyPrivacyPatch(user.PrivacySettings, request);
            user.UpdatedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            return Results.Ok(user.PrivacySettings);
        });
    }

    private static void MapNotificationEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/push-tokens");

        group.MapGet("/web-config", (IConfiguration configuration, PushNotificationService pushNotifications) =>
        {
            return Results.Ok(FirebaseWebConfig(configuration, pushNotifications.StandardWebPushPublicKey));
        });

        group.MapPost("/", async Task<IResult> (RegisterPushTokenRequest request, HttpContext http, INivraStore store, TokenService tokenService, PushNotificationService pushNotifications, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(request.Provider) || string.IsNullOrWhiteSpace(request.Token))
            {
                return Error("invalid_push_token", "provider y token son obligatorios.");
            }

            var push = new PushTokenRecord
            {
                Id = NivraIds.NewId("psh"),
                UserId = current.UserId,
                DeviceId = current.DeviceId,
                Provider = request.Provider.Trim(),
                TokenHash = tokenService.HashOpaqueToken(request.Token),
                TokenCiphertext = pushNotifications.ProtectToken(request.Token.Trim()),
                CreatedAt = timeProvider.GetUtcNow()
            };

            await store.AddPushTokenAsync(push, cancellationToken);
            return Results.Created($"/push-tokens/{push.Id}", new PushTokenResponse(push.Id, push.Provider, push.CreatedAt, push.RevokedAt, pushNotifications.IsConfigured));
        });

        group.MapPost("/sync-contacts", async Task<IResult> (List<string>? contactPhoneHashes, HttpContext http, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var hashes = NormalizeContactHashes(contactPhoneHashes, 5000);
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            var existing = await db.UserContactHashes
                .Where(contactHash => contactHash.UserId == current.UserId)
                .ToListAsync(cancellationToken);
            var existingHashes = existing
                .Select(contactHash => contactHash.ContactPhoneHash)
                .ToHashSet(StringComparer.Ordinal);
            var requestedHashes = hashes.ToHashSet(StringComparer.Ordinal);

            db.UserContactHashes.RemoveRange(existing.Where(contactHash => !requestedHashes.Contains(contactHash.ContactPhoneHash)));
            foreach (var hash in hashes.Where(hash => !existingHashes.Contains(hash)))
            {
                db.UserContactHashes.Add(new UserContactHash
                {
                    UserId = current.UserId,
                    ContactPhoneHash = hash
                });
            }

            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return Results.Ok(new ContactHashSyncResponse(hashes.Count, hashes.Count));
        });

        group.MapGet("/status", (HttpContext http, PushNotificationService pushNotifications) =>
        {
            var current = http.GetCurrentUser();
            return current is null
                ? Results.Unauthorized()
                : Results.Ok(new { serverReady = pushNotifications.IsConfigured, provider = "Fcm" });
        });

        group.MapDelete("/{pushTokenId}", async Task<IResult> (string pushTokenId, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var push = await store.GetPushTokenAsync(pushTokenId, cancellationToken);
            if (push is null || push.UserId != current.UserId)
            {
                return Results.NotFound();
            }

            push.RevokedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            return Results.NoContent();
        });
    }

    private static FirebaseWebConfigResponse FirebaseWebConfig(IConfiguration configuration, string webPushPublicKey)
    {
        return new FirebaseWebConfigResponse(
            FirebaseConfigValue(configuration, "ApiKey", DefaultFirebaseWebApiKey),
            FirebaseConfigValue(configuration, "AuthDomain", DefaultFirebaseWebAuthDomain),
            FirebaseConfigValue(configuration, "ProjectId", DefaultFirebaseWebProjectId),
            FirebaseConfigValue(configuration, "StorageBucket", DefaultFirebaseWebStorageBucket),
            FirebaseConfigValue(configuration, "MessagingSenderId", DefaultFirebaseWebMessagingSenderId),
            FirebaseConfigValue(configuration, "AppId", DefaultFirebaseWebAppId),
            FirebaseConfigValue(configuration, "VapidKey", DefaultFirebaseWebVapidKey),
            FirebaseConfigValue(configuration, "SdkVersion", DefaultFirebaseSdkVersion),
            webPushPublicKey);
    }

    private static string FirebaseConfigValue(IConfiguration configuration, string key, string fallback)
    {
        return FirstNonBlank(
            configuration[$"Firebase:Web:{key}"],
            configuration[$"Firebase__Web__{key}"],
            configuration[$"Push:Fcm:Web:{key}"],
            configuration[$"Push__Fcm__Web__{key}"],
            configuration[$"NIVRA_FIREBASE_{key.ToUpperInvariant()}"],
            key == "VapidKey" ? configuration["NIVRA_FIREBASE_VAPID_KEY"] : null,
            fallback) ?? fallback;
    }

    private static void MapMonetizationEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/monetization");

        group.MapGet("/entitlements", async Task<IResult> (HttpContext http, INivraStore store, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            var entitlements = store.EntitlementsFor(user);
            return Results.Ok(new EntitlementsResponse(
                entitlements.PlanCode,
                entitlements.VaultStorageBytes,
                entitlements.MaxLinkedDevices,
                entitlements.MaxGroupParticipants,
                entitlements.AdsEnabled,
                entitlements.EncryptedBackupsEnabled,
                entitlements.ProfessionalSpacesEnabled));
        });

        group.MapGet("/ad-catalog", async Task<IResult> (string? locale, string? region, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            var entitlements = store.EntitlementsFor(user);
            if (!entitlements.AdsEnabled)
            {
                return Results.Ok(new AdCatalogResponse("premium_no_ads", []));
            }

            var ads = (await store.ActiveAdCampaignsAsync(locale, region, timeProvider.GetUtcNow(), cancellationToken))
                .Select(ad => new AdCreativeResponse(ad.Id, ad.Title, ad.Body, ad.Placement, ad.ClickUrl))
                .ToList();

            return Results.Ok(new AdCatalogResponse("zero_content_targeting_locale_region_only", ads));
        });

        group.MapPost("/ad-impressions", async Task<IResult> (RecordAdImpressionRequest request, HttpContext http, INivraStore store, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (!await store.AdCampaignExistsAsync(request.CampaignId, cancellationToken) || string.IsNullOrWhiteSpace(request.Placement))
            {
                return Error("invalid_ad_impression", "La campana o el placement no son validos.");
            }

            var day = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            var aggregate = await store.IncrementAdImpressionAsync(request.CampaignId, request.Placement, day, cancellationToken);
            return Results.Accepted(value: new AdImpressionResponse(aggregate.CampaignId, aggregate.Placement, aggregate.Day, aggregate.Count));
        });
    }

    private static void MapDeletionAndSyncEndpoints(this WebApplication app)
    {
        app.MapGet("/sync/bootstrap", async Task<IResult> (HttpContext http, INivraStore store, NivraDbContext db, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            var contacts = new List<ContactResponse>();
            foreach (var contact in await store.ContactsForUserAsync(current.UserId, cancellationToken))
            {
                contacts.Add(await ToContactResponseAsync(contact, store, cancellationToken));
            }

            var conversations = (await store.ConversationsForUserAsync(current.UserId, cancellationToken))
                .Select(ToConversationResponse)
                .ToList();
            var now = DateTimeOffset.UtcNow;
            var conversationIds = conversations.Select(conversation => conversation.Id).ToList();
            List<MessageEnvelope> recentMessages = conversationIds.Count == 0
                ? []
                : await db.Messages
                    .Where(message => conversationIds.Contains(message.ConversationId))
                    .Where(message => message.ExpiresAt == null || message.ExpiresAt > now)
                    .Where(message => message.Recipients.Any(recipient => recipient.UserId == current.UserId))
                    .Where(message => !message.Receipts.Any(receipt =>
                        receipt.UserId == current.UserId &&
                        receipt.DeletedAt != null))
                    .Where(message => !message.DeleteAfterRead || !message.Receipts.Any(receipt =>
                        receipt.UserId == current.UserId &&
                        (receipt.ReadAt != null || receipt.DeletedAt != null)))
                    .OrderByDescending(message => message.ServerReceivedAt)
                    .Take(500)
                    .ToListAsync(cancellationToken);
            recentMessages.Reverse();
            List<MessageEnvelope> deletedMessageRows = conversationIds.Count == 0
                ? []
                : await db.Messages
                    .Where(message => conversationIds.Contains(message.ConversationId))
                    .Where(message => message.Receipts.Any(receipt =>
                        receipt.UserId == current.UserId &&
                        receipt.DeletedAt != null))
                    .OrderByDescending(message => message.ServerReceivedAt)
                    .Take(500)
                    .ToListAsync(cancellationToken);
            var deletedMessages = deletedMessageRows
                .Select(message => new MessageDeletionResponse(
                    message.Id,
                    message.ConversationId,
                    "me",
                    message.Receipts
                        .Where(receipt => receipt.UserId == current.UserId && receipt.DeletedAt != null)
                        .Select(receipt => receipt.DeletedAt!.Value)
                        .DefaultIfEmpty(message.ServerReceivedAt)
                        .Max()))
                .ToList();

            var vault = (await store.VaultItemsForUserAsync(current.UserId, cancellationToken))
                .Select(ToVaultItemResponse)
                .ToList();
            var friendRequests = new List<FriendRequestResponse>();
            foreach (var friendRequest in await db.FriendRequests
                .Where(request => request.FromUserId == current.UserId || request.ToUserId == current.UserId)
                .OrderByDescending(request => request.UpdatedAt)
                .Take(80)
                .ToListAsync(cancellationToken))
            {
                friendRequests.Add(await ToFriendRequestResponseAsync(friendRequest, current.UserId, db, cancellationToken));
            }

            var visibleStories = new List<StoryResponse>();
            foreach (var story in await db.Stories
                .Where(story => story.DeletedAt == null && story.ExpiresAt > now)
                .OrderByDescending(story => story.CreatedAt)
                .Take(120)
                .ToListAsync(cancellationToken))
            {
                if (await CanViewStoryAsync(db, story, current.UserId, cancellationToken))
                {
                    visibleStories.Add(await ToStoryResponseAsync(story, current.UserId, db, cancellationToken));
                }
            }

            var memberRoomIds = await db.VaultRoomMembers
                .Where(member => member.UserId == current.UserId && member.Status != VaultMemberStatus.Left && member.Status != VaultMemberStatus.Rejected)
                .Select(member => member.VaultRoomId)
                .ToListAsync(cancellationToken);
            var vaultRooms = new List<VaultRoomResponse>();
            foreach (var room in await db.VaultRooms
                .Where(room => room.ClosedAt == null && (room.OwnerUserId == current.UserId || memberRoomIds.Contains(room.Id)))
                .OrderByDescending(room => room.UpdatedAt)
                .Take(80)
                .ToListAsync(cancellationToken))
            {
                vaultRooms.Add(await ToVaultRoomResponseAsync(room, current.UserId, db, cancellationToken));
            }

            return Results.Ok(new SyncBootstrapResponse(
                ToUserResponse(user),
                (await store.ActiveDevicesForUserAsync(current.UserId, cancellationToken)).Select(ToDeviceResponse).ToList(),
                contacts,
                conversations,
                recentMessages.Select(message => ToMessageResponseForUser(message, current.UserId, current.DeviceId)).ToList(),
                deletedMessages,
                vault,
                friendRequests,
                visibleStories.Take(80).ToList(),
                vaultRooms,
                user.PrivacySettings));
        });

        app.MapPost("/data/delete-request", async Task<IResult> (DeleteAccountRequest request, HttpContext http, INivraStore store, NivraDbContext db, EncryptedFileStorage storage, TimeProvider timeProvider, CancellationToken cancellationToken) =>
        {
            var current = http.GetCurrentUser();
            if (current is null)
            {
                return Results.Unauthorized();
            }

            if (!string.Equals(request.Confirmation, "DELETE", StringComparison.Ordinal))
            {
                return Error("confirmation_required", "Envia confirmation=DELETE para confirmar.");
            }

            var now = timeProvider.GetUtcNow();
            var user = await store.GetUserAsync(current.UserId, cancellationToken);
            if (user is null)
            {
                return Results.Unauthorized();
            }

            user.DisabledAt = now;
            user.PhoneHash = null;
            user.UpdatedAt = now;

            await store.RevokeDevicesForUserAsync(current.UserId, now, cancellationToken);
            await store.RevokeSessionsForUserAsync(current.UserId, now, cancellationToken);
            await store.DeleteContactsTouchingUserAsync(current.UserId, cancellationToken);
            var uploadedContactHashes = await db.UserContactHashes
                .Where(contactHash => contactHash.UserId == current.UserId)
                .ToListAsync(cancellationToken);
            db.UserContactHashes.RemoveRange(uploadedContactHashes);

            foreach (var item in await store.VaultItemsForUserAsync(current.UserId, cancellationToken))
            {
                item.DeletedAt = now;
                item.UpdatedAt = now;
            }

            foreach (var file in await store.FilesOwnedByUserAsync(current.UserId, cancellationToken))
            {
                file.State = FileState.Deleted;
                await storage.DeleteIfExistsAsync(file, cancellationToken);
            }

            await store.SaveChangesAsync(cancellationToken);
            await store.AddAuditAsync(current.UserId, "data.delete_request.completed", ClientIp(http), "Account data minimized in PostgreSQL store.", now, cancellationToken);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> CompleteVerifiedPhoneLoginAsync(
        string phone,
        string deviceName,
        KeyBundleRequest? keyBundle,
        string? hardwareId,
        string auditAction,
        string auditDetails,
        NivraDbContext db,
        PhoneOtpService otpService,
        PasswordHasher hasher,
        TokenService tokenService,
        PushNotificationService pushNotifications,
        TimeProvider timeProvider,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        var user = await db.Users.FirstOrDefaultAsync(candidate => candidate.Phone == phone && candidate.DisabledAt == null, cancellationToken);
        if (user is null)
        {
            user = await CreatePendingPhoneUserAsync(db, hasher, phone, timeProvider.GetUtcNow(), cancellationToken);
        }

        if (user.RequiresAlias)
        {
            var setup = otpService.CreateAliasSetup(user.Id, phone);
            db.SecurityAuditEvents.Add(new SecurityAuditEvent
            {
                Id = NivraIds.NewId("aud"),
                UserId = user.Id,
                Action = "auth.phone_alias_required",
                IpAddress = ClientIp(http),
                Details = auditDetails,
                CreatedAt = timeProvider.GetUtcNow()
            });
            await db.SaveChangesAsync(cancellationToken);
            return Results.Ok(new PhoneOtpVerifyResponse(true, null, setup.Token, setup.ExpiresAt, phone));
        }

        var now = timeProvider.GetUtcNow();
        var shouldNotifyJoined = false;
        if (user.PhoneHash is null)
        {
            user.PhoneHash = PrivacyHashes.PhoneContactHash(phone);
            user.UpdatedAt = now;
            shouldNotifyJoined = user.IsDiscoverable;
        }

        var device = await UpsertDeviceAsync(
            db,
            user.Id,
            deviceName,
            hardwareId,
            keyBundle ?? new KeyBundleRequest(null, null, null, []),
            now,
            trusted: true,
            cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        if (shouldNotifyJoined)
        {
            await NotifyContactJoinedWatchersAsync(db, pushNotifications, user.Id, user.PhoneHash, cancellationToken);
        }

        var tokens = await tokenService.CreateSessionAsync(new PgSqlNivraStore(db), user, device, ClientIp(http), http.Request.Headers.UserAgent.ToString(), cancellationToken);
        db.SecurityAuditEvents.Add(new SecurityAuditEvent
        {
            Id = NivraIds.NewId("aud"),
            UserId = user.Id,
            Action = auditAction,
            IpAddress = ClientIp(http),
            Details = $"{auditDetails}; Device={device.Id}",
            CreatedAt = now
        });
        await db.SaveChangesAsync(cancellationToken);

        var auth = new AuthResponse(ToUserResponse(user), ToDeviceResponse(device), tokens);
        return Results.Ok(new PhoneOtpVerifyResponse(false, auth, null, null, phone));
    }

    private static async Task<UserAccount> CreatePendingPhoneUserAsync(NivraDbContext db, PasswordHasher hasher, string phone, DateTimeOffset now, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var user = new UserAccount
            {
                Id = NivraIds.NewId("usr"),
                Alias = GeneratePendingPhoneAlias(),
                DisplayName = null,
                Email = null,
                Phone = phone,
                PhoneHash = PrivacyHashes.PhoneContactHash(phone),
                RequiresAlias = true,
                IsDiscoverable = false,
                PasswordHash = hasher.Hash(CreateOpaquePassword()),
                CreatedAt = now,
                UpdatedAt = now
            };

            db.Users.Add(user);
            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return user;
            }
            catch (DbUpdateException)
            {
                db.ChangeTracker.Clear();
                var existing = await db.Users.FirstOrDefaultAsync(candidate => candidate.Phone == phone && candidate.DisabledAt == null, cancellationToken);
                if (existing is not null)
                {
                    return existing;
                }
            }
        }

        throw new InvalidOperationException("Could not reserve a phone account.");
    }

    private static string GeneratePendingPhoneAlias()
    {
        return $"phone_{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}";
    }

    private static string CreateOpaquePassword()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    }

    private static IResult ValidateRegister(RegisterRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Alias) || !AliasPattern.IsMatch(request.Alias.Trim()))
        {
            return Error("invalid_alias", "El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.");
        }

        if (string.IsNullOrWhiteSpace(request.Password) || request.Password.Length < 10)
        {
            return Error("weak_password", "La password debe tener al menos 10 caracteres.");
        }

        if (string.IsNullOrWhiteSpace(request.DeviceName))
        {
            return Error("invalid_device", "El nombre del dispositivo es obligatorio.");
        }

        return null!;
    }

    private static async Task<DeviceRecord> UpsertDeviceAsync(
        NivraDbContext db,
        string userId,
        string deviceName,
        string? hardwareId,
        KeyBundleRequest keyBundle,
        DateTimeOffset now,
        bool trusted,
        CancellationToken cancellationToken)
    {
        var normalizedHardwareId = NormalizeHardwareId(hardwareId);
        DeviceRecord? device = null;
        if (normalizedHardwareId is not null)
        {
            device = await db.Devices.FirstOrDefaultAsync(candidate =>
                candidate.UserId == userId &&
                candidate.HardwareId == normalizedHardwareId,
                cancellationToken);
        }

        if (device is null)
        {
            device = NewDevice(userId, deviceName, normalizedHardwareId, keyBundle, now, trusted);
            db.Devices.Add(device);
            return device;
        }

        device.Name = NormalizeDeviceName(deviceName);
        device.KeyBundle = ToKeyBundle(keyBundle, now);
        device.IsTrusted = device.IsTrusted || trusted;
        device.LastSeenAt = now;
        device.RevokedAt = null;
        return device;
    }

    private static DeviceRecord NewDevice(string userId, string deviceName, string? hardwareId, KeyBundleRequest keyBundle, DateTimeOffset now, bool trusted)
    {
        return new DeviceRecord
        {
            Id = NivraIds.NewId("dev"),
            UserId = userId,
            Name = NormalizeDeviceName(deviceName),
            HardwareId = hardwareId,
            KeyBundle = ToKeyBundle(keyBundle, now),
            IsTrusted = trusted,
            CreatedAt = now,
            LastSeenAt = now
        };
    }

    private static string NormalizeDeviceName(string deviceName)
    {
        var normalized = NormalizeOptional(deviceName) ?? "Nivra";
        return normalized.Length <= 160 ? normalized : normalized[..160];
    }

    private static string? NormalizeHardwareId(string? hardwareId)
    {
        var normalized = NormalizeOptional(hardwareId);
        return normalized is null
            ? null
            : normalized.Length <= 128 ? normalized : normalized[..128];
    }

    private static KeyBundle ToKeyBundle(KeyBundleRequest request, DateTimeOffset now)
    {
        return new KeyBundle
        {
            IdentityKey = NormalizeOptional(request.IdentityKey),
            SignedPreKey = NormalizeOptional(request.SignedPreKey),
            PreKeySignature = NormalizeOptional(request.PreKeySignature),
            OneTimePreKeys = request.OneTimePreKeys?.Where(key => !string.IsNullOrWhiteSpace(key)).Distinct().ToList() ?? [],
            LastRotatedAt = now
        };
    }

    private static KeyBundleRequest KeyBundleToRequest(KeyBundle keyBundle)
    {
        return new KeyBundleRequest(
            keyBundle.IdentityKey,
            keyBundle.SignedPreKey,
            keyBundle.PreKeySignature,
            keyBundle.OneTimePreKeys.ToList());
    }

    private static RecipientCiphertext ToRecipientCiphertext(RecipientCipherRequest request)
    {
        return new RecipientCiphertext
        {
            UserId = request.UserId,
            DeviceId = request.DeviceId,
            Ciphertext = request.Ciphertext,
            Header = request.Header,
            FileObjectId = request.FileObjectId
        };
    }

    private static UserResponse ToUserResponse(UserAccount user)
    {
        return new UserResponse(
            user.Id,
            user.Alias,
            user.DisplayName,
            user.Email,
            user.Phone,
            user.Bio,
            user.ProfilePhotoDataUrl,
            user.IsDiscoverable,
            user.PlanCode,
            user.PrivacySettings,
            user.CreatedAt);
    }

    private static DeviceResponse ToDeviceResponse(DeviceRecord device)
    {
        return new DeviceResponse(device.Id, device.UserId, device.Name, device.IsTrusted, device.CreatedAt, device.LastSeenAt, device.RevokedAt, device.HardwareId);
    }

    private static async Task<ContactResponse> ToContactResponseAsync(ContactRecord contact, INivraStore store, CancellationToken cancellationToken)
    {
        var user = await store.GetUserAsync(contact.ContactUserId, cancellationToken);
        return new ContactResponse(
            contact.ContactUserId,
            user?.Alias ?? "unknown",
            user?.DisplayName,
            user?.Phone,
            user?.ProfilePhotoDataUrl,
            contact.NicknameCiphertext,
            contact.IsFavorite,
            contact.CreatedAt);
    }

    private static ConversationResponse ToConversationResponse(ConversationRecord conversation)
    {
        return new ConversationResponse(
            conversation.Id,
            conversation.Type,
            conversation.TitleCiphertext,
            conversation.PrivacySettings,
            conversation.Participants.Select(participant => new ParticipantResponse(
                participant.UserId,
                participant.Role,
                participant.CanInvite,
                participant.CanChangePrivacy,
                participant.JoinedAt,
                participant.RemovedAt)).ToList(),
            conversation.CreatedAt,
            conversation.UpdatedAt,
            conversation.LastMessageAt);
    }

    private static MessageResponse ToMessageResponse(MessageEnvelope message)
    {
        return new MessageResponse(
            message.Id,
            message.ConversationId,
            message.ClientMessageId,
            message.SenderUserId,
            message.SenderDeviceId,
            message.Kind,
            message.Recipients,
            message.EncryptedPolicy,
            message.ServerReceivedAt,
            message.ExpiresAt,
            message.DeleteAfterRead,
            message.Receipts);
    }

    private static MessageResponse ToMessageResponseForDevice(MessageEnvelope message, string userId, string deviceId)
    {
        return new MessageResponse(
            message.Id,
            message.ConversationId,
            message.ClientMessageId,
            message.SenderUserId,
            message.SenderDeviceId,
            message.Kind,
            message.Recipients
                .Where(recipient => recipient.UserId == userId && recipient.DeviceId == deviceId)
                .ToList(),
            message.EncryptedPolicy,
            message.ServerReceivedAt,
            message.ExpiresAt,
            message.DeleteAfterRead,
            message.Receipts);
    }

    private static MessageResponse ToMessageResponseForUser(MessageEnvelope message, string userId, string preferredDeviceId)
    {
        var recipients = message.Recipients
            .Where(recipient => recipient.UserId == userId)
            .OrderByDescending(recipient => recipient.DeviceId == preferredDeviceId)
            .ToList();

        return new MessageResponse(
            message.Id,
            message.ConversationId,
            message.ClientMessageId,
            message.SenderUserId,
            message.SenderDeviceId,
            message.Kind,
            recipients,
            message.EncryptedPolicy,
            message.ServerReceivedAt,
            message.ExpiresAt,
            message.DeleteAfterRead,
            message.Receipts);
    }

    private static FileResponse ToFileResponse(FileObject file)
    {
        return new FileResponse(
            file.Id,
            file.OwnerUserId,
            file.EncryptedSize,
            file.MimeTypeCiphertext,
            file.ClientSha256,
            file.State,
            file.AllowedUserIds.ToList(),
            file.CreatedAt,
            file.UploadedAt,
            file.ExpiresAt,
            $"/files/{file.Id}/blob",
            $"/files/{file.Id}/blob");
    }

    private static VaultItemResponse ToVaultItemResponse(VaultItem item)
    {
        return new VaultItemResponse(item.Id, item.ParentId, item.FileObjectId, item.Kind, item.EncryptedMetadata, item.CreatedAt, item.UpdatedAt);
    }

    private static CallResponse ToCallResponse(CallSession call, string? initiatorDeviceId = null)
    {
        return new CallResponse(call.Id, call.ConversationId, call.InitiatorUserId, call.Type, call.Status, call.ParticipantUserIds.ToList(), call.StartedAt, call.EndedAt, initiatorDeviceId);
    }

    private static VaultInviteLinkResponse ToVaultInviteLinkResponse(VaultRoomInvite invite, VaultRoom room, string code, HttpContext http)
    {
        var acceptUrl = BuildVaultInviteUrl(http, code);
        return new VaultInviteLinkResponse(
            code,
            room.Id,
            room.Name,
            acceptUrl,
            $"nivra://vault/invite?code={Uri.EscapeDataString(code)}",
            invite.RequireApproval,
            invite.MaxUses,
            invite.Uses,
            invite.ExpiresAt);
    }

    private static string CreateVaultInviteCode()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(24))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static string BuildVaultInviteUrl(HttpContext http, string code)
    {
        var origin = http.Request.Headers.Origin.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(origin))
        {
            origin = $"{http.Request.Scheme}://{http.Request.Host}";
        }

        return $"{origin.TrimEnd('/')}/vault/invite?code={Uri.EscapeDataString(code)}";
    }

    private static async Task<string> GetCallerNameAsync(INivraStore store, string callerUserId, CancellationToken cancellationToken)
    {
        var caller = await store.GetUserAsync(callerUserId, cancellationToken);
        return string.IsNullOrWhiteSpace(caller?.DisplayName)
            ? caller?.Alias ?? "un contacto"
            : caller.DisplayName;
    }

    private static async Task<UserSummaryResponse> ToUserSummaryAsync(UserAccount user, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var outgoing = await db.Contacts.FirstOrDefaultAsync(contact => contact.OwnerUserId == currentUserId && contact.ContactUserId == user.Id, cancellationToken);
        var incoming = await db.Contacts.AnyAsync(contact => contact.OwnerUserId == user.Id && contact.ContactUserId == currentUserId, cancellationToken);
        var pending = await db.FriendRequests
            .Where(request =>
                request.Status == FriendRequestStatus.Pending &&
                ((request.FromUserId == currentUserId && request.ToUserId == user.Id) ||
                 (request.FromUserId == user.Id && request.ToUserId == currentUserId)))
            .OrderByDescending(request => request.CreatedAt)
            .FirstOrDefaultAsync(cancellationToken);

        var friendshipState = outgoing is not null && incoming
            ? "friends"
            : pending is null
                ? "none"
                : pending.FromUserId == currentUserId ? "requested" : "incoming";

        return new UserSummaryResponse(
            user.Id,
            user.Alias,
            user.DisplayName,
            outgoing is not null || user.Id == currentUserId ? user.Phone : null,
            user.Bio,
            user.ProfilePhotoDataUrl,
            user.IsDiscoverable,
            outgoing is not null,
            outgoing is not null && incoming,
            outgoing?.IsFavorite ?? false,
            friendshipState);
    }

    private static async Task<FriendRequestResponse> ToFriendRequestResponseAsync(FriendRequestRecord request, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var from = await db.Users.FirstAsync(user => user.Id == request.FromUserId, cancellationToken);
        var to = await db.Users.FirstAsync(user => user.Id == request.ToUserId, cancellationToken);
        return new FriendRequestResponse(
            request.Id,
            await ToUserSummaryAsync(from, currentUserId, db, cancellationToken),
            await ToUserSummaryAsync(to, currentUserId, db, cancellationToken),
            request.Status,
            request.Message,
            request.CreatedAt,
            request.UpdatedAt,
            request.RespondedAt);
    }

    private static async Task<StoryResponse> ToStoryResponseAsync(StoryRecord story, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var owner = await db.Users.FirstAsync(user => user.Id == story.OwnerUserId, cancellationToken);
        var includeStats = story.OwnerUserId == currentUserId;
        var originalAuthor = story.OriginalAuthorId is null
            ? null
            : await db.Users
                .Where(user => user.Id == story.OriginalAuthorId && user.DisabledAt == null)
                .FirstOrDefaultAsync(cancellationToken);
        var viewCount = story.ViewedByUserIds
            .Concat(story.ViewEvents.Select(view => view.UserId))
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Count();
        return new StoryResponse(
            story.Id,
            await ToUserSummaryAsync(owner, currentUserId, db, cancellationToken),
            story.Visibility,
            NormalizeStoryTargetType(story.TargetType, story.TargetId),
            story.TargetId,
            story.EncryptedPayload,
            story.Caption,
            story.MediaFileObjectId,
            story.AllowedUserIds.ToList(),
            story.ViewOnce,
            story.ViewedByUserIds.Contains(currentUserId),
            viewCount,
            story.Reactions
                .OrderByDescending(reaction => reaction.ReactedAt)
                .FirstOrDefault(reaction => reaction.UserId == currentUserId)
                ?.Emoji,
            story.OriginalStoryId,
            originalAuthor is null ? null : await ToUserSummaryAsync(originalAuthor, currentUserId, db, cancellationToken),
            includeStats ? await ToStoryViewResponsesAsync(story, currentUserId, db, cancellationToken) : [],
            includeStats ? await ToStoryReactionResponsesAsync(story, currentUserId, db, cancellationToken) : [],
            includeStats ? await ToStoryCommentResponsesAsync(story, currentUserId, db, cancellationToken) : [],
            story.CreatedAt,
            story.ExpiresAt);
    }

    private static async Task<List<StoryViewResponse>> ToStoryViewResponsesAsync(StoryRecord story, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var events = story.ViewEvents
            .GroupBy(view => view.UserId, StringComparer.Ordinal)
            .Select(group => group.OrderBy(view => view.ViewedAt).First())
            .Concat(story.ViewedByUserIds
                .Where(userId => story.ViewEvents.All(view => view.UserId != userId))
                .Select(userId => new StoryViewEvent
                {
                    UserId = userId,
                    ViewedAt = story.CreatedAt
                }))
            .OrderByDescending(view => view.ViewedAt)
            .ToList();
        var users = await UsersByIdAsync(db, events.Select(view => view.UserId), cancellationToken);
        var responses = new List<StoryViewResponse>();
        foreach (var view in events)
        {
            if (users.TryGetValue(view.UserId, out var user))
            {
                responses.Add(new StoryViewResponse(
                    await ToUserSummaryAsync(user, currentUserId, db, cancellationToken),
                    view.ViewedAt));
            }
        }

        return responses;
    }

    private static async Task<List<StoryReactionResponse>> ToStoryReactionResponsesAsync(StoryRecord story, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var reactions = story.Reactions
            .OrderByDescending(reaction => reaction.ReactedAt)
            .ToList();
        var users = await UsersByIdAsync(db, reactions.Select(reaction => reaction.UserId), cancellationToken);
        var responses = new List<StoryReactionResponse>();
        foreach (var reaction in reactions)
        {
            if (users.TryGetValue(reaction.UserId, out var user))
            {
                responses.Add(new StoryReactionResponse(
                    reaction.Id,
                    await ToUserSummaryAsync(user, currentUserId, db, cancellationToken),
                    reaction.Emoji,
                    reaction.ReactedAt));
            }
        }

        return responses;
    }

    private static async Task<List<StoryCommentResponse>> ToStoryCommentResponsesAsync(StoryRecord story, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var comments = story.Comments
            .OrderByDescending(comment => comment.CommentedAt)
            .ToList();
        var users = await UsersByIdAsync(db, comments.Select(comment => comment.UserId), cancellationToken);
        var responses = new List<StoryCommentResponse>();
        foreach (var comment in comments)
        {
            if (users.TryGetValue(comment.UserId, out var user))
            {
                responses.Add(new StoryCommentResponse(
                    comment.Id,
                    await ToUserSummaryAsync(user, currentUserId, db, cancellationToken),
                    comment.MessageId,
                    comment.CommentedAt));
            }
        }

        return responses;
    }

    private static Task<Dictionary<string, UserAccount>> UsersByIdAsync(NivraDbContext db, IEnumerable<string> userIds, CancellationToken cancellationToken)
    {
        var ids = userIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        return ids.Count == 0
            ? Task.FromResult(new Dictionary<string, UserAccount>(StringComparer.Ordinal))
            : db.Users
                .Where(user => ids.Contains(user.Id) && user.DisabledAt == null)
                .ToDictionaryAsync(user => user.Id, StringComparer.Ordinal, cancellationToken);
    }

    private static async Task<VaultRoomResponse> ToVaultRoomResponseAsync(VaultRoom room, string currentUserId, NivraDbContext db, CancellationToken cancellationToken)
    {
        var owner = await db.Users.FirstAsync(user => user.Id == room.OwnerUserId, cancellationToken);
        var members = await db.VaultRoomMembers
            .Where(member => member.VaultRoomId == room.Id)
            .OrderBy(member => member.Role)
            .ThenBy(member => member.CreatedAt)
            .ToListAsync(cancellationToken);
        var users = await db.Users
            .Where(user => members.Select(member => member.UserId).Contains(user.Id))
            .ToDictionaryAsync(user => user.Id, cancellationToken);

        return new VaultRoomResponse(
            room.Id,
            await ToUserSummaryAsync(owner, currentUserId, db, cancellationToken),
            room.Name,
            room.AccessMode,
            room.RetentionMode,
            room.EncryptedWelcome,
            members
                .Where(member => member.Status is not VaultMemberStatus.Left and not VaultMemberStatus.Rejected)
                .Select(member => member.UserId)
                .Distinct(StringComparer.Ordinal)
                .ToList(),
            members.Select(member =>
            {
                users.TryGetValue(member.UserId, out var user);
                return new VaultRoomMemberResponse(
                    member.UserId,
                    user?.Alias ?? "unknown",
                    user?.DisplayName,
                    user?.ProfilePhotoDataUrl,
                    member.Role,
                    member.Status,
                    member.CreatedAt,
                    member.JoinedAt,
                    member.LastSeenAt,
                    member.LeftAt);
            }).ToList(),
            room.CreatedAt,
            room.UpdatedAt,
            room.ExpiresAt,
            room.ClosedAt);
    }

    private static async Task<HashSet<string>> ContactIdsFor(NivraDbContext db, string userId, CancellationToken cancellationToken)
    {
        return (await db.Contacts
            .Where(contact => contact.OwnerUserId == userId)
            .Select(contact => contact.ContactUserId)
            .ToListAsync(cancellationToken))
            .ToHashSet(StringComparer.Ordinal);
    }

    private static Task<bool> AreContactsAsync(NivraDbContext db, string ownerUserId, string contactUserId, CancellationToken cancellationToken)
    {
        return db.Contacts.AnyAsync(contact => contact.OwnerUserId == ownerUserId && contact.ContactUserId == contactUserId, cancellationToken);
    }

    private static async Task<bool> AreMutualContactsAsync(NivraDbContext db, string userA, string userB, CancellationToken cancellationToken)
    {
        return await AreContactsAsync(db, userA, userB, cancellationToken) &&
            await AreContactsAsync(db, userB, userA, cancellationToken);
    }

    private static async Task UpsertContactAsync(NivraDbContext db, string ownerUserId, string contactUserId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var id = $"{ownerUserId}:{contactUserId}";
        if (await db.Contacts.AnyAsync(contact => contact.Id == id, cancellationToken))
        {
            return;
        }

        db.Contacts.Add(new ContactRecord
        {
            Id = id,
            OwnerUserId = ownerUserId,
            ContactUserId = contactUserId,
            CreatedAt = now
        });
    }

    private static int ScoreUserSearch(UserAccount user, string query)
    {
        var normalized = (query ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return 1;
        }

        var alias = user.Alias.ToLowerInvariant();
        var display = user.DisplayName?.ToLowerInvariant() ?? string.Empty;
        var phone = user.Phone?.ToLowerInvariant() ?? string.Empty;
        var email = user.Email?.ToLowerInvariant() ?? string.Empty;

        if (alias == normalized) return 100;
        if (alias.StartsWith(normalized, StringComparison.Ordinal)) return 90;
        if (display.StartsWith(normalized, StringComparison.Ordinal)) return 82;
        if (alias.Contains(normalized, StringComparison.Ordinal)) return 72;
        if (display.Contains(normalized, StringComparison.Ordinal)) return 68;
        if (phone.Contains(normalized, StringComparison.Ordinal) || email.Contains(normalized, StringComparison.Ordinal)) return 60;

        var aliasDistance = EditDistance(alias, normalized);
        if (aliasDistance <= 2) return 52 - aliasDistance;

        return 0;
    }

    private static int EditDistance(string left, string right)
    {
        if (left.Length == 0) return right.Length;
        if (right.Length == 0) return left.Length;

        var previous = Enumerable.Range(0, right.Length + 1).ToArray();
        var current = new int[right.Length + 1];

        for (var i = 1; i <= left.Length; i++)
        {
            current[0] = i;
            for (var j = 1; j <= right.Length; j++)
            {
                var cost = left[i - 1] == right[j - 1] ? 0 : 1;
                current[j] = Math.Min(
                    Math.Min(current[j - 1] + 1, previous[j] + 1),
                    previous[j - 1] + cost);
            }

            (previous, current) = (current, previous);
        }

        return previous[right.Length];
    }

    private static async Task<bool> CanViewStoryAsync(NivraDbContext db, StoryRecord story, string viewerUserId, CancellationToken cancellationToken)
    {
        if (story.OwnerUserId == viewerUserId)
        {
            return true;
        }

        if (story.ViewOnce && story.ViewedByUserIds.Contains(viewerUserId))
        {
            return false;
        }

        if (NormalizeStoryTargetType(story.TargetType, story.TargetId) == StoryTargetGroup)
        {
            return story.TargetId is not null &&
                await IsActiveConversationParticipantAsync(db, story.TargetId, viewerUserId, cancellationToken);
        }

        return story.Visibility switch
        {
            StoryVisibility.PublicWorld => true,
            StoryVisibility.Contacts => await AreContactsAsync(db, story.OwnerUserId, viewerUserId, cancellationToken),
            StoryVisibility.MutualContacts => await AreMutualContactsAsync(db, story.OwnerUserId, viewerUserId, cancellationToken),
            StoryVisibility.CloseFriends or StoryVisibility.SelectedUsers => story.AllowedUserIds.Contains(viewerUserId),
            _ => false
        };
    }

    private static async Task<List<string>> StoryAudienceAsync(NivraDbContext db, StoryRecord story, CancellationToken cancellationToken)
    {
        if (NormalizeStoryTargetType(story.TargetType, story.TargetId) == StoryTargetGroup && story.TargetId is not null)
        {
            return (await ActiveConversationParticipantIdsAsync(db, story.TargetId, cancellationToken)).ToList();
        }

        return story.Visibility switch
        {
            StoryVisibility.SelectedUsers or StoryVisibility.CloseFriends => story.AllowedUserIds.ToList(),
            StoryVisibility.Contacts or StoryVisibility.MutualContacts => await db.Contacts
                .Where(contact => contact.OwnerUserId == story.OwnerUserId)
                .Select(contact => contact.ContactUserId)
                .ToListAsync(cancellationToken),
            _ => []
        };
    }

    private static string NormalizeStoryTargetType(string? targetType, string? targetId)
    {
        var normalized = NormalizeOptional(targetType)?.ToLowerInvariant();
        return normalized == StoryTargetGroup || NormalizeOptional(targetId) is not null
            ? StoryTargetGroup
            : StoryTargetContacts;
    }

    private static Task<bool> IsActiveConversationParticipantAsync(NivraDbContext db, string conversationId, string userId, CancellationToken cancellationToken)
    {
        return db.Conversations.AnyAsync(conversation =>
            conversation.Id == conversationId &&
            conversation.Type == ConversationType.Group &&
            conversation.Participants.Any(participant => participant.UserId == userId && participant.RemovedAt == null),
            cancellationToken);
    }

    private static async Task<HashSet<string>> ActiveConversationParticipantIdsAsync(NivraDbContext db, string conversationId, CancellationToken cancellationToken)
    {
        var conversation = await db.Conversations.FirstOrDefaultAsync(candidate => candidate.Id == conversationId && candidate.Type == ConversationType.Group, cancellationToken);
        return conversation?.Participants
            .Where(participant => participant.RemovedAt is null)
            .Select(participant => participant.UserId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .ToHashSet(StringComparer.Ordinal) ?? [];
    }

    private static string? NormalizeStoryEmoji(string? emoji)
    {
        var value = NormalizeOptional(emoji);
        if (value is null || value.Length > 16)
        {
            return null;
        }

        return value;
    }

    private static Task<List<string>> VaultRoomAudienceAsync(NivraDbContext db, string roomId, CancellationToken cancellationToken)
    {
        return db.VaultRoomMembers
            .Where(member => member.VaultRoomId == roomId && member.Status != VaultMemberStatus.Left && member.Status != VaultMemberStatus.Rejected)
            .Select(member => member.UserId)
            .ToListAsync(cancellationToken);
    }

    private static async Task BurnVaultRoomFilesAsync(NivraDbContext db, EncryptedFileStorage storage, string roomId, CancellationToken cancellationToken)
    {
        var files = await db.Files
            .Where(file => file.VaultRoomId == roomId && file.State != FileState.Deleted)
            .ToListAsync(cancellationToken);
        foreach (var file in files)
        {
            file.State = FileState.Deleted;
            await storage.DeleteIfExistsAsync(file, cancellationToken);
        }
    }

    private static void ApplyPrivacyPatch(PrivacySettings target, PatchPrivacyRequest request)
    {
        target.HideNotificationContent = request.HideNotificationContent ?? target.HideNotificationContent;
        target.AllowForwarding = request.AllowForwarding ?? target.AllowForwarding;
        target.AllowScreenshots = request.AllowScreenshots ?? target.AllowScreenshots;
        target.ReadReceipts = request.ReadReceipts ?? target.ReadReceipts;
        if (request.DefaultMessageTtlSeconds.HasValue)
        {
            target.DefaultMessageTtlSeconds = request.DefaultMessageTtlSeconds.Value <= 0
                ? null
                : request.DefaultMessageTtlSeconds.Value;
        }
        target.PrivacyPreset = NormalizeOptional(request.PrivacyPreset) ?? target.PrivacyPreset;
    }

    private static async Task NotifyUsers(IHubContext<NivraHub> hub, IEnumerable<string> userIds, string method, object payload)
    {
        foreach (var userId in userIds.Distinct(StringComparer.Ordinal))
        {
            await hub.Clients.Group(GroupsFor.User(userId)).SendAsync(method, payload);
        }
    }

    private static string? NormalizeOptional(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
    }

    private static string? NormalizeAliasCandidate(string? value)
    {
        var alias = NormalizeOptional(value)?.TrimStart('@');
        return alias is not null && AliasPattern.IsMatch(alias)
            ? PgSqlNivraStore.NormalizeAlias(alias)
            : null;
    }

    private static string? FirstNonBlank(params string?[] values)
    {
        foreach (var value in values)
        {
            var normalized = NormalizeOptional(value);
            if (normalized is not null)
            {
                return normalized;
            }
        }

        return null;
    }

    private static List<string> NormalizeContactHashes(IEnumerable<string>? values, int maxCount)
    {
        var limit = Math.Clamp(maxCount, 1, 10_000);
        return (values ?? Enumerable.Empty<string>())
            .Where(hash => !string.IsNullOrWhiteSpace(hash))
            .Select(hash => hash.Trim().ToLowerInvariant())
            .Where(PrivacyHashes.IsSha256Hex)
            .Distinct(StringComparer.Ordinal)
            .Take(limit)
            .ToList();
    }

    private static async Task NotifyContactJoinedWatchersAsync(
        NivraDbContext db,
        PushNotificationService pushNotifications,
        string joinedUserId,
        string? phoneHash,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(phoneHash))
        {
            return;
        }

        var canBeDiscovered = await db.Users.AsNoTracking().AnyAsync(user =>
            user.Id == joinedUserId &&
            user.DisabledAt == null &&
            user.IsDiscoverable &&
            user.PhoneHash == phoneHash,
            cancellationToken);
        if (!canBeDiscovered)
        {
            return;
        }

        var watcherIds = await db.UserContactHashes.AsNoTracking()
            .Where(contactHash =>
                contactHash.ContactPhoneHash == phoneHash &&
                contactHash.UserId != joinedUserId)
            .Join(
                db.Users.AsNoTracking().Where(user => user.DisabledAt == null),
                contactHash => contactHash.UserId,
                user => user.Id,
                (contactHash, _) => contactHash.UserId)
            .Distinct()
            .Take(10_000)
            .ToListAsync(cancellationToken);

        foreach (var watcherId in watcherIds)
        {
            await pushNotifications.SendContactJoinedAsync(watcherId, cancellationToken);
        }
    }

    private static string? NormalizePhone(string? value)
    {
        var trimmed = NormalizeOptional(value);
        if (trimmed is null)
        {
            return null;
        }

        var hasPlus = trimmed.StartsWith('+');
        var digits = new string(trimmed.Where(char.IsDigit).ToArray());
        if (digits.Length < 7 || digits.Length > 15)
        {
            return null;
        }

        return hasPlus ? $"+{digits}" : digits;
    }

    private static string? NormalizeProfilePhoto(string? value)
    {
        var trimmed = NormalizeOptional(value);
        if (trimmed is null)
        {
            return null;
        }

        if (!trimmed.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase) || trimmed.Length > 350_000)
        {
            return null;
        }

        return trimmed;
    }

    private static string? ClientIp(HttpContext http) => http.Connection.RemoteIpAddress?.ToString();

    private static IResult Error(string code, string message, int statusCode = StatusCodes.Status400BadRequest)
    {
        return Results.Json(new ApiError(code, message), statusCode: statusCode);
    }
}
