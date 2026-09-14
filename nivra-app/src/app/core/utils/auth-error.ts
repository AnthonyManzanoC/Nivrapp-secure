export type AuthAction = 'alias-login' | 'alias-register' | 'phone' | 'qr';

export interface AuthErrorMessage {
  key: string;
  fallback: string;
}

const messages: Record<string, AuthErrorMessage> = {
  invalid_login: { key: 'LOGIN.ERROR_CREDENTIALS', fallback: 'Alias o contraseña incorrectos. Revisa ambos e inténtalo de nuevo.' },
  alias_not_found: { key: 'LOGIN.ERROR_ALIAS_NOT_FOUND', fallback: 'No encontramos ese alias. Revisa cómo lo escribiste o crea una cuenta.' },
  alias_taken: { key: 'LOGIN.ERROR_ALIAS_TAKEN', fallback: 'Ese alias ya está en uso. Elige otro o entra con tu cuenta.' },
  invalid_alias: { key: 'LOGIN.ALIAS_ERROR', fallback: 'El alias debe tener de 3 a 32 caracteres: letras, números, punto, guion o guion bajo.' },
  weak_password: { key: 'LOGIN.ERROR_PASSWORD_SHORT', fallback: 'Usa una contraseña de al menos 10 caracteres.' },
  invalid_password: { key: 'LOGIN.ERROR_PASSWORD_SHORT', fallback: 'Usa una contraseña de al menos 10 caracteres.' },
  invalid_qr: { key: 'LOGIN.ERROR_QR_EXPIRED', fallback: 'Este código QR venció o ya se utilizó. Genera uno nuevo para continuar.' },
  invalid_qr_payload: { key: 'LOGIN.ERROR_QR_PAYLOAD', fallback: 'No pudimos validar la vinculación. Genera otro QR y escanéalo desde tu cuenta.' },
  invalid_otp: { key: 'LOGIN.ERROR_OTP', fallback: 'El código no es válido o venció. Revísalo o solicita uno nuevo.' },
  invalid_phone_setup: { key: 'LOGIN.ERROR_PHONE_EXPIRED', fallback: 'La verificación del teléfono venció. Solicita un nuevo código.' },
};

/** Interpret the API contract without exposing transport errors, URLs or server diagnostics. */
export function authErrorMessage(error: unknown, action: AuthAction): AuthErrorMessage {
  const value = error && typeof error === 'object' ? error as { status?: unknown; error?: unknown } : null;
  if (typeof value?.status === 'number') {
    const body = value.error && typeof value.error === 'object' ? value.error as { code?: unknown } : null;
    const code = typeof body?.code === 'string' ? body.code.toLowerCase() : '';
    if (messages[code]) {
      return messages[code];
    }
    if (value.status === 0) {
      return { key: 'LOGIN.ERROR_NETWORK', fallback: 'No pudimos conectar. Revisa tu conexión a internet e inténtalo otra vez.' };
    }
    if (value.status === 429) {
      return { key: 'LOGIN.ERROR_RATE_LIMIT', fallback: 'Has hecho varios intentos seguidos. Espera un momento y vuelve a intentarlo.' };
    }
    if (value.status >= 500) {
      return { key: 'LOGIN.ERROR_SERVICE', fallback: 'El servicio no está disponible en este momento. Inténtalo de nuevo en unos minutos.' };
    }
    if (action === 'qr' && (value.status === 404 || value.status === 410)) {
      return messages['invalid_qr'];
    }
    if (action === 'alias-login' && value.status === 401) {
      return messages['invalid_login'];
    }
    if (action === 'alias-register' && value.status === 409) {
      return messages['alias_taken'];
    }
    if (value.status === 400 || value.status === 422) {
      return { key: 'LOGIN.ERROR_FIELDS', fallback: 'Revisa los datos ingresados y completa los campos indicados.' };
    }
    return { key: 'LOGIN.ERROR_ACTION', fallback: 'No pudimos completar el acceso. Inténtalo de nuevo.' };
  }
  if (error instanceof Error) {
    return { key: '', fallback: error.message };
  }
  return { key: 'LOGIN.ERROR_ACTION', fallback: 'No pudimos completar el acceso. Inténtalo de nuevo.' };
}
