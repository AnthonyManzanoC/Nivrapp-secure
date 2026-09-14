using System.Net;
using Microsoft.Extensions.Options;

namespace Nivra.Api.Services;

public sealed class BrevoEmailOptions
{
    public string ApiKey { get; set; } = "";
    public string SenderEmail { get; set; } = "";
    public string SenderName { get; set; } = "Nivra";
    public string PublicAppUrl { get; set; } = "https://nivrapp-secure.vercel.app";
}

public sealed class BrevoEmailService(IHttpClientFactory clients, IOptions<BrevoEmailOptions> options)
{
    private readonly BrevoEmailOptions settings = options.Value;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(settings.ApiKey) && !string.IsNullOrWhiteSpace(settings.SenderEmail);

    public Task SendChallengeAsync(string email, string purpose, string token, CancellationToken cancellationToken)
    {
        var verification = purpose == "verify-email";
        var title = verification ? "Confirma tu correo de recuperación" : "Restablece tu contraseña";
        var copy = verification ? "Estás a un paso de proteger el acceso a tu cuenta privada. Confirma que este correo te pertenece." :
            "Recibimos una solicitud para cambiar la contraseña de tu cuenta Nivra. Tú decides si continuar.";
        var url = settings.PublicAppUrl.TrimEnd('/') + "/recover#token=" + Uri.EscapeDataString(token) + "&purpose=" + purpose;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme != "https") throw new InvalidOperationException("Recovery URL must use HTTPS.");
        return SendAsync(email, title, Html(title, copy, url, verification ? "Confirmar mi correo" : "Elegir nueva contraseña", "Este enlace vence en 15 minutos y funciona una sola vez. Si no lo solicitaste, puedes ignorar este correo."),
            $"{title}\n\n{copy}\n\n{url}\n\nVence en 15 minutos. Si no lo solicitaste, ignora este correo.", cancellationToken);
    }

    public Task SendChangedAsync(string email, CancellationToken cancellationToken) => SendAsync(email, "Tu contraseña de Nivra cambió",
        Html("Tu acceso se ha actualizado", "La contraseña de tu cuenta Nivra cambió. Cerramos las sesiones anteriores. Tus claves de cifrado permanecen en tus dispositivos.",
            settings.PublicAppUrl.TrimEnd('/') + "/recover", "Revisar mi acceso", "Si no reconoces este cambio, restablece tu contraseña y revisa también la seguridad de tu correo."),
        "Tu contraseña de Nivra cambió y cerramos las sesiones anteriores. Si no lo reconoces, restablece tu acceso desde Nivra y protege tu correo.", cancellationToken);

    private async Task SendAsync(string email, string subject, string html, string text, CancellationToken cancellationToken)
    {
        if (!IsConfigured) throw new InvalidOperationException("Email service is not configured.");
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.brevo.com/v3/smtp/email");
        request.Headers.Add("api-key", settings.ApiKey);
        request.Content = JsonContent.Create(new { sender = new { email = settings.SenderEmail, name = settings.SenderName },
            to = new[] { new { email } }, subject, htmlContent = html, textContent = text,
            headers = new Dictionary<string, string> { ["X-Mailin-Track-Clicks"] = "0", ["X-Mailin-Track-Opens"] = "0" }, tags = new[] { "nivra-account-security" } });
        using var client = clients.CreateClient("brevo");
        using var deliveryTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deliveryTimeout.CancelAfter(TimeSpan.FromSeconds(12));
        try
        {
            using var response = await client.SendAsync(request, deliveryTimeout.Token);
            if (!response.IsSuccessStatusCode) throw new HttpRequestException("Transactional email was not accepted.", null, response.StatusCode);
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw new HttpRequestException("Transactional email delivery timed out.", error);
        }
    }

    public static string Html(string title, string copy, string url, string button, string note)
    {
        static string E(string value) => WebUtility.HtmlEncode(value);
        return $"""
        <!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;background:#edf3f1;font-family:Arial,Helvetica,sans-serif;color:#142d27">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:36px 16px">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff;border-radius:24px;overflow:hidden">
        <tr><td style="padding:30px 32px;background:#102d25;color:#6ee7b7;font-size:29px;font-weight:800;letter-spacing:2px">NIVRA<br><span style="font-size:10px;letter-spacing:3px;color:#c0d4cd">TU ESPACIO PRIVADO</span></td></tr>
        <tr><td style="padding:32px"><p style="color:#497668;font-size:11px;letter-spacing:2px">SEGURIDAD DE TU CUENTA</p>
        <h1 style="font-size:27px;line-height:1.2;margin:18px 0">{E(title)}</h1><p style="font-size:16px;line-height:1.7;color:#536960">{E(copy)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#22c58b"><a href="{E(url)}" style="display:inline-block;padding:17px 25px;font-size:15px;font-weight:bold;color:#08382a;text-decoration:none">{E(button)}</a></td></tr></table>
        <p style="padding:18px;background:#f2f7f5;border-radius:12px;font-size:13px;line-height:1.6;color:#5c7067">{E(note)}</p>
        <p style="font-size:12px;color:#6a7b74;line-height:1.6">Nivra nunca te pedirá tu contraseña por correo. Este proceso recupera tu acceso; no envía ni recupera claves privadas de conversaciones.</p>
        </td></tr></table><p style="font-size:11px;color:#7c8f86">Nivra · Privacidad que tú controlas</p></td></tr></table></body></html>
        """;
    }
}
