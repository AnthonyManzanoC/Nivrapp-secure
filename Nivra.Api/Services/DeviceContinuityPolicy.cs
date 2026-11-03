using System.Text.Json;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public static class DeviceContinuityPolicy
{
    public static string? Coordinates(string? identityKey)
    {
        if(string.IsNullOrEmpty(identityKey)||identityKey.Length>4096)return null;
        try
        {
            using var document=JsonDocument.Parse(identityKey);var value=document.RootElement;
            if(value.ValueKind!=JsonValueKind.Object||value.TryGetProperty("d",out _)||value.GetProperty("kty").GetString()!="EC"||value.GetProperty("crv").GetString()!="P-256")return null;
            var x=value.GetProperty("x").GetString();var y=value.GetProperty("y").GetString();
            return Coordinate(x)&&Coordinate(y)?x+":"+y:null;
        }
        catch(Exception error)when(error is JsonException or KeyNotFoundException or InvalidOperationException){return null;}
    }
    private static bool Coordinate(string? value)=>value?.Length==43&&value.All(c=>char.IsAsciiLetterOrDigit(c)||c is '-' or '_');
    public static bool Valid(DeviceContinuityRequest? proof,string? publishedIdentity)
    {
        if(proof?.Signature?.Length!=88||Coordinates(publishedIdentity) is not { } identity||identity!=proof.TargetIdentity)return false;
        Span<byte> signature=stackalloc byte[64];
        return Convert.TryFromBase64String(proof.Signature,signature,out var written)&&written==64&&Convert.ToBase64String(signature)==proof.Signature;
    }
    public static bool Apply(DeviceRecord source,DeviceRecord target,DeviceContinuityRequest proof)
    {
        if(source.UserId!=target.UserId||source.Id==target.Id||!source.IsTrusted||!target.IsTrusted||source.RevokedAt!=null||target.RevokedAt!=null||!Valid(proof,target.KeyBundle.IdentityKey))return false;
        target.ContinuitySourceDeviceId=source.Id;target.ContinuitySignature=proof.Signature;return true;
    }
    public static DeviceContinuityResponse? Read(DeviceRecord device)=>device.ContinuitySourceDeviceId is { } source&&device.ContinuitySignature is { } signature?new(source,signature):null;
    public static void ClearIfKeyChanges(DeviceRecord device,string? nextIdentity)
    {
        if(Coordinates(device.KeyBundle.IdentityKey)==Coordinates(nextIdentity))return;
        device.ContinuitySourceDeviceId=null;device.ContinuitySignature=null;
    }
}
