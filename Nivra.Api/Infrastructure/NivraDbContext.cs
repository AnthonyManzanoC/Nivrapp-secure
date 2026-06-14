using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Nivra.Api.Domain;

namespace Nivra.Api.Infrastructure;

public sealed class NivraDbContext(DbContextOptions<NivraDbContext> options) : DbContext(options)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public DbSet<UserAccount> Users => Set<UserAccount>();
    public DbSet<DeviceRecord> Devices => Set<DeviceRecord>();
    public DbSet<SessionRecord> Sessions => Set<SessionRecord>();
    public DbSet<ContactRecord> Contacts => Set<ContactRecord>();
    public DbSet<UserContactHash> UserContactHashes => Set<UserContactHash>();
    public DbSet<FriendRequestRecord> FriendRequests => Set<FriendRequestRecord>();
    public DbSet<ConversationRecord> Conversations => Set<ConversationRecord>();
    public DbSet<MessageEnvelope> Messages => Set<MessageEnvelope>();
    public DbSet<FileObject> Files => Set<FileObject>();
    public DbSet<VaultItem> VaultItems => Set<VaultItem>();
    public DbSet<StoryRecord> Stories => Set<StoryRecord>();
    public DbSet<VaultRoom> VaultRooms => Set<VaultRoom>();
    public DbSet<VaultRoomMember> VaultRoomMembers => Set<VaultRoomMember>();
    public DbSet<VaultRoomInvite> VaultRoomInvites => Set<VaultRoomInvite>();
    public DbSet<CallSession> Calls => Set<CallSession>();
    public DbSet<PushTokenRecord> PushTokens => Set<PushTokenRecord>();
    public DbSet<AdCampaign> AdCampaigns => Set<AdCampaign>();
    public DbSet<AdImpressionAggregate> AdImpressions => Set<AdImpressionAggregate>();
    public DbSet<SecurityAuditEvent> SecurityAuditEvents => Set<SecurityAuditEvent>();
    public DbSet<PlanEntitlements> PlanEntitlements => Set<PlanEntitlements>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema("public");

        var stringListConverter = new ValueConverter<List<string>, string>(
            value => JsonSerializer.Serialize(value, JsonOptions),
            value => JsonSerializer.Deserialize<List<string>>(value, JsonOptions) ?? new List<string>());
        var stringListComparer = new ValueComparer<List<string>>(
            (left, right) => (left ?? new()).SequenceEqual(right ?? new()),
            value => value.Aggregate(0, (hash, item) => HashCode.Combine(hash, item.GetHashCode(StringComparison.Ordinal))),
            value => value.ToList());

        var stringSetConverter = new ValueConverter<HashSet<string>, string>(
            value => JsonSerializer.Serialize(value, JsonOptions),
            value => new HashSet<string>(JsonSerializer.Deserialize<List<string>>(value, JsonOptions) ?? new List<string>(), StringComparer.Ordinal));
        var stringSetComparer = new ValueComparer<HashSet<string>>(
            (left, right) => (left ?? new(StringComparer.Ordinal)).SetEquals(right ?? new(StringComparer.Ordinal)),
            value => value.Order(StringComparer.Ordinal).Aggregate(0, (hash, item) => HashCode.Combine(hash, item.GetHashCode(StringComparison.Ordinal))),
            value => new HashSet<string>(value, StringComparer.Ordinal));

        static ValueConverter<List<T>, string> JsonListConverter<T>() => new(
            value => JsonSerializer.Serialize(value, JsonOptions),
            value => JsonSerializer.Deserialize<List<T>>(value, JsonOptions) ?? new List<T>());

        static ValueComparer<List<T>> JsonListComparer<T>() => new(
            (left, right) => JsonSerializer.Serialize(left ?? new List<T>(), JsonOptions) == JsonSerializer.Serialize(right ?? new List<T>(), JsonOptions),
            value => StringComparer.Ordinal.GetHashCode(JsonSerializer.Serialize(value ?? new List<T>(), JsonOptions)),
            value => JsonSerializer.Deserialize<List<T>>(JsonSerializer.Serialize(value ?? new List<T>(), JsonOptions), JsonOptions) ?? new List<T>());

        modelBuilder.Entity<PlanEntitlements>().HasNoKey().ToView(null);

        modelBuilder.Entity<UserAccount>(entity =>
        {
            entity.ToTable("users");
            entity.HasKey(user => user.Id);
            entity.Property(user => user.Id).HasMaxLength(64);
            entity.Property(user => user.Alias).HasMaxLength(32).IsRequired();
            entity.HasIndex(user => user.Alias).IsUnique();
            entity.Property(user => user.DisplayName).HasMaxLength(160);
            entity.Property(user => user.Email).HasMaxLength(320);
            entity.Property(user => user.Phone).HasMaxLength(40);
            entity.Property(user => user.PhoneHash).HasMaxLength(64);
            entity.Property(user => user.RequiresAlias).HasDefaultValue(false);
            entity.Property(user => user.Bio).HasMaxLength(500);
            entity.Property(user => user.ProfilePhotoDataUrl);
            entity.Property(user => user.IsDiscoverable).HasDefaultValue(true);
            entity.Property(user => user.PlanCode).HasMaxLength(32).HasDefaultValue("free");
            entity.Property(user => user.CreatedAt).IsRequired();
            entity.Property(user => user.UpdatedAt).IsRequired();
            entity.HasIndex(user => user.DisabledAt);
            entity.HasIndex(user => user.Phone)
                .IsUnique()
                .HasFilter("\"Phone\" IS NOT NULL AND \"DisabledAt\" IS NULL");
            entity.HasIndex(user => user.PhoneHash)
                .IsUnique()
                .HasFilter("\"PhoneHash\" IS NOT NULL AND \"DisabledAt\" IS NULL");
            entity.HasIndex(user => user.IsDiscoverable);

            entity.OwnsOne(user => user.PasswordHash, owned =>
            {
                owned.Property(hash => hash.Algorithm).HasColumnName("password_algorithm").HasMaxLength(64).IsRequired();
                owned.Property(hash => hash.Iterations).HasColumnName("password_iterations").IsRequired();
                owned.Property(hash => hash.Salt).HasColumnName("password_salt").HasMaxLength(512).IsRequired();
                owned.Property(hash => hash.Hash).HasColumnName("password_hash").HasMaxLength(512).IsRequired();
            });

            entity.OwnsOne(user => user.PrivacySettings, owned =>
            {
                MapPrivacySettings(owned, "privacy_");
            });
        });

        modelBuilder.Entity<DeviceRecord>(entity =>
        {
            entity.ToTable("devices");
            entity.HasKey(device => device.Id);
            entity.Property(device => device.Id).HasMaxLength(64);
            entity.Property(device => device.UserId).HasMaxLength(64).IsRequired();
            entity.Property(device => device.Name).HasMaxLength(160).IsRequired();
            entity.Property(device => device.HardwareId).HasMaxLength(128);
            entity.HasIndex(device => new { device.UserId, device.RevokedAt });
            entity.HasIndex(device => new { device.UserId, device.HardwareId })
                .IsUnique()
                .HasFilter("\"HardwareId\" IS NOT NULL");
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(device => device.UserId).OnDelete(DeleteBehavior.Cascade);

            entity.OwnsOne(device => device.KeyBundle, owned =>
            {
                owned.Property(bundle => bundle.IdentityKey).HasColumnName("identity_key");
                owned.Property(bundle => bundle.SignedPreKey).HasColumnName("signed_pre_key");
                owned.Property(bundle => bundle.PreKeySignature).HasColumnName("pre_key_signature");
                owned.Property(bundle => bundle.LastRotatedAt).HasColumnName("keys_last_rotated_at").IsRequired();
                owned.Property(bundle => bundle.OneTimePreKeys)
                    .HasColumnName("one_time_pre_keys")
                    .HasColumnType("jsonb")
                    .HasConversion(stringListConverter)
                    .Metadata.SetValueComparer(stringListComparer);
            });
        });

        modelBuilder.Entity<SessionRecord>(entity =>
        {
            entity.ToTable("sessions");
            entity.HasKey(session => session.Id);
            entity.Property(session => session.Id).HasMaxLength(64);
            entity.Property(session => session.UserId).HasMaxLength(64).IsRequired();
            entity.Property(session => session.DeviceId).HasMaxLength(64).IsRequired();
            entity.Property(session => session.RefreshTokenHash).HasMaxLength(128).IsRequired();
            entity.Property(session => session.CreatedIp).HasMaxLength(96);
            entity.HasIndex(session => session.RefreshTokenHash).IsUnique();
            entity.HasIndex(session => new { session.UserId, session.RevokedAt });
            entity.HasIndex(session => new { session.DeviceId, session.RevokedAt });
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(session => session.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<DeviceRecord>().WithMany().HasForeignKey(session => session.DeviceId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ContactRecord>(entity =>
        {
            entity.ToTable("contacts");
            entity.HasKey(contact => contact.Id);
            entity.Property(contact => contact.Id).HasMaxLength(160);
            entity.Property(contact => contact.OwnerUserId).HasMaxLength(64).IsRequired();
            entity.Property(contact => contact.ContactUserId).HasMaxLength(64).IsRequired();
            entity.Property(contact => contact.IsFavorite).HasDefaultValue(false);
            entity.HasIndex(contact => new { contact.OwnerUserId, contact.ContactUserId }).IsUnique();
            entity.HasIndex(contact => contact.ContactUserId);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(contact => contact.OwnerUserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(contact => contact.ContactUserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<UserContactHash>(entity =>
        {
            entity.ToTable("user_contact_hashes");
            entity.HasKey(contactHash => new { contactHash.UserId, contactHash.ContactPhoneHash });
            entity.Property(contactHash => contactHash.UserId).HasMaxLength(64).IsRequired();
            entity.Property(contactHash => contactHash.ContactPhoneHash).HasMaxLength(64).IsRequired();
            entity.HasIndex(contactHash => contactHash.ContactPhoneHash);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(contactHash => contactHash.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<FriendRequestRecord>(entity =>
        {
            entity.ToTable("friend_requests");
            entity.HasKey(request => request.Id);
            entity.Property(request => request.Id).HasMaxLength(64);
            entity.Property(request => request.FromUserId).HasMaxLength(64).IsRequired();
            entity.Property(request => request.ToUserId).HasMaxLength(64).IsRequired();
            entity.Property(request => request.Status).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(request => request.Message).HasMaxLength(500);
            entity.HasIndex(request => new { request.FromUserId, request.ToUserId, request.Status });
            entity.HasIndex(request => new { request.ToUserId, request.Status });
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(request => request.FromUserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(request => request.ToUserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ConversationRecord>(entity =>
        {
            entity.ToTable("conversations");
            entity.HasKey(conversation => conversation.Id);
            entity.Property(conversation => conversation.Id).HasMaxLength(64);
            entity.Property(conversation => conversation.Type).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(conversation => conversation.CreatedByUserId).HasMaxLength(64).IsRequired();
            entity.HasIndex(conversation => conversation.LastMessageAt);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(conversation => conversation.CreatedByUserId).OnDelete(DeleteBehavior.Restrict);

            entity.OwnsOne(conversation => conversation.PrivacySettings, owned =>
            {
                MapPrivacySettings(owned, "privacy_");
            });

            entity.OwnsOne(conversation => conversation.Settings, owned =>
            {
                owned.Property(settings => settings.EditInfo).HasColumnName("group_edit_info").HasMaxLength(16).HasDefaultValue("admins");
                owned.Property(settings => settings.SendMessages).HasColumnName("group_send_messages").HasMaxLength(16).HasDefaultValue("all");
                owned.Property(settings => settings.AddMembers).HasColumnName("group_add_members").HasMaxLength(16).HasDefaultValue("admins");
            });

            entity.OwnsMany(conversation => conversation.Participants, owned =>
            {
                owned.ToTable("conversation_participants");
                owned.WithOwner().HasForeignKey("conversation_id");
                owned.Property<string>("conversation_id").HasMaxLength(64);
                owned.Property(participant => participant.UserId).HasColumnName("user_id").HasMaxLength(64).IsRequired();
                owned.Property(participant => participant.Role).HasColumnName("role").HasConversion<string>().HasMaxLength(32).IsRequired();
                owned.Property(participant => participant.CanInvite).HasColumnName("can_invite");
                owned.Property(participant => participant.CanChangePrivacy).HasColumnName("can_change_privacy");
                owned.Property(participant => participant.JoinedAt).HasColumnName("joined_at");
                owned.Property(participant => participant.RemovedAt).HasColumnName("removed_at");
                owned.HasKey("conversation_id", nameof(ConversationParticipant.UserId));
                owned.HasIndex(nameof(ConversationParticipant.UserId), nameof(ConversationParticipant.RemovedAt));
            });
        });

        modelBuilder.Entity<MessageEnvelope>(entity =>
        {
            entity.ToTable("messages");
            entity.HasKey(message => message.Id);
            entity.Property(message => message.Id).HasMaxLength(64);
            entity.Property(message => message.ConversationId).HasMaxLength(64).IsRequired();
            entity.Property(message => message.ClientMessageId).HasMaxLength(128).IsRequired();
            entity.Property(message => message.SenderUserId).HasMaxLength(64).IsRequired();
            entity.Property(message => message.SenderDeviceId).HasMaxLength(64).IsRequired();
            entity.Property(message => message.Kind).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.HasIndex(message => new { message.ConversationId, message.ServerReceivedAt });
            entity.HasIndex(message => message.ExpiresAt);
            entity.HasIndex(message => new { message.SenderUserId, message.ClientMessageId }).IsUnique();
            entity.HasOne<ConversationRecord>().WithMany().HasForeignKey(message => message.ConversationId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(message => message.SenderUserId).OnDelete(DeleteBehavior.Restrict);
            entity.HasOne<DeviceRecord>().WithMany().HasForeignKey(message => message.SenderDeviceId).OnDelete(DeleteBehavior.Restrict);

            entity.OwnsMany(message => message.Recipients, owned =>
            {
                owned.ToTable("message_recipients");
                owned.WithOwner().HasForeignKey("message_id");
                owned.Property<string>("message_id").HasMaxLength(64);
                owned.Property(recipient => recipient.UserId).HasColumnName("user_id").HasMaxLength(64).IsRequired();
                owned.Property(recipient => recipient.DeviceId).HasColumnName("device_id").HasMaxLength(64).IsRequired();
                owned.Property(recipient => recipient.Ciphertext).HasColumnName("ciphertext").IsRequired();
                owned.Property(recipient => recipient.Header).HasColumnName("header");
                owned.Property(recipient => recipient.FileObjectId).HasColumnName("file_object_id").HasMaxLength(64);
                owned.HasKey("message_id", nameof(RecipientCiphertext.UserId), nameof(RecipientCiphertext.DeviceId));
                owned.HasIndex(nameof(RecipientCiphertext.UserId), nameof(RecipientCiphertext.DeviceId));
                owned.HasIndex(nameof(RecipientCiphertext.FileObjectId));
            });

            entity.OwnsMany(message => message.Receipts, owned =>
            {
                owned.ToTable("message_receipts");
                owned.WithOwner().HasForeignKey("message_id");
                owned.Property<string>("message_id").HasMaxLength(64);
                owned.Property(receipt => receipt.UserId).HasColumnName("user_id").HasMaxLength(64).IsRequired();
                owned.Property(receipt => receipt.DeviceId).HasColumnName("device_id").HasMaxLength(64).IsRequired();
                owned.Property(receipt => receipt.DeliveredAt).HasColumnName("delivered_at");
                owned.Property(receipt => receipt.ReadAt).HasColumnName("read_at");
                owned.Property(receipt => receipt.DeletedAt).HasColumnName("deleted_at");
                owned.HasKey("message_id", nameof(DeliveryReceipt.UserId), nameof(DeliveryReceipt.DeviceId));
                owned.HasIndex(nameof(DeliveryReceipt.UserId), nameof(DeliveryReceipt.DeviceId), nameof(DeliveryReceipt.DeletedAt));
            });
        });

        modelBuilder.Entity<FileObject>(entity =>
        {
            entity.ToTable("files");
            entity.HasKey(file => file.Id);
            entity.Property(file => file.Id).HasMaxLength(64);
            entity.Property(file => file.OwnerUserId).HasMaxLength(64).IsRequired();
            entity.Property(file => file.StorageKey).HasMaxLength(512).IsRequired();
            entity.Property(file => file.VaultRoomId).HasMaxLength(64);
            entity.Property(file => file.State).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(file => file.AllowedUserIds)
                .HasColumnName("allowed_user_ids")
                .HasColumnType("jsonb")
                .HasConversion(stringSetConverter)
                .Metadata.SetValueComparer(stringSetComparer);
            entity.HasIndex(file => file.OwnerUserId);
            entity.HasIndex(file => file.StorageKey).IsUnique();
            entity.HasIndex(file => file.ExpiresAt);
            entity.HasIndex(file => file.VaultRoomId);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(file => file.OwnerUserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<VaultRoom>().WithMany().HasForeignKey(file => file.VaultRoomId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<VaultItem>(entity =>
        {
            entity.ToTable("vault_items");
            entity.HasKey(item => item.Id);
            entity.Property(item => item.Id).HasMaxLength(64);
            entity.Property(item => item.UserId).HasMaxLength(64).IsRequired();
            entity.Property(item => item.ParentId).HasMaxLength(64);
            entity.Property(item => item.FileObjectId).HasMaxLength(64);
            entity.Property(item => item.Kind).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.HasIndex(item => new { item.UserId, item.DeletedAt });
            entity.HasIndex(item => item.ParentId);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(item => item.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<FileObject>().WithMany().HasForeignKey(item => item.FileObjectId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<StoryRecord>(entity =>
        {
            entity.ToTable("stories");
            entity.HasKey(story => story.Id);
            entity.Property(story => story.Id).HasMaxLength(64);
            entity.Property(story => story.OwnerUserId).HasMaxLength(64).IsRequired();
            entity.Property(story => story.Visibility).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(story => story.TargetType).HasMaxLength(32).HasDefaultValue("contacts").IsRequired();
            entity.Property(story => story.TargetId).HasMaxLength(64);
            entity.Property(story => story.EncryptedPayload).IsRequired();
            entity.Property(story => story.Caption).HasMaxLength(500);
            entity.Property(story => story.MediaFileObjectId).HasMaxLength(64);
            entity.Property(story => story.OriginalStoryId).HasMaxLength(64);
            entity.Property(story => story.OriginalAuthorId).HasMaxLength(64);
            entity.Property(story => story.AllowedUserIds)
                .HasColumnName("allowed_user_ids")
                .HasColumnType("jsonb")
                .HasConversion(stringSetConverter)
                .Metadata.SetValueComparer(stringSetComparer);
            entity.Property(story => story.ViewedByUserIds)
                .HasColumnName("viewed_by_user_ids")
                .HasColumnType("jsonb")
                .HasConversion(stringSetConverter)
                .Metadata.SetValueComparer(stringSetComparer);
            entity.Property(story => story.ViewEvents)
                .HasColumnName("view_events")
                .HasColumnType("jsonb")
                .HasConversion(JsonListConverter<StoryViewEvent>())
                .Metadata.SetValueComparer(JsonListComparer<StoryViewEvent>());
            entity.Property(story => story.Reactions)
                .HasColumnName("reactions")
                .HasColumnType("jsonb")
                .HasConversion(JsonListConverter<StoryReactionRecord>())
                .Metadata.SetValueComparer(JsonListComparer<StoryReactionRecord>());
            entity.Property(story => story.Comments)
                .HasColumnName("comments")
                .HasColumnType("jsonb")
                .HasConversion(JsonListConverter<StoryCommentRecord>())
                .Metadata.SetValueComparer(JsonListComparer<StoryCommentRecord>());
            entity.HasIndex(story => new { story.Visibility, story.ExpiresAt });
            entity.HasIndex(story => new { story.OwnerUserId, story.CreatedAt });
            entity.HasIndex(story => new { story.TargetType, story.TargetId });
            entity.HasIndex(story => story.DeletedAt);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(story => story.OwnerUserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<FileObject>().WithMany().HasForeignKey(story => story.MediaFileObjectId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<VaultRoom>(entity =>
        {
            entity.ToTable("vault_rooms");
            entity.HasKey(room => room.Id);
            entity.Property(room => room.Id).HasMaxLength(64);
            entity.Property(room => room.OwnerUserId).HasMaxLength(64).IsRequired();
            entity.Property(room => room.Name).HasMaxLength(160).IsRequired();
            entity.Property(room => room.AccessMode).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(room => room.RetentionMode).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.HasIndex(room => new { room.OwnerUserId, room.ClosedAt });
            entity.HasIndex(room => room.ExpiresAt);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(room => room.OwnerUserId).OnDelete(DeleteBehavior.Cascade);

            entity.OwnsOne(room => room.PinHash, owned =>
            {
                owned.Property(hash => hash.Algorithm).HasColumnName("pin_algorithm").HasMaxLength(64);
                owned.Property(hash => hash.Iterations).HasColumnName("pin_iterations");
                owned.Property(hash => hash.Salt).HasColumnName("pin_salt").HasMaxLength(512);
                owned.Property(hash => hash.Hash).HasColumnName("pin_hash").HasMaxLength(512);
            });
        });

        modelBuilder.Entity<VaultRoomMember>(entity =>
        {
            entity.ToTable("vault_room_members");
            entity.HasKey(member => member.Id);
            entity.Property(member => member.Id).HasMaxLength(160);
            entity.Property(member => member.VaultRoomId).HasMaxLength(64).IsRequired();
            entity.Property(member => member.UserId).HasMaxLength(64).IsRequired();
            entity.Property(member => member.Status).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(member => member.Role).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.HasIndex(member => new { member.VaultRoomId, member.UserId }).IsUnique();
            entity.HasIndex(member => new { member.UserId, member.Status });
            entity.HasOne<VaultRoom>().WithMany().HasForeignKey(member => member.VaultRoomId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(member => member.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<VaultRoomInvite>(entity =>
        {
            entity.ToTable("vault_room_invites");
            entity.HasKey(invite => invite.Id);
            entity.Property(invite => invite.Id).HasMaxLength(64);
            entity.Property(invite => invite.VaultRoomId).HasMaxLength(64).IsRequired();
            entity.Property(invite => invite.CreatedByUserId).HasMaxLength(64).IsRequired();
            entity.Property(invite => invite.CodeHash).HasMaxLength(64).IsRequired();
            entity.Property(invite => invite.MaxUses).HasDefaultValue(1);
            entity.Property(invite => invite.Uses).HasDefaultValue(0);
            entity.HasIndex(invite => invite.CodeHash).IsUnique();
            entity.HasIndex(invite => new { invite.VaultRoomId, invite.ExpiresAt });
            entity.HasOne<VaultRoom>().WithMany().HasForeignKey(invite => invite.VaultRoomId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(invite => invite.CreatedByUserId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<CallSession>(entity =>
        {
            entity.ToTable("calls");
            entity.HasKey(call => call.Id);
            entity.Property(call => call.Id).HasMaxLength(64);
            entity.Property(call => call.ConversationId).HasMaxLength(64);
            entity.Property(call => call.InitiatorUserId).HasMaxLength(64).IsRequired();
            entity.Property(call => call.Type).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(call => call.Status).HasConversion<string>().HasMaxLength(32).IsRequired();
            entity.Property(call => call.ParticipantUserIds)
                .HasColumnName("participant_user_ids")
                .HasColumnType("jsonb")
                .HasConversion(stringSetConverter)
                .Metadata.SetValueComparer(stringSetComparer);
            entity.HasIndex(call => new { call.InitiatorUserId, call.StartedAt });
            entity.HasIndex(call => call.ConversationId);
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(call => call.InitiatorUserId).OnDelete(DeleteBehavior.Restrict);
            entity.HasOne<ConversationRecord>().WithMany().HasForeignKey(call => call.ConversationId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<PushTokenRecord>(entity =>
        {
            entity.ToTable("push_tokens");
            entity.HasKey(push => push.Id);
            entity.Property(push => push.Id).HasMaxLength(64);
            entity.Property(push => push.UserId).HasMaxLength(64).IsRequired();
            entity.Property(push => push.DeviceId).HasMaxLength(64).IsRequired();
            entity.Property(push => push.Provider).HasMaxLength(32).IsRequired();
            entity.Property(push => push.TokenHash).HasMaxLength(128).IsRequired();
            entity.Property(push => push.TokenCiphertext);
            entity.HasIndex(push => new { push.UserId, push.DeviceId, push.RevokedAt });
            entity.HasIndex(push => push.TokenHash).IsUnique();
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(push => push.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne<DeviceRecord>().WithMany().HasForeignKey(push => push.DeviceId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<AdCampaign>(entity =>
        {
            entity.ToTable("ad_campaigns");
            entity.HasKey(ad => ad.Id);
            entity.Property(ad => ad.Id).HasMaxLength(64);
            entity.Property(ad => ad.Title).HasMaxLength(160).IsRequired();
            entity.Property(ad => ad.Body).HasMaxLength(500).IsRequired();
            entity.Property(ad => ad.Placement).HasMaxLength(64).IsRequired();
            entity.Property(ad => ad.Locale).HasMaxLength(16);
            entity.Property(ad => ad.Region).HasMaxLength(16);
            entity.Property(ad => ad.ClickUrl).HasMaxLength(1024).IsRequired();
            entity.HasIndex(ad => new { ad.IsActive, ad.StartsAt, ad.EndsAt });
            entity.HasData(new AdCampaign
            {
                Id = "ad_nivra_launch",
                Title = "Nivra Premium",
                Body = "Mas boveda cifrada y mas dispositivos cuando quieras crecer.",
                Placement = "vault_home",
                Locale = "es",
                Region = null,
                ClickUrl = "https://nivra.app/premium",
                StartsAt = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero),
                EndsAt = new DateTimeOffset(2036, 1, 1, 0, 0, 0, TimeSpan.Zero),
                IsActive = true
            });
        });

        modelBuilder.Entity<AdImpressionAggregate>(entity =>
        {
            entity.ToTable("ad_impressions");
            entity.HasKey(impression => impression.Id);
            entity.Property(impression => impression.Id).HasMaxLength(160);
            entity.Property(impression => impression.CampaignId).HasMaxLength(64).IsRequired();
            entity.Property(impression => impression.Placement).HasMaxLength(64).IsRequired();
            entity.HasIndex(impression => new { impression.CampaignId, impression.Placement, impression.Day }).IsUnique();
            entity.HasOne<AdCampaign>().WithMany().HasForeignKey(impression => impression.CampaignId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<SecurityAuditEvent>(entity =>
        {
            entity.ToTable("security_audit_events");
            entity.HasKey(audit => audit.Id);
            entity.Property(audit => audit.Id).HasMaxLength(64);
            entity.Property(audit => audit.UserId).HasMaxLength(64);
            entity.Property(audit => audit.Action).HasMaxLength(160).IsRequired();
            entity.Property(audit => audit.IpAddress).HasMaxLength(96);
            entity.HasIndex(audit => new { audit.UserId, audit.CreatedAt });
            entity.HasOne<UserAccount>().WithMany().HasForeignKey(audit => audit.UserId).OnDelete(DeleteBehavior.SetNull);
        });
    }

    private static void MapPrivacySettings<T>(Microsoft.EntityFrameworkCore.Metadata.Builders.OwnedNavigationBuilder<T, PrivacySettings> owned, string prefix)
        where T : class
    {
        owned.Property(settings => settings.HideNotificationContent).HasColumnName($"{prefix}hide_notification_content");
        owned.Property(settings => settings.AllowForwarding).HasColumnName($"{prefix}allow_forwarding");
        owned.Property(settings => settings.AllowScreenshots).HasColumnName($"{prefix}allow_screenshots");
        owned.Property(settings => settings.ReadReceipts).HasColumnName($"{prefix}read_receipts");
        owned.Property(settings => settings.DefaultMessageTtlSeconds).HasColumnName($"{prefix}default_message_ttl_seconds");
        owned.Property(settings => settings.PrivacyPreset).HasColumnName($"{prefix}preset").HasMaxLength(32).IsRequired();
    }
}
