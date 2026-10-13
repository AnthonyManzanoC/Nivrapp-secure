using System.Net;
using System.Security.Cryptography;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public sealed class NivraStorageOptions
{
    public string Provider { get; init; } = "Local";
    public string Bucket { get; init; } = "nivra-vault";
    public string Endpoint { get; init; } = "";
    public string Region { get; init; } = "us-east-2";
    public string AccessKeyId { get; init; } = "";
    public string SecretAccessKey { get; init; } = "";
    public string LocalPath { get; init; } = Path.Combine("Data", "EncryptedFiles");
}

public sealed class EncryptedFileStorage
{
    private readonly string _rootPath;
    private readonly NivraStorageOptions _options;
    private readonly ILogger<EncryptedFileStorage> _logger;
    private readonly IAmazonS3? _s3;
    public bool UsesSharedStorage => _s3 is not null;

    public EncryptedFileStorage(
        IWebHostEnvironment environment,
        IOptions<NivraStorageOptions> options,
        ILogger<EncryptedFileStorage> logger,
        HttpClientFactory? httpClientFactory = null)
    {
        _options = options.Value;
        _logger = logger;
        _rootPath = Path.Combine(environment.ContentRootPath, _options.LocalPath);
        if (!S3Configured(_options))
        {
            Directory.CreateDirectory(_rootPath);
        }

        if (S3Configured(_options))
        {
            var config = new AmazonS3Config
            {
                ServiceURL = _options.Endpoint.TrimEnd('/'),
                ForcePathStyle = true,
                AuthenticationRegion = _options.Region,
                HttpClientFactory = httpClientFactory
            };
            if (IsSupabase(_options))
            {
                // Supabase's S3 protocol does not support the SDK's optional checksum trailers.
                // Keep SigV4 payload signing; a bounded, seekable ciphertext file supplies its hash.
                config.RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED;
                config.ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED;
            }

            _s3 = new AmazonS3Client(
                new BasicAWSCredentials(_options.AccessKeyId, _options.SecretAccessKey),
                config);
        }
        else if (WantsS3(_options))
        {
            _logger.LogWarning("Supabase S3 storage is selected but credentials are incomplete. Falling back to local encrypted file storage.");
        }
    }

    public Task<long> SaveAsync(FileObject file, Stream encryptedBody, CancellationToken cancellationToken)
    {
        return SaveAsync(file, encryptedBody, expectedLength: null, cancellationToken);
    }

