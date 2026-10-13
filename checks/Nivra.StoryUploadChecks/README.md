# Story upload and media security checks

Run from the repository root:

```powershell
dotnet run --project checks/Nivra.StoryUploadChecks/Nivra.StoryUploadChecks.csproj
```

This executable sends ciphertext through the real AWS SDK request/signature pipeline to an
in-process HTTP fixture with fictional credentials. It checks the Supabase-compatible
non-chunked request, SHA-256 payload signature, exact bytes, bounded input validation,
local Windows commit/cleanup, authorization, file expiry, immutable upload retries and
safe provider failures. EF InMemory fixtures exercise the production story/file access
helper against consumed, deleted, expired and former-group-member stories.
Feed fixtures cover 400 unrelated newer stories ahead of an authorized older story,
mutual contact direction, owner-only statistics and profile privacy. `ToQueryString`
checks the real Npgsql JSON membership translation before the SQL `LIMIT`.

No production users, keys, files, Redis or PostgreSQL are accessed. These checks cover
the upload protocol and authorization behavior; they do not certify production S3
credentials or Supabase pool capacity. Provider compatibility reference:
https://supabase.com/docs/guides/storage/s3/compatibility
