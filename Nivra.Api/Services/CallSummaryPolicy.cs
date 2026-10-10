using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public static class CallSummaryPolicy
{
    public const string Prefix = "call-summary:";

    public static bool TryParse(string clientMessageId, out string callId, out string eventName)
    {
        callId = eventName = "";
        var parts = clientMessageId.Split(':');
        if (parts.Length != 3 || parts[0] != "call-summary" || parts[1].Length is < 5 or > 64 ||
            !parts[1].StartsWith("cal_", StringComparison.Ordinal) ||
            !parts[1].All(character => char.IsAsciiLetterOrDigit(character) || character == '_') ||
            parts[2] is not ("call-ended" or "missed-call" or "call-rejected" or "call-failed")) return false;
        callId = parts[1];
        eventName = parts[2];
        return true;
    }

    public static bool CanPublish(CallSession call, string conversationId, string userId, string eventName) =>
        call.ConversationId == conversationId && call.ParticipantUserIds.Contains(userId) &&
        (call.EndedAt is not null || call.Status is CallStatus.Ended or CallStatus.Missed or CallStatus.Failed) &&
        (eventName switch
        {
            "call-ended" => call.Status == CallStatus.Ended && call.EndedAt is not null,
            "missed-call" => call.Status is CallStatus.Ended or CallStatus.Missed,
            "call-rejected" => call.Status == CallStatus.Ended,
            "call-failed" => call.Status is CallStatus.Ended or CallStatus.Failed,
            _ => false
        });
}