    public async Task<long> SaveAsync(FileObject file, Stream encryptedBody, long? expectedLength, CancellationToken cancellationToken)
    {
        if (expectedLength is <= 0 || expectedLength > EncryptedDownloadPolicy.MaxEncryptedBytes)
            throw new EncryptedUploadException("invalid_upload");
        if (expectedLength.HasValue && file.EncryptedSize > 0 && expectedLength != file.EncryptedSize)
            throw new EncryptedUploadException("upload_size_mismatch");

        // Request.Body is not seekable. AWS signing/retries must never read a consumed HTTP body,
        // and a 256 MB encrypted attachment must not be buffered in managed memory.
        var directory = _s3 is null ? _rootPath : Path.GetTempPath();
        Directory.CreateDirectory(directory);
        var tempPath = Path.Combine(directory, $"nivra-upload-{Guid.NewGuid():N}.tmp");
        try
        {
            long written;
            string digest;
            await using (var staged = new FileStream(tempPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 128 * 1024, FileOptions.Asynchronous))
            {
                (written, digest) = await CopyCountingAsync(encryptedBody, staged, expectedLength, cancellationToken);
                if (written == 0 || (expectedLength.HasValue && written != expectedLength) || (file.EncryptedSize > 0 && written != file.EncryptedSize))
                    throw new EncryptedUploadException("upload_size_mismatch");
                if (file.ClientSha256 is { Length: > 0 } expectedHash && !string.Equals(expectedHash, digest, StringComparison.OrdinalIgnoreCase))
                    throw new EncryptedUploadException("upload_integrity_mismatch");
                staged.Position = 0;

                if (_s3 is not null)
                {
                    var put = new PutObjectRequest
                    {
                        BucketName = _options.Bucket,
                        Key = GetObjectKey(file.StorageKey),
                        InputStream = staged,
                        AutoCloseStream = false,
                        ContentType = "application/octet-stream",
                        UseChunkEncoding = !IsSupabase(_options),
                        DisableDefaultChecksumValidation = IsSupabase(_options) ? true : null
                    };
                    put.Headers.ContentLength = written;
                    await _s3.PutObjectAsync(put, cancellationToken);
                }
            }
            // Close before moving: Windows will reject a move of a FileShare.None stream.
            if (_s3 is null) File.Move(tempPath, GetPath(file.StorageKey), overwrite: true);
            file.ClientSha256 = digest;
            return written;
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }

    public async Task<Stream> OpenReadAsync(FileObject file, CancellationToken cancellationToken)
    {
        if (_s3 is not null)
        {
            var response = await _s3.GetObjectAsync(new GetObjectRequest
            {
                BucketName = _options.Bucket,
                Key = GetObjectKey(file.StorageKey)
            }, cancellationToken);

            return new OwnedReadStream(response.ResponseStream, response);
        }

        return File.OpenRead(GetPath(file.StorageKey));
    }

    public EncryptedDownloadAccess? CreateDownloadAccess(FileObject file, DateTimeOffset now)
    {
        if (_s3 is null || file.State != FileState.Uploaded || file.EncryptedSize is < 1 or > EncryptedDownloadPolicy.MaxEncryptedBytes) return null;
        var deadline = EncryptedDownloadPolicy.Deadline(now, file.ExpiresAt);
        if (deadline <= now) return null;
        var url = _s3.GetPreSignedURL(new GetPreSignedUrlRequest
        {
            BucketName = _options.Bucket,
            Key = GetObjectKey(file.StorageKey),
            Verb = HttpVerb.GET,
            Protocol = Protocol.HTTPS,
            Expires = deadline.UtcDateTime
        });
        return EncryptedDownloadPolicy.IsValidUrl(url, _options.Endpoint)
            ? new EncryptedDownloadAccess(url, deadline, file.EncryptedSize, "application/octet-stream")
            : null;
    }

    public async Task DeleteIfExistsAsync(FileObject file, CancellationToken cancellationToken)
    {
        if (_s3 is not null)
        {
            await _s3.DeleteObjectAsync(new DeleteObjectRequest
            {
                BucketName = _options.Bucket,
                Key = GetObjectKey(file.StorageKey)
            }, cancellationToken);
            return;
        }

        var path = GetPath(file.StorageKey);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    public async Task<bool> ExistsAsync(FileObject file, CancellationToken cancellationToken)
    {
        if (_s3 is not null)
        {
            try
            {
                await _s3.GetObjectMetadataAsync(new GetObjectMetadataRequest
                {
                    BucketName = _options.Bucket,
                    Key = GetObjectKey(file.StorageKey)
                }, cancellationToken);
                return true;
            }
            catch (AmazonS3Exception exception) when (
                exception.StatusCode == HttpStatusCode.NotFound ||
                string.Equals(exception.ErrorCode, "NoSuchKey", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(exception.ErrorCode, "NotFound", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return File.Exists(GetPath(file.StorageKey));
    }

    private string GetPath(string storageKey)
    {
        var safeName = storageKey.Replace("/", "_", StringComparison.Ordinal).Replace("\\", "_", StringComparison.Ordinal);
        return Path.Combine(_rootPath, safeName);
    }

    private string GetObjectKey(string storageKey)
    {
        var key = storageKey.Replace("\\", "/", StringComparison.Ordinal).TrimStart('/');
        var bucketPrefix = $"{_options.Bucket.Trim('/')}/";
        return key.StartsWith(bucketPrefix, StringComparison.OrdinalIgnoreCase)
            ? key[bucketPrefix.Length..]
            : key;
    }

    private static bool WantsS3(NivraStorageOptions options)
    {
        return string.Equals(options.Provider, "SupabaseS3", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(options.Provider, "S3", StringComparison.OrdinalIgnoreCase);
    }

    private static bool S3Configured(NivraStorageOptions options) => HasSharedConfiguration(options);

    private static bool IsSupabase(NivraStorageOptions options) =>
        string.Equals(options.Provider, "SupabaseS3", StringComparison.OrdinalIgnoreCase);

    public static bool HasSharedConfiguration(NivraStorageOptions options)
    {
        return WantsS3(options) &&
            !string.IsNullOrWhiteSpace(options.Bucket) &&
            !string.IsNullOrWhiteSpace(options.Endpoint) &&
            !string.IsNullOrWhiteSpace(options.AccessKeyId) &&
            !string.IsNullOrWhiteSpace(options.SecretAccessKey);
    }

    private static async Task<(long Written, string Digest)> CopyCountingAsync(Stream source, Stream target, long? expectedLength, CancellationToken cancellationToken)
    {
        var buffer = new byte[128 * 1024];
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long written = 0;
        int read;
        while ((read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
        {
            written += read;
            if (written > EncryptedDownloadPolicy.MaxEncryptedBytes || (expectedLength.HasValue && written > expectedLength))
                throw new EncryptedUploadException("upload_size_mismatch");
            hash.AppendData(buffer, 0, read);
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }

        return (written, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
    }
}
