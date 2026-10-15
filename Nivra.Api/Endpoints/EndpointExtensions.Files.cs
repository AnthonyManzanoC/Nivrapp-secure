using System.Net;
using Amazon.S3;
using Amazon.Runtime;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    private static async Task<IResult> UploadEncryptedFileAsync(string fileId, HttpContext http,
        INivraStore store, EncryptedFileStorage storage, TimeProvider timeProvider, CancellationToken cancellationToken)
    {
        var current = http.GetCurrentUser();
        if (current is null) return Results.Unauthorized();
        var file = await store.GetFileAsync(fileId, cancellationToken);
        var now = timeProvider.GetUtcNow();
        if (file is null || file.OwnerUserId != current.UserId || file.State == FileState.Deleted || file.ExpiresAt <= now)
            return Results.NotFound();
        if (http.Request.ContentLength is null or <= 0)
            return Error("invalid_upload", "La subida necesita un cuerpo cifrado valido.");
        if (http.Request.ContentLength > MaxEncryptedUploadBytes)
            return Error("file_too_large", $"El archivo cifrado supera el limite de {MaxUploadLabel}.", StatusCodes.Status413PayloadTooLarge);
        if (file.EncryptedSize > 0 && file.EncryptedSize != http.Request.ContentLength)
            return Error("upload_size_mismatch", "El tamano subido no coincide con la reserva cifrada.");
        // A retry after a lost response must not overwrite an already shared ciphertext object.
        if (file.State == FileState.Uploaded) return Results.Ok(ToFileResponse(file));

        try
        {
            var written = await storage.SaveAsync(file, http.Request.Body, http.Request.ContentLength, cancellationToken);
            file.EncryptedSize = written;
            file.State = FileState.Uploaded;
            file.UploadedAt = timeProvider.GetUtcNow();
            await store.SaveChangesAsync(cancellationToken);
            return Results.Ok(ToFileResponse(file));
        }
        catch (EncryptedUploadException exception)
        {
            return Error(exception.Code, "El archivo cifrado no coincide con su reserva. Vuelve a seleccionarlo.");
        }
        catch (AmazonS3Exception exception)
        {
            // Provider messages and response bodies can contain endpoints/signatures. Log codes only.
            var safeCode = new string((exception.ErrorCode ?? "unknown").Where(char.IsAsciiLetterOrDigit).Take(64).ToArray());
            http.RequestServices.GetRequiredService<ILogger<EncryptedFileStorage>>().LogWarning(
                "Encrypted upload storage failure. ProviderCode={ProviderCode}, ProviderStatus={ProviderStatus}, TraceId={TraceId}",
                safeCode, (int)exception.StatusCode, http.TraceIdentifier);
            if (exception.StatusCode == HttpStatusCode.PaymentRequired)
                return Error("storage_payment_required", "El almacenamiento no acepta archivos. El administrador debe revisar la cuota o facturacion del proveedor.", StatusCodes.Status402PaymentRequired);
            http.Response.Headers.RetryAfter = "3";
            var transient = exception.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.RequestTimeout || (int)exception.StatusCode >= 500;
            return Error(transient ? "storage_unavailable" : "storage_upload_failed",
                "No pudimos guardar el archivo. Conserva tu historia e intentalo de nuevo.",
                transient ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status502BadGateway);
        }
        catch (IOException) when (!cancellationToken.IsCancellationRequested)
        {
            http.RequestServices.GetRequiredService<ILogger<EncryptedFileStorage>>().LogWarning(
                "Encrypted upload stream failure. TraceId={TraceId}", http.TraceIdentifier);
            return Error("storage_unavailable", "No pudimos completar la subida. Conserva tu historia e intentalo de nuevo.", StatusCodes.Status503ServiceUnavailable);
        }
        catch (AmazonClientException) when (!cancellationToken.IsCancellationRequested)
        {
            http.RequestServices.GetRequiredService<ILogger<EncryptedFileStorage>>().LogWarning(
                "Encrypted upload SDK failure. TraceId={TraceId}", http.TraceIdentifier);
            return Error("storage_upload_failed", "No pudimos guardar el archivo. Conserva tu historia e intentalo de nuevo.", StatusCodes.Status502BadGateway);
        }
    }
}
