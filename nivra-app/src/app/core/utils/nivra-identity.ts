import { formatNivraNumber } from './nivra-number';

interface IdentityProfile {
  alias?: string | null;
  displayName?: string | null;
  nivraNumber?: string | null;
  phone?: string | null;
  isPrivateAccount?: boolean;
}

// Only the old private-registration format is inferred on older API versions.
// Hiding a normal profile from discovery does not turn it into an ID account.
export function isLegacyPrivateAlias(alias: string | null | undefined): boolean {
  return /^n_[a-f0-9]{24}$/i.test(alias?.trim() ?? '');
}

export function isNivraIdAccount(profile: IdentityProfile | null | undefined): boolean {
  return profile?.isPrivateAccount ?? (!profile?.phone && isLegacyPrivateAlias(profile?.alias));
}

export function identityDisplayName(profile: IdentityProfile | null | undefined, fallback = ''): string {
  const name = profile?.displayName?.trim();
  if (name && !isLegacyPrivateAlias(name)) return name;
  if (isNivraIdAccount(profile) && isLegacyPrivateAlias(profile?.alias)) {
    const number = formatNivraNumber(profile?.nivraNumber);
    return number ? `Nivra ${number}` : 'Nivra ID';
  }
  return profile?.phone?.trim() || profile?.alias?.trim() || fallback;
}

const aliasPlaces = ['luna', 'bruma', 'nube', 'eco', 'aura', 'orbe', 'noche', 'bosque', 'cielo', 'mar'];
const aliasMoods = ['azul', 'lunar', 'libre', 'polar', 'dorado', 'secreto', 'sereno', 'suave', 'claro', 'oculto'];

// This is a draft suggestion, never a password or an automatically saved alias.
// The regular server availability check still owns uniqueness.
export function suggestNivraAlias(): string {
  const values = crypto.getRandomValues(new Uint32Array(3));
  return `${aliasPlaces[values[0] % aliasPlaces.length]}.${aliasMoods[values[1] % aliasMoods.length]}${10 + values[2] % 90}`;
}
