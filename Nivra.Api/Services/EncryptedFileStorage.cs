using System.Net;
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

    public EncryptedFileStorage(
        IWebHostEnvironment environment,
        IOptions<NivraStorageOptions> options,
        ILogger<EncryptedFileStorage> logger)
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
                AuthenticationRegion = _options.Region
            };

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
        if (_s3 is not null)
        {
            var put = new PutObjectRequest
            {
                BucketName = _options.Bucket,
                Key = GetObjectKey(file.StorageKey),
                InputStream = encryptedBody,
                AutoCloseStream = false,
                ContentType = "application/octet-stream"
            };
            if (expectedLength.HasValue)
            {
                put.Headers.ContentLength = expectedLength.Value;
            }

            await _s3.PutObjectAsync(put, cancellationToken);
            return expectedLength ?? file.EncryptedSize;
        }

        var path = GetPath(file.StorageKey);
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? _rootPath);
        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using var target = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, useAsync: true);
            var written = await CopyCountingAsync(encryptedBody, target, cancellationToken);
            File.Move(tempPath, path, overwrite: true);
            return written;
        }
        catch
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }

            throw;
        }
    }

    public async Task<Stream> OpenReadAsync(FileObject file, CancellationToken cancellationToken)
    {
        if (_s3 is not null)
        {
            using var response = await _s3.GetObjectAsync(new GetObjectRequest
            {
                BucketName = _options.Bucket,
                Key = GetObjectKey(file.StorageKey)
            }, cancellationToken);

            var buffer = new MemoryStream();
            await response.ResponseStream.CopyToAsync(buffer, cancellationToken);
            buffer.Position = 0;
            return buffer;
        }

        return File.OpenRead(GetPath(file.StorageKey));
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

    private static bool S3Configured(NivraStorageOptions options)
    {
        return WantsS3(options) &&
            !string.IsNullOrWhiteSpace(options.Bucket) &&
            !string.IsNullOrWhiteSpace(options.Endpoint) &&
            !string.IsNullOrWhiteSpace(options.AccessKeyId) &&
            !string.IsNullOrWhiteSpace(options.SecretAccessKey);
    }

    private static async Task<long> CopyCountingAsync(Stream source, Stream target, CancellationToken cancellationToken)
    {
        var buffer = new byte[128 * 1024];
        long written = 0;
        int read;
        while ((read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            written += read;
        }

        return written;
    }
}
