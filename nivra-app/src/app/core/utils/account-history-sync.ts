import { AccountIdentitySecret, identityB64, identityBinary, identityBytes, signAccountIdentity, verifyAccountIdentity } from './account-identity';
import { ChatMessageVm, ChatPayload } from '../models/nivra.models';

/** An immutable message archive. The account root protects this independently of device ratchets. */
export interface AccountHistoryEnvelope {
  v: 1; rootKey: string; messageId: string; clientMessageId: string; conversationId: string;
  senderUserId: string; senderDeviceId: string; at: string; iv: string; ciphertext: string; signature: string;
}
export interface HistoryRootApproval {
  rootKey:string;sourceHybrid:string;targetHybrid:string;signature:string;
}
export interface HistoryRootApprovalContext {
  requestId:string;userId:string;sourceDeviceId:string;targetDeviceId:string;sourceLegacy:string;targetLegacy:string;expiresAt:string;
}
export function historyRootApprovalStatement(context:HistoryRootApprovalContext,approval:HistoryRootApproval):Uint8Array<ArrayBuffer>{
  return identityBytes(['nivra-history-root-approval-v1',context.userId,approval.rootKey,context.requestId,context.sourceDeviceId,context.targetDeviceId,
    context.sourceLegacy,context.targetLegacy,approval.sourceHybrid,approval.targetHybrid,context.expiresAt]);
}
export const ACCOUNT_HISTORY_MAX_BYTES = 1024 * 1024;

/** A local row that cannot be copied, even if the operation is retried. */
export class AccountHistoryUnsupportedMessage extends Error {}

const text = new TextEncoder();
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
export function accountHistoryContext(userId: string, row: AccountHistoryEnvelope): Uint8Array<ArrayBuffer> {
  return identityBytes(['nivra-account-history-v1', userId, row.rootKey, row.messageId, row.clientMessageId,
    row.conversationId, row.senderUserId, row.senderDeviceId, row.at, row.iv]);
}
export function accountHistoryStatement(userId: string, row: AccountHistoryEnvelope): Uint8Array<ArrayBuffer> {
  return identityBytes(['nivra-account-history-signature-v1', userId, row.rootKey, row.messageId, row.clientMessageId,
    row.conversationId, row.senderUserId, row.senderDeviceId, row.at, row.iv, row.ciphertext]);
}
function validate(row: AccountHistoryEnvelope, rootKey: string): void {
  if (!row || row.v !== 1 || row.rootKey !== rootKey || ![row.messageId, row.conversationId, row.senderUserId, row.senderDeviceId].every(value => typeof value === 'string' && identifier.test(value)) || typeof row.clientMessageId!=='string'||!row.clientMessageId.trim()||row.clientMessageId.length>128||
    row.messageId.length > 64 || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at ||
    identityBinary(row.iv, 16).length !== 12 || identityBinary(row.ciphertext, 1400000).length > ACCOUNT_HISTORY_MAX_BYTES + 16) throw Error('Copia de historial inválida.');
}
async function historyKey(secret: AccountIdentitySecret): Promise<CryptoKey> {
  const entropy = identityBinary(secret.recoveryEntropy, 44);
  if (entropy.length !== 32) throw Error('La identidad no contiene la llave de recuperación.');
  try {
    const input = await crypto.subtle.importKey('raw', entropy, 'HKDF', false, ['deriveKey']);
    const salt = await crypto.subtle.digest('SHA-256', identityBytes(['nivra-account-history-salt-v1', secret.userId, secret.rootKey]));
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: text.encode('nivra-HistorySyncKey-v1') }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { entropy.fill(0); }
}
export async function sealAccountHistory(secret: AccountIdentitySecret, message: ChatMessageVm): Promise<AccountHistoryEnvelope> {
  const receivedAt = Date.parse(message.at);
  const clientMessageId = message.clientMessageId ?? message.id;
  if (message.decryptError || message.deleteAfterRead || !message.payload || message.payload.type === 'view-once-opened'
    || message.expiresAt && Date.parse(message.expiresAt) <= Date.now() || !Number.isFinite(receivedAt)
    || ![message.id, message.conversationId, message.senderUserId, message.senderDeviceId].every(value => typeof value === 'string' && identifier.test(value)) || message.id.length > 64
    || typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > 128) {
    throw new AccountHistoryUnsupportedMessage('Este mensaje no puede guardarse en el historial.');
  }
  const row: AccountHistoryEnvelope = { v: 1, rootKey: secret.rootKey, messageId: message.id, clientMessageId,
    conversationId: message.conversationId, senderUserId: message.senderUserId, senderDeviceId: message.senderDeviceId ?? '', at: new Date(receivedAt).toISOString(),
    iv: identityB64(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '', signature: '' };
  const plain = identityBytes(message.payload);
  try {
    if (plain.length > ACCOUNT_HISTORY_MAX_BYTES) throw new AccountHistoryUnsupportedMessage('El mensaje excede el límite de copia.');
    row.ciphertext = identityB64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: identityBinary(row.iv,16), additionalData: accountHistoryContext(secret.userId,row), tagLength: 128 }, await historyKey(secret), plain)));
    validate(row,secret.rootKey);
    row.signature = await signAccountIdentity(secret, accountHistoryStatement(secret.userId,row));
    return row;
  } finally { plain.fill(0); }
}
export async function openAccountHistory(secret: AccountIdentitySecret, row: AccountHistoryEnvelope): Promise<ChatMessageVm> {
  validate(row,secret.rootKey);
  if (!await verifyAccountIdentity(secret.rootKey, accountHistoryStatement(secret.userId,row), row.signature)) throw Error('La firma del historial no es válida.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: identityBinary(row.iv,16), additionalData: accountHistoryContext(secret.userId,row), tagLength: 128 }, await historyKey(secret), identityBinary(row.ciphertext,1400000));
  try {
    const payload = JSON.parse(new TextDecoder().decode(plain)) as ChatPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string' || payload.type === 'view-once-opened') throw Error('Contenido de historial inválido.');
    return { id: row.messageId, clientMessageId: row.clientMessageId, conversationId: row.conversationId, senderUserId: row.senderUserId, senderDeviceId: row.senderDeviceId, at: row.at, payload, mine: row.senderUserId === secret.userId };
  } finally { new Uint8Array(plain).fill(0); }
}
