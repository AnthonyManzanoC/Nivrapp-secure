export function normalizeNivraNumber(identifier: string | null | undefined): string | null {
  const value = String(identifier || '').trim();
  if (value.startsWith('@')) { return null; }
  const digits = value.replace(/[\s-]/g, '');
  return /^[1-9][0-9]{8}$/.test(digits) ? digits : null;
}

export function formatNivraNumber(identifier: string | null | undefined): string {
  return (normalizeNivraNumber(identifier) || '').replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

export function isLoginIdentifier(value: string): boolean {
  return !!normalizeNivraNumber(value) || /^@?[a-zA-Z0-9_.-]{3,32}$/.test(value.trim());
}
