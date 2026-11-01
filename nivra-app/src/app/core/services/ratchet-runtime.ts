/** Runtime boundary shared by browser, Capacitor WebView and Electron. */
import { environment } from '../../../environments/environment';
import type { MessageResponse } from '../models/nivra.models';
export const ratchetArchiveContext = (message: Pick<MessageResponse, 'id' | 'clientMessageId' | 'conversationId' | 'senderUserId' | 'senderDeviceId' | 'serverReceivedAt'>): string =>
  JSON.stringify([message.id, message.clientMessageId, message.conversationId, message.senderUserId, message.senderDeviceId, message.serverReceivedAt]);
export interface RatchetAddress { name: string; device: number; }
export interface RatchetContext { conversationId: string; messageId: string; }
export interface RatchetBundle {
  v: number; suite: string; registrationId: number; deviceId: number; identityKey: string; preKeyId: number;
  [key: string]: unknown;
}
export interface RatchetEnvelope {
  v: number; suite: string; context: RatchetContext & { sender: string; recipient: string };
  type: number; keyMessage: string; iv: string; ciphertext: string;
}
export interface RatchetIncoming {
  id: string; peer: RatchetAddress; context: RatchetEnvelope['context']; envelopeHash: string; payload: unknown;
}
export interface RatchetStorage {
  read(scope: string): Promise<{ revision: number; state: unknown } | null>;
  commit(scope: string, revision: number, state: unknown): Promise<number>;
}
export interface RatchetDeviceRuntime {
  readonly publicIdentity: Uint8Array;
  bundle(): Promise<RatchetBundle>;
  pendingBundles(): Promise<RatchetBundle[]>;
  acknowledgeBundles(ids: number[]): Promise<void>;
  pendingConsumedPreKeys(): Promise<number[]>;
  acknowledgeConsumedPreKeys(ids: number[]): Promise<void>;
  hasSession(peer: RatchetAddress): Promise<boolean>;
  pinIdentity(peer: RatchetAddress, publicKey: Uint8Array, state?: unknown): Promise<void>;
  establish(peer: RatchetAddress, bundle: RatchetBundle): Promise<void>;
  encrypt(peer: RatchetAddress, context: RatchetContext, payload: unknown): Promise<RatchetEnvelope>;
  encryptMany(requests: Array<{ peer: RatchetAddress; context: RatchetContext; payload: unknown }>): Promise<RatchetEnvelope[]>;
  decrypt(peer: RatchetAddress, context: RatchetContext, envelope: RatchetEnvelope): Promise<unknown>;
  applicationState(): Promise<unknown>;
  updateApplicationState(state: unknown): Promise<void>;
  pendingReceived(): Promise<RatchetIncoming[]>;
  acknowledgeReceived(id: string): Promise<void>;
  releaseOutgoing(conversationId: string, messageId: string): Promise<void>;
  close(): Promise<void>;
}
export type RatchetRuntimeFactory = (name: string, storage: RatchetStorage, create: boolean) => Promise<RatchetDeviceRuntime>;

let loaded: Promise<{ bridge: unknown; Device: { open: (...args: unknown[]) => Promise<RatchetDeviceRuntime> } }> | undefined;
export const openRatchetRuntime: RatchetRuntimeFactory = async (name, storage, create) => {
  if (!environment.ratchetEnabled) throw Error('El cifrado avanzado no está disponible en esta compilación.');
  loaded ??= (async () => {
    const root = location.protocol === 'file:' ? new URL('nivra-crypto://app/') : new URL('assets/ratchet/', document.baseURI);
    const bridge = await import(/* webpackIgnore: true */ new URL('pkg/nivra_ratchet_olm.js', root).href);
    await bridge.default({ module_or_path: new URL('pkg/nivra_ratchet_olm_bg.wasm', root) });
    if (bridge.protocolSuite() !== 'NIVRA-PQXDH-MLKEM768-A256GCM-1' || bridge.bridgeVersion() !== 'NIVRA-HYBRID-WASM-1') throw Error('La versión del motor cifrado no coincide. Actualiza Nivra antes de continuar.');
    const wrapper = await import(/* webpackIgnore: true */ new URL('web-device.mjs', root).href);
    return { bridge, Device: wrapper.LabWebDevice };
  })().catch(error => { loaded = undefined; throw error; });
  const runtime = await loaded;
  return runtime.Device.open(runtime.bridge, name, 1, storage, { createIfMissing: create });
};

export const ratchetBase64 = (bytes: Uint8Array): string => {
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
};
export function ratchetBinary(value: string, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) throw Error('Paquete cifrado inválido.');
  const result = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (result.length > maximum || ratchetBase64(result) !== value) throw Error('Paquete cifrado inválido.');
  return result;
}
export const ratchetHash = async (value: unknown): Promise<string> => ratchetBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))));
export const ratchetMessageId = async (value: string): Promise<string> => ratchetBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
