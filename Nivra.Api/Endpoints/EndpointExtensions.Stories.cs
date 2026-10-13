using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    // Construct the response and audience before committing. Redis/FCM are delivery transports;
    // their availability must not turn a successfully persisted publication into a retryable 500.
    private static async Task<IResult> SaveStoryPublicationAsync(StoryRecord story, NivraDbContext db,
        StoryResponse response, HttpContext http, Func<CancellationToken, Task> notify, CancellationToken cancellationToken)
    {
        db.Stories.Add(story);
        await db.SaveChangesAsync(cancellationToken);
        try
        {
            await notify(cancellationToken);
        }
        catch (Exception exception)
        {
            http.RequestServices.GetRequiredService<ILogger<NivraDbContext>>().LogWarning(
                "Persisted story notification failed. Type={FailureType}, TraceId={TraceId}",
                exception.GetType().Name, http.TraceIdentifier);
        }
        return Results.Created($"/stories/{story.Id}", response);
    }
}
