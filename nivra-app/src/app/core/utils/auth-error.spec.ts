import { authErrorMessage } from './auth-error';

describe('authentication error feedback', () => {
  it('distinguishes credentials, occupied aliases and expired QR codes', () => {
    expect(authErrorMessage({ status: 401, error: { code: 'invalid_login' } }, 'alias-login').key).toBe('LOGIN.ERROR_CREDENTIALS');
    expect(authErrorMessage({ status: 409, error: { code: 'alias_taken' } }, 'alias-register').key).toBe('LOGIN.ERROR_ALIAS_TAKEN');
    expect(authErrorMessage({ status: 410, error: { code: 'invalid_qr' } }, 'qr').key).toBe('LOGIN.ERROR_QR_EXPIRED');
  });

  it('does not infer that an account is missing from a failed login', () => {
    expect(authErrorMessage({ status: 401 }, 'alias-login').key).toBe('LOGIN.ERROR_CREDENTIALS');
    expect(authErrorMessage({ status: 404 }, 'alias-login').key).toBe('LOGIN.ERROR_ACTION');
  });

  it('separates connectivity, throttling and server failures without displaying diagnostics', () => {
    expect(authErrorMessage({ status: 0 }, 'alias-login').key).toBe('LOGIN.ERROR_NETWORK');
    expect(authErrorMessage({ status: 429 }, 'alias-login').key).toBe('LOGIN.ERROR_RATE_LIMIT');
    const response = authErrorMessage({ status: 500, error: '<html>database secret</html>' }, 'alias-register');
    expect(response.key).toBe('LOGIN.ERROR_SERVICE');
    expect(response.fallback).not.toContain('secret');
  });

  it('preserves actionable local validation and handles absent errors', () => {
    expect(authErrorMessage(new Error('Ingresa tu contraseña.'), 'alias-login').fallback).toBe('Ingresa tu contraseña.');
    expect(authErrorMessage(null, 'alias-login').key).toBe('LOGIN.ERROR_ACTION');
  });
});
