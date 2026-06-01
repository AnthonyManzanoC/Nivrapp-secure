export interface KeyBundle {
  identityKey: string | null;
  signedPreKey: string | null;
  preKeySignature: string | null;
  oneTimePreKeys: string[];
}

export interface DeviceKeys {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  keyBundle: KeyBundle;
}

export interface StoredDeviceKeys extends DeviceKeys {
  id: string;
  alias: string;
  aliasLower: string;
  deviceId: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
}

export interface NivraUser {
  id: string;
  alias: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  bio?: string | null;
  profilePhotoDataUrl?: string | null;
  isDiscoverable: boolean;
  planCode: string;
  privacySettings: PrivacySettings;
  createdAt: string;
}

export interface NivraDevice {
  id: string;
  userId: string;
  name: string;
  isTrusted: boolean;
  createdAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
}

export interface AuthSession {
  user: NivraUser;
  device: NivraDevice;
  tokens: TokenPair;
}

export interface PhoneAliasChallenge {
  token: string;
  expiresAt?: string | null;
  phone?: string | null;
  keys: DeviceKeys;
}

export interface Participant {
  userId: string;
  role: string;
  canInvite: boolean;
  canChangePrivacy: boolean;
  joinedAt: string;
  removedAt?: string | null;
}

export interface PrivacySettings {
  hideNotificationContent?: boolean;
  allowForwarding?: boolean;
  allowScreenshots?: boolean;
  readReceipts?: boolean;
  defaultMessageTtlSeconds?: number | null;
  privacyPreset?: string | null;
}

export interface Conversation {
  id: string;
  type: 'Direct' | 'Group' | string;
  titleCiphertext?: string | null;
  privacySettings: PrivacySettings;
  participants: Participant[];
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string | null;
}

export interface Contact {
  userId: string;
  alias: string;
  displayName?: string | null;
  profilePhotoDataUrl?: string | null;
  nicknameCiphertext?: string | null;
  isFavorite: boolean;
  createdAt: string;
}

export interface UserSummary {
  id: string;
  alias: string;
  displayName?: string | null;
  bio?: string | null;
  profilePhotoDataUrl?: string | null;
  isDiscoverable: boolean;
  isContact: boolean;
  isMutualContact: boolean;
  isFavorite: boolean;
  friendshipState: string;
}

export interface DirectorySearchResponse {
  query: string;
  people: UserSummary[];
}

export interface PublicDeviceKey {
  deviceId: string;
  deviceName: string;
  keyBundle: KeyBundle;
  lastRotatedAt: string;
}

export interface PublicKeyDirectory {
  userId: string;
  alias: string;
  devices: PublicDeviceKey[];
}

export interface RecipientCipherRequest {
  userId: string;
  deviceId: string;
  ciphertext: string;
  header?: string | null;
  fileObjectId?: string | null;
}

export interface MessageResponse {
  id: string;
  conversationId: string;
  clientMessageId: string;
  senderUserId: string;
  senderDeviceId: string;
  kind: 'Text' | 'File' | 'System' | string;
  recipients: RecipientCipherRequest[];
  encryptedPolicy?: string | null;
  serverReceivedAt: string;
  expiresAt?: string | null;
  deleteAfterRead: boolean;
  receipts: DeliveryReceipt[];
}

export interface DeliveryReceipt {
  userId: string;
  deviceId: string;
  deliveredAt?: string | null;
  readAt?: string | null;
  deletedAt?: string | null;
}

export interface ChatPayload {
  type: 'text' | 'file' | 'reaction' | 'system' | 'call-log' | string;
  text?: string;
  emoji?: string;
  title?: string;
  event?: string;
  at?: string;
  callType?: string;
  forwardedFrom?: unknown;
  replyTo?: unknown;
  forwardingAllowed?: boolean;
  reactions?: MessageReaction[];
  [key: string]: unknown;
}

export interface FileChatPayload extends ChatPayload {
  type: 'file' | string;
  fileId?: string;
  downloadFile?: string;
  previewFile?: string;
  fileName?: string;
  fileMime?: string;
  mime?: string;
  size?: number;
  fileKey?: string;
  fileIv?: string;
  voiceNote?: boolean;
}

export interface MediaPreview {
  fileId: string;
  url: string;
  mime: string;
  name: string;
  createdAt: number;
}

export interface MessageReaction {
  emoji: string;
  userId: string;
  deviceId?: string;
  alias?: string;
  displayName?: string;
  profilePhotoDataUrl?: string;
  at?: string;
  reactionId?: string;
}

export interface ChatMessageVm {
  id: string;
  conversationId: string;
  mine: boolean;
  senderUserId: string;
  senderDeviceId?: string;
  at: string;
  status?: string;
  payload: ChatPayload;
  receipts?: DeliveryReceipt[];
  expiresAt?: string | null;
  deleteAfterRead?: boolean;
  decryptError?: boolean;
}

export interface SyncBootstrapResponse {
  user: NivraUser;
  devices: NivraDevice[];
  contacts: Contact[];
  conversations: Conversation[];
  messages: MessageResponse[];
  deletedMessages: unknown[];
  vaultItems: unknown[];
  friendRequests: unknown[];
  stories: unknown[];
  vaultRooms: unknown[];
  privacySettings: PrivacySettings;
}

export interface MessageSyncResponse {
  messages: MessageResponse[];
  syncedAt: string;
}

export interface PatchProfileRequest {
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  bio?: string | null;
  profilePhotoDataUrl?: string | null;
  isDiscoverable?: boolean | null;
}

