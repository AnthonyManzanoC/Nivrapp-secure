# Private accounts and Nivra ID

`NivraNumber` is a public nine-digit account identifier, separate from `Phone` and never accepted as a password or token. It is returned as `nivraNumber` on account, contact and directory responses and displayed as `123 456 789`. Sharing the ID permits exact discovery under the same rules as sharing an alias.

`POST /auth/register-private` accepts a password (existing minimum: 10 characters), device name, hardware ID and public key bundle. The server creates a random internal alias, leaves phone/email absent and starts the account with directory discoverability disabled. Existing alias registration and QR linking continue to work. The login SMS tab explains that access is in testing; Firebase/SMS service code and endpoints are unchanged.

For new accounts, `NivraDbContext` assigns an ID using `RandomNumberGenerator.GetInt32(100000000, 1000000000)`. The unique `IX_users_NivraNumber` index is authoritative, and insertion retries up to 16 attempts for that specific collision. Other database errors are not retried as ID collisions. IDs are not reused when accounts are disabled. A format check enforces exactly nine ASCII digits, without a leading zero.

The additive `PrivateAccountNumbers` migration creates the nullable column and unique index before backfilling every existing account. Backfill uses PostgreSQL `gen_random_uuid()` randomness and retries unique violations per row, then makes the field non-null. A database default covers older clients or services writing during rollout. Existing aliases, phone values, account IDs and message keys are preserved. The migration also carries the separately coordinated nullable `calls.MediaEncryption` field. Release verification must confirm that the migration has been applied to the target database before serving the new client.

Login accepts canonical IDs, spaced IDs, hyphenated IDs and aliases. Explicit `@alias` always selects the alias namespace, including a legacy numeric alias. Numeric login first calls `/auth/login` with `resolveOnly:true`; the server returns the canonical alias only after checking the password. The client then loads device keys under that alias and completes ordinary login. This avoids replacing local key material just because the same user entered an ID instead of their alias. The preflight is covered by the existing authentication rate limiter and creates no device/session.

ID generation/backfill avoids existing numeric aliases. New alias registration/profile changes reject an ID already assigned to another account. An explicit `@` remains the unambiguous way to address legacy numeric aliases during mixed-version rollout.

Validation covers identifier parsing, legacy numeric aliases, key reuse and rejected-credential behavior, and creation without phone/email. Backend checks inspect the unique index, format constraint and migration ordering. Before release, apply the additive migration before serving the new backend and frontend together, and verify login with both forms for one existing account.

## Recovery email

Private registration still does not require an email address. An authenticated account can add one later after confirming its current password. `RecoveryEmail`, its verification timestamp, and the recipient recorded for an active challenge are intentionally stored as plaintext server-side metadata: the server and mail provider need the address to send the verification or recovery message. Passwords, private message keys, and raw recovery secrets are not stored in those fields.

The recovery link contains a 256-bit opaque random token, rather than a JWT. The database stores only its SHA-256 hash. A token has one use, expires after 15 minutes, and a newer request invalidates the prior outstanding challenge for the same purpose. Completing a password reset revokes active sessions for that account.

The public recovery request always gives the same successful response for an unknown identifier, an account without a verified recovery email, and a configured account. This prevents account or recovery-email enumeration. The signed-in account page is the place that tells an owner that no recovery email is configured; without a verified address, there is no remote password-recovery route.
