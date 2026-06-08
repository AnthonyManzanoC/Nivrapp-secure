import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ContactHashSyncResponse } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { NativeDeviceService, type NativeDeviceContact } from './native-device.service';
import { NivraApiService } from './nivra-api.service';

const CONTACT_HASH_CACHE_PREFIX = 'nivra.contactHashes.';
const RADAR_JOINED_HINT_PREFIX = 'nivra.radar.contactJoined.';
const MAX_CONTACT_HASHES = 5000;

@Injectable({ providedIn: 'root' })
export class ContactSyncService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly nativeDevice = inject(NativeDeviceService);

  readonly syncing = signal(false);
  readonly radarHasNewContact = signal(false);
  readonly lastSyncedCount = signal(0);
  readonly lastDeviceContactCount = signal(0);

  async syncCachedContactsInBackground(): Promise<void> {
    if (this.syncing() || !this.auth.isAuthenticated()) {
      return;
    }

    this.restoreRadarHint();
    const deviceSynced = await this.syncDeviceContactsWithoutPrompt().catch(() => 0);
    if (deviceSynced > 0) {
      return;
    }

    const hashes = this.readCachedHashes();
    if (!hashes.length) {
      return;
    }

    await this.syncContactHashes(hashes, { updateCache: false }).catch(() => undefined);
  }

  async syncContactPhones(rawPhones: readonly string[]): Promise<number> {
    const hashes = await this.hashPhones(rawPhones);
    return this.syncContactHashes(hashes, { updateCache: true });
  }

  async pickAndSyncDeviceContacts(): Promise<string[]> {
    if (this.nativeDevice.native) {
      try {
        const phones = this.phoneNumbersFromContacts(await this.nativeDevice.readDeviceContacts({
          requestPermission: true,
          limit: MAX_CONTACT_HASHES,
        }));
        if (!phones.length) {
          throw new Error('No encontre telefonos legibles en tu agenda.');
        }
        this.lastDeviceContactCount.set(phones.length);
        await this.syncContactPhones(phones);
        return this.normalizePhones(phones);
      } catch (error) {
        throw new Error(this.contactAccessErrorMessage(error));
      }
    }

    const phones = await this.pickWebContactPhones();
    if (!phones.length) {
      throw new Error('No encontre telefonos legibles en los contactos seleccionados.');
    }
    this.lastDeviceContactCount.set(phones.length);
    await this.syncContactPhones(phones);
    return this.normalizePhones(phones);
  }

  markContactJoinedHint(): void {
    this.radarHasNewContact.set(true);
    const accountKey = this.accountKey();
    if (!accountKey) {
      return;
    }
    try {
      localStorage.setItem(`${RADAR_JOINED_HINT_PREFIX}${accountKey}`, '1');
    } catch {
      // Local hint only; push delivery already happened.
    }
  }

  clearContactJoinedHint(): void {
    this.radarHasNewContact.set(false);
    const accountKey = this.accountKey();
    if (!accountKey) {
      return;
    }
    try {
      localStorage.removeItem(`${RADAR_JOINED_HINT_PREFIX}${accountKey}`);
    } catch {
      // Best effort only.
    }
  }

  private async syncContactHashes(hashes: readonly string[], options: { updateCache: boolean }): Promise<number> {
    if (!this.auth.isAuthenticated()) {
      return 0;
    }
    if (!await this.auth.ensureFreshSession()) {
      return 0;
    }

    const normalized = this.normalizeHashes(hashes);
    this.syncing.set(true);
    try {
      const response = await firstValueFrom(
        this.api.post<ContactHashSyncResponse>('/push-tokens/sync-contacts', normalized),
      );
      if (options.updateCache) {
        this.cacheHashes(normalized);
      }
      this.lastSyncedCount.set(response.stored ?? normalized.length);
      return response.stored ?? normalized.length;
    } finally {
      this.syncing.set(false);
    }
  }

  private async hashPhones(rawPhones: readonly string[]): Promise<string[]> {
    const phones = this.normalizePhones(rawPhones);
    const hashes = await Promise.all(phones.map((phone) => this.crypto.phoneContactHash(phone)));
    return this.normalizeHashes(hashes);
  }

  private normalizePhones(rawPhones: readonly string[]): string[] {
    return [...new Set(rawPhones.flatMap((phone) => this.normalizePhoneCandidates(phone)))]
      .slice(0, MAX_CONTACT_HASHES);
  }

  private normalizePhoneCandidates(value: string): string[] {
    const trimmed = String(value || '').trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      return [];
    }
    if (hasPlus) {
      return [`+${digits}`];
    }

    const candidates = [digits];
    if (digits.length >= 11) {
      candidates.push(`+${digits}`);
    }
    const localInternational = this.localInternationalCandidate(digits);
    if (localInternational) {
      candidates.push(localInternational);
    }
    return [...new Set(candidates)];
  }

  private localInternationalCandidate(digits: string): string | null {
    const ownPhone = String(this.auth.session()?.user.phone || '').trim();
    if (!ownPhone.startsWith('+')) {
      return null;
    }
    const ownDigits = ownPhone.replace(/\D/g, '');
    const localDigits = digits.replace(/^0+/, '');
    if (ownDigits.length < 8 || localDigits.length < 7 || localDigits.length > 12) {
      return null;
    }
    const countryCodeLength = ownDigits.length - localDigits.length;
    if (countryCodeLength < 1 || countryCodeLength > 3) {
      return null;
    }
    return `+${ownDigits.slice(0, countryCodeLength)}${localDigits}`;
  }

  private async syncDeviceContactsWithoutPrompt(): Promise<number> {
    if (!this.nativeDevice.native) {
      return 0;
    }
    const contacts = await this.nativeDevice.readDeviceContacts({
      requestPermission: false,
      limit: MAX_CONTACT_HASHES,
    });
    const phones = this.phoneNumbersFromContacts(contacts);
    if (!phones.length) {
      return 0;
    }
    this.lastDeviceContactCount.set(phones.length);
    return this.syncContactPhones(phones);
  }

  private phoneNumbersFromContacts(contacts: readonly NativeDeviceContact[]): string[] {
    return contacts
      .flatMap((contact) => contact.tel ?? [])
      .map((phone) => String(phone || '').trim())
      .filter(Boolean)
      .slice(0, MAX_CONTACT_HASHES);
  }

  private async pickWebContactPhones(): Promise<string[]> {
    const contactsApi = this.contactsApi();
    if (!contactsApi?.select) {
      throw new Error('Selector de contactos no disponible aqui.');
    }

    try {
      const contacts = await contactsApi.select(['tel'], { multiple: true });
      return contacts.flatMap((contact) => contact.tel ?? []).filter(Boolean);
    } catch (error) {
      throw new Error(this.contactAccessErrorMessage(error));
    }
  }

  private contactAccessErrorMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error || '');
    if (text.toLowerCase().includes('permiso') || text.toLowerCase().includes('permission')) {
      return 'Permiso de contactos no concedido. Activalo para Nivra en Ajustes del telefono y vuelve a intentar.';
    }
    if (text.toLowerCase().includes('no encontre')) {
      return text;
    }
    return 'No pude abrir tus contactos en este dispositivo. Revisa el permiso de Contactos para Nivra y vuelve a intentar.';
  }

  private normalizeHashes(hashes: readonly string[]): string[] {
    return [...new Set(hashes
      .map((hash) => String(hash || '').trim().toLowerCase())
      .filter((hash) => /^[a-f0-9]{64}$/.test(hash)))]
      .slice(0, MAX_CONTACT_HASHES);
  }

  private cacheHashes(hashes: readonly string[]): void {
    const accountKey = this.accountKey();
    if (!accountKey) {
      return;
    }
    try {
      localStorage.setItem(`${CONTACT_HASH_CACHE_PREFIX}${accountKey}`, JSON.stringify(this.normalizeHashes(hashes)));
    } catch {
      // Local cache only; sync already reached the server.
    }
  }

  private readCachedHashes(): string[] {
    const accountKey = this.accountKey();
    if (!accountKey) {
      return [];
    }
    try {
      const value = JSON.parse(localStorage.getItem(`${CONTACT_HASH_CACHE_PREFIX}${accountKey}`) || '[]') as unknown;
      return Array.isArray(value) ? this.normalizeHashes(value.map(String)) : [];
    } catch {
      return [];
    }
  }

  private restoreRadarHint(): void {
    const accountKey = this.accountKey();
    if (!accountKey) {
      this.radarHasNewContact.set(false);
      return;
    }
    try {
      this.radarHasNewContact.set(localStorage.getItem(`${RADAR_JOINED_HINT_PREFIX}${accountKey}`) === '1');
    } catch {
      this.radarHasNewContact.set(false);
    }
  }

  private contactsApi(): { select?: (properties: string[], options?: { multiple?: boolean }) => Promise<Array<{ tel?: string[] }>> } | null {
    return (navigator as Navigator & {
      contacts?: {
        select?: (properties: string[], options?: { multiple?: boolean }) => Promise<Array<{ tel?: string[] }>>;
      };
    }).contacts ?? null;
  }

  private accountKey(): string | null {
    return this.auth.session()?.user.id ?? null;
  }
}