export interface FriendRequest {
  id: string;
  from: UserSummary;
  to: UserSummary;
  status: 'Pending' | 'Accepted' | 'Rejected' | 'Cancelled' | string;
  message?: string | null;
  createdAt: string;
  updatedAt: string;
  respondedAt?: string | null;
}

export interface Story {
  id: string;
  owner: UserSummary;
  visibility: 'PublicWorld' | 'Contacts' | 'MutualContacts' | 'CloseFriends' | 'SelectedUsers' | string;
  encryptedPayload: string;
  caption?: string | null;
  mediaFileObjectId?: string | null;
  allowedUserIds: string[];
  viewOnce: boolean;
  viewedByMe: boolean;
  viewCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface StoryMediaPayload {
  fileId: string;
  fileName: string;
  mime: string;
  size: number;
  fileKey: string;
  fileIv: string;
}

export interface StoryPayload {
  v?: number;
  type: 'text' | 'media' | string;
  text?: string;
  media?: StoryMediaPayload | null;
}

export interface StoryMediaPreview {
  storyId: string;
  url: string;
  mime: string;
  name: string;
}

export interface VaultItem {
  id: string;
  parentId?: string | null;
  fileObjectId?: string | null;
  kind: 'Folder' | 'File' | 'Note' | string;
  encryptedMetadata: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecodedVaultItem extends VaultItem {
  decoded?: {
    title?: string;
    body?: string;
    name?: string;
    [key: string]: unknown;
  };
  decodeError?: boolean;
}

export interface VaultRoomMember {
  userId: string;
  alias: string;
  displayName?: string | null;
  profilePhotoDataUrl?: string | null;
  role: string;
  status: string;
  createdAt: string;
  joinedAt?: string | null;
  lastSeenAt?: string | null;
  leftAt?: string | null;
}

export interface VaultRoom {
  id: string;
  owner: UserSummary;
  name: string;
  accessMode: 'PinOnly' | 'InviteOnly' | 'WaitingRoom' | string;
  retentionMode: 'Persistent' | 'BurnOnExit' | 'ExpiresAfterTtl' | string;
  encryptedWelcome?: string | null;
  members: VaultRoomMember[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  closedAt?: string | null;
}

export interface VaultRealtimeMessageResponse {
  id: string;
  vaultRoomId: string;
  clientMessageId: string;
  senderUserId: string;
  senderDeviceId: string;
  kind: 'Text' | 'Image' | 'Video' | 'Audio' | 'Document' | 'System' | string;
  recipients: RecipientCipherRequest[];
  fileObjectId?: string | null;
  sentAt: string;
}

export interface VaultRoomMessageVm {
  id: string;
  vaultRoomId: string;
  mine: boolean;
  senderUserId: string;
  senderDeviceId?: string;
  senderAlias?: string | null;
  at: string;
  kind: string;
  payload: ChatPayload;
  fileObjectId?: string | null;
  decryptError?: boolean;
}

export interface CallSession {
  id: string;
  conversationId?: string | null;
  initiatorUserId: string;
  type: 'Voice' | 'Video' | string;
  status: 'Ringing' | 'Active' | 'Ended' | 'Missed' | 'Failed' | string;
  participantUserIds: string[];
  startedAt: string;
  endedAt?: string | null;
}

export type CallPhase =
  | 'idle'
  | 'ringing'
  | 'calling'
  | 'connecting'
  | 'connected'
  | 'rejected'
  | 'missed'
  | 'ended'
  | 'failed';

export interface CallSignalEvent {
  callId: string;
  fromUserId: string;
  fromDeviceId?: string | null;
  signalType: string;
  payloadCiphertext?: string | null;
}

export interface Entitlements {
  planCode: string;
  vaultStorageBytes: number;
  maxLinkedDevices: number;
  maxGroupParticipants: number;
  adsEnabled: boolean;
  encryptedBackupsEnabled: boolean;
  professionalSpacesEnabled: boolean;
}

export interface PushTokenResponse {
  id: string;
  provider: string;
  createdAt: string;
  revokedAt?: string | null;
  serverReady: boolean;
}

export interface PushStatusResponse {
  serverReady: boolean;
  provider: string;
}

export interface PresenceResponse {
  userId: string;
  online: boolean;
  lastSeenAt?: string | null;
}

export interface FileResponse {
  id: string;
  ownerUserId: string;
  encryptedSize: number;
  mimeTypeCiphertext?: string | null;
  clientSha256?: string | null;
  state: 'Reserved' | 'Uploaded' | 'Deleted' | string;
  allowedUserIds: string[];
  createdAt: string;
  uploadedAt?: string | null;
  expiresAt?: string | null;
  uploadUrl: string;
  downloadUrl: string;
}

export interface QrLoginStartResponse {
  qrId: string;
  code: string;
  syncToken: string;
  deepLink: string;
  expiresAt: string;
}

export interface QrLoginAuthorizedResponse {
  auth: AuthSession;
  encryptedPayload: string;
}

export interface QrLoginStatusResponse {
  status: 'pending' | 'authorized' | string;
  auth?: AuthSession | null;
  encryptedPayload?: string | null;
}

export type RealtimeEvent =
  | { type: 'message.received'; payload: MessageResponse }
  | { type: 'message.receipt'; payload: unknown }
  | { type: 'conversation.created'; payload: Conversation }
  | { type: 'conversation.typing'; payload: unknown }
  | { type: 'presence.changed'; payload: unknown }
  | { type: 'call.started' | 'incomingCall' | 'call.signal' | 'call.ended'; payload: unknown }
  | { type: string; payload: unknown };
