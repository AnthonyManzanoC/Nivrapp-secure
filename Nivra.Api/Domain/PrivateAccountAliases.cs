using System.Globalization;
using System.Security.Cryptography;

namespace Nivra.Api.Domain;

/// <summary>
/// Public, memorable aliases for accounts created without personal contact details.
/// These aliases are identifiers, never passwords or evidence of verified identity.
/// </summary>
public static class PrivateAccountAliases
{
    public const int MaxAllocationAttempts = 16;

    // Fixed impersonal words: no phone, email, account number, timestamp or device data.
    private static readonly string[] Nouns =
    [
        "alba", "ambar", "astro", "aura", "bambu", "bosque", "brisa", "bruma",
        "cauce", "cedro", "cielo", "cobre", "cometa", "coral", "cristal", "delta",
        "duna", "eco", "faro", "flama", "gema", "halo", "hielo", "hoja",
        "horizonte", "isla", "jade", "junco", "lago", "lirio", "llama", "luna",
        "marea", "monte", "musgo", "nacar", "nexo", "nido", "niebla", "nube",
        "oasis", "oceano", "olmo", "onda", "orbita", "palma", "piedra", "pluma",
        "prisma", "rayo", "roble", "roca", "ronda", "sauce", "selva", "senda",
        "sierra", "sol", "sombra", "trazo", "valle", "vela", "viento", "zafiro"
    ];

    private static readonly string[] Qualifiers =
    [
        "agil", "alado", "amable", "ancestral", "azul", "boreal", "brillante", "calido",
        "celeste", "claro", "cobalto", "cosmico", "dorado", "dual", "eterno", "fino",
        "firme", "fluido", "fugaz", "gentil", "glacial", "gris", "infinito", "intacto",
        "irisado", "jovial", "leve", "libre", "limpio", "luminoso", "lunar", "magico",
        "marino", "morado", "naciente", "nitido", "noble", "nocturno", "nuevo", "oculto",
        "ondulante", "opalino", "pacifico", "plateado", "profundo", "puro", "radiante", "remoto",
        "sereno", "silente", "solar", "suave", "sutil", "tenaz", "terso", "tranquilo",
        "turquesa", "unico", "veloz", "verde", "vibrante", "violeta", "vivo", "zenital"
    ];

    public static string Generate() => string.Concat(
        Nouns[RandomNumberGenerator.GetInt32(Nouns.Length)], "-",
        Qualifiers[RandomNumberGenerator.GetInt32(Qualifiers.Length)], "-",
        RandomNumberGenerator.GetInt32(10_000).ToString("D4", CultureInfo.InvariantCulture));

    /// <summary>
    /// Checks existing aliases, including disabled accounts. The database unique index
    /// must still arbitrate concurrent registrations; callers retry a failed insert.
    /// </summary>
    public static async Task<string?> GenerateAvailableAsync(
        Func<string, CancellationToken, Task<bool>> aliasExists,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(aliasExists);
        for (var attempt = 0; attempt < MaxAllocationAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var candidate = Generate();
            var exists = await aliasExists(candidate, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (!exists)
            {
                return candidate;
            }
        }

        return null;
    }
}
