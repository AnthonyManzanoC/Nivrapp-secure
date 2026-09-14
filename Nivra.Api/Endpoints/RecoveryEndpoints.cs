using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public sealed record RecoveryEmailRequest(string Email, string Password);
public sealed record RecoveryRequest(string Identifier);
public sealed record RecoveryCompleteRequest(string Token, string? NewPassword);

public static class RecoveryEndpoints
{
    public static void MapRecoveryEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/auth/recovery").RequireRateLimiting("auth");
        group.MapGet("/email", async Task<IResult> (HttpContext http, NivraDbContext db, BrevoEmailService mail, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            var user = await db.Users.FindAsync([current.UserId], ct);
            return Results.Ok(new { email = user?.RecoveryEmail, verified = user?.RecoveryEmailVerifiedAt is not null, available = mail.IsConfigured });
        });
        group.MapPost("/email/request", async Task<IResult> (RecoveryEmailRequest request, HttpContext http, NivraDbContext db, PasswordHasher hasher, BrevoEmailService mail, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            if (!mail.IsConfigured) return Unavailable();
            var email = NormalizeEmail(request.Email);
            if (email is null || string.IsNullOrEmpty(request.Password) || request.Password.Length > 1024) return Results.BadRequest(new { message = "Revisa el correo y tu contraseña actual." });
            var user = await db.Users.FindAsync([current.UserId], ct);
            if (user is null || !hasher.Verify(request.Password, user.PasswordHash)) return Results.BadRequest(new { message = "La contraseña actual no coincide." });
            var token = await IssueAsync(db, user.Id, email, "verify-email", ct);
            if (token is null) return Results.Json(new { message = "Espera un minuto antes de solicitar otro correo." }, statusCode: 429);
            try { await mail.SendChallengeAsync(email, "verify-email", token, ct); }
            catch (Exception error) when (IsDeliveryFailure(error, ct))
            {
                try { await InvalidateAsync(db, user.Id, token, ct); }
                catch (Exception invalidateError) when (IsDeliveryFailure(invalidateError, ct) || invalidateError is DbUpdateException)
                {
                    // The user is authenticated and can request a new verification link after the rate limit passes.
                }
                return Unavailable();
            }
            return Results.Ok(new { message = "Revisa tu correo y confirma el enlace para activar la recuperación." });
        });
        group.MapPost("/request", async Task<IResult> (RecoveryRequest request, NivraDbContext db, BrevoEmailService mail, ILoggerFactory logs, CancellationToken ct) =>
        {
            var started = System.Diagnostics.Stopwatch.StartNew();
            if (!mail.IsConfigured) return Unavailable();
            var identifier = (request.Identifier ?? "").Trim();
            if (identifier.Length is < 3 or > 40) return Results.BadRequest(new { message = "Ingresa tu ID Nivra o tu alias." });
            var number = NivraNumbers.Normalize(identifier);
            var alias = identifier.TrimStart('@').ToLowerInvariant();
            var user = await db.Users.SingleOrDefaultAsync(u => u.DisabledAt == null &&
                (number != null && !identifier.StartsWith('@') ? u.NivraNumber == number : u.Alias == alias), ct);
            if (user?.RecoveryEmail is not null && user.RecoveryEmailVerifiedAt is not null)
            {
                var token = await IssueAsync(db, user.Id, user.RecoveryEmail, "reset-password", ct);
                if (token is not null)
                {
                    try
                    {
                        await mail.SendChallengeAsync(user.RecoveryEmail, "reset-password", token, ct);
                    }
                    catch (Exception error) when (IsDeliveryFailure(error, ct))
                    {
                        logs.CreateLogger("AccountRecovery").LogWarning("Password-recovery email delivery failed.");
                        try { await InvalidateAsync(db, user.Id, token, ct); }
                        catch (Exception invalidateError) when (IsDeliveryFailure(invalidateError, ct) || invalidateError is DbUpdateException)
                        {
                            logs.CreateLogger("AccountRecovery").LogWarning("Undelivered recovery challenge could not be invalidated.");
                        }
                    }
                }
            }
            // Brevo delivery is awaited so a 200 means the provider accepted the request.  Keep the
            // public route's timing independent of whether an account has a recovery email; otherwise
            // successful delivery would make that fact observable. SendAsync has a 12-second deadline.
            var responseDelay = TimeSpan.FromMilliseconds(13_000 + RandomNumberGenerator.GetInt32(500));
            if (started.Elapsed < responseDelay) await Task.Delay(responseDelay - started.Elapsed, ct);
            return Results.Ok(new { message = "Si la cuenta tiene un correo de recuperación verificado, recibirás un enlace. Revisa también Spam. Si nunca lo configuraste, utiliza una sesión que siga abierta." });
        });
        group.MapPost("/complete", async Task<IResult> (RecoveryCompleteRequest request, NivraDbContext db, PasswordHasher hasher, BrevoEmailService mail, ILoggerFactory logs, CancellationToken ct) =>
        {
            if (!ValidToken(request.Token)) return InvalidToken();
            var hash = HashToken(request.Token);
            var challenge = await db.RecoveryChallenges.AsNoTracking().SingleOrDefaultAsync(item => item.TokenHash == hash, ct);
            if (challenge is null) return InvalidToken();
            string? changedEmail = null;
            var result = await CallCoordination.RunAsync(db, async Task<IResult> () =>
            {
                await using var transaction = await CallCoordination.LockAsync(db, "account-recovery:" + challenge.UserId, ct);
                var item = await db.RecoveryChallenges.SingleOrDefaultAsync(item => item.TokenHash == hash, ct);
                var now = DateTimeOffset.UtcNow;
                if (item is null || item.ConsumedAt is not null || item.ExpiresAt <= now) return InvalidToken();
                var user = await db.Users.SingleOrDefaultAsync(user => user.Id == item.UserId && user.DisabledAt == null, ct);
                if (user is null) return InvalidToken();
                if (item.Purpose == "verify-email") { user.RecoveryEmail = item.Email; user.RecoveryEmailVerifiedAt = now; }
                else if (item.Purpose == "reset-password")
                {
                    if (user.RecoveryEmail != item.Email || user.RecoveryEmailVerifiedAt is null) return InvalidToken();
                    if (string.IsNullOrEmpty(request.NewPassword) || request.NewPassword.Length is < 10 or > 1024)
                        return Results.BadRequest(new { message = "Usa una contraseña de 10 a 1024 caracteres." });
                    user.PasswordHash = hasher.Hash(request.NewPassword);
                    await db.Sessions.Where(session => session.UserId == user.Id && session.RevokedAt == null).ExecuteUpdateAsync(setters => setters.SetProperty(session => session.RevokedAt, now), ct);
                    changedEmail = item.Email;
                }
                else return InvalidToken();
                user.UpdatedAt = now;
                await db.RecoveryChallenges.Where(other => other.UserId == user.Id && other.ConsumedAt == null).ExecuteUpdateAsync(setters => setters.SetProperty(other => other.ConsumedAt, now), ct);
                item.ConsumedAt = now;
                await db.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
                return Results.Ok(new { purpose = item.Purpose, message = item.Purpose == "verify-email" ? "Correo verificado. Tu recuperación está activa." : "Contraseña actualizada. Entra de nuevo con tu ID o alias." });
            });
            if (changedEmail is not null)
            {
                try { await mail.SendChangedAsync(changedEmail, ct); }
                catch (Exception error) when (IsDeliveryFailure(error, ct)) { logs.CreateLogger("AccountRecovery").LogWarning("Password-change notification could not be delivered."); }
            }
            return result;
        });
    }

    private static Task<string?> IssueAsync(NivraDbContext db, string userId, string email, string purpose, CancellationToken ct) => CallCoordination.RunAsync(db, async () =>
    {
        await using var transaction = await CallCoordination.LockAsync(db, "account-recovery:" + userId, ct);
        var now = DateTimeOffset.UtcNow;
        if (await db.RecoveryChallenges.AnyAsync(item => item.UserId == userId && item.Purpose == purpose && item.CreatedAt > now.AddMinutes(-1), ct)) return null;
        await db.RecoveryChallenges.Where(item => item.UserId == userId && item.Purpose == purpose && item.ConsumedAt == null).ExecuteUpdateAsync(setters => setters.SetProperty(item => item.ConsumedAt, now), ct);
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        db.RecoveryChallenges.Add(new AccountRecoveryChallenge { TokenHash = HashToken(token), UserId = userId, Purpose = purpose, Email = email, CreatedAt = now, ExpiresAt = now.AddMinutes(15) });
        await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct);
        return token;
    });

    private static Task InvalidateAsync(NivraDbContext db, string userId, string token, CancellationToken ct) => CallCoordination.RunAsync(db, async () =>
    {
        await using var transaction = await CallCoordination.LockAsync(db, "account-recovery:" + userId, ct);
        var now = DateTimeOffset.UtcNow;
        await db.RecoveryChallenges
            .Where(item => item.TokenHash == HashToken(token) && item.ConsumedAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(item => item.ConsumedAt, now), ct);
        await transaction.CommitAsync(ct);
        return true;
    });

    private static bool IsDeliveryFailure(Exception error, CancellationToken cancellationToken) =>
        error is HttpRequestException or InvalidOperationException ||
        error is OperationCanceledException && !cancellationToken.IsCancellationRequested;

    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    public static bool ValidToken(string? token) => token is { Length: 43 } && token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    public static string? NormalizeEmail(string? value) => value is { Length: <= 320 } && MailAddress.TryCreate(value.Trim(), out var address) && address.Address == value.Trim() ? address.Address.ToLowerInvariant() : null;
    private static IResult InvalidToken() => Results.BadRequest(new { code = "recovery_token_invalid", message = "Este enlace venció, ya fue usado o no es válido. Solicita uno nuevo." });
    private static IResult Unavailable() => Results.Json(new { message = "El correo de recuperación no está disponible en este momento. Inténtalo más tarde." }, statusCode: 503);
}
