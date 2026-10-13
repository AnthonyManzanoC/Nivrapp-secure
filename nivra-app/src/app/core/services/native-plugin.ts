import { registerPlugin } from '@capacitor/core';
import type { NivraNativePlugin } from './native-device.service';
import type { NivraNativeSecurePlugin } from './native-secure-vault.service';

// Both services use the same native plugin. Type-only imports keep this module
// independent of Angular services when the bridge is registered at startup.
export const NivraNative = registerPlugin<NivraNativePlugin & NivraNativeSecurePlugin>('NivraNative');
