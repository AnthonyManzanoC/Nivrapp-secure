import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service';

describe('hybrid login preserves device key identity', () => {
  let service: AuthService;
  let post: jasmine.Spy;
  let prepareKeys: jasmine.Spy;
  const keys = { keyBundle: { identityKey: 'test-public-key' } };
  const session = { user: { alias: 'old.alias' }, device: { id: 'device' }, tokens: {} };

  beforeEach(() => {
    post = jasmine.createSpy('post');
    prepareKeys = jasmine.createSpy('prepareKeys').and.resolveTo(keys);
    service = Object.assign(Object.create(AuthService.prototype), {
      api: { post }, busy: signal(false),
      crypto: { prepareDeviceKeys: prepareKeys, createDeviceKeys: jasmine.createSpy().and.resolveTo(keys) },
      deviceProfile: () => Promise.resolve({ hardwareId: 'test-device', name: 'Test browser' }),
      completeAuth: jasmine.createSpy('completeAuth').and.resolveTo(),
    });
  });

  it('resolves an ID with credentials before loading the existing alias keys', async () => {
    post.and.returnValues(of({ alias: 'old.alias' }), of(session));
    await service.loginWithAlias('123 456 789', 'synthetic-test-password', 'login');
    expect(post.calls.first().args[1].resolveOnly).toBeTrue();
    expect(post.calls.first().args[1].alias).toBe('123456789');
    expect(prepareKeys).toHaveBeenCalledOnceWith('old.alias', false);
    expect(post.calls.mostRecent().args[1].alias).toBe('@old.alias');
    expect(post.calls.mostRecent().args[1].keyBundle).toBe(keys.keyBundle);
    expect(service.busy()).toBeFalse();
  });

  it('keeps explicit numeric aliases unambiguous without resolving them as IDs', async () => {
    post.and.returnValue(of(session));
    await service.loginWithAlias('@123456789', 'synthetic-test-password', 'login');
    expect(prepareKeys).toHaveBeenCalledOnceWith('123456789', false);
    expect(post.calls.count()).toBe(1);
    expect(post.calls.first().args[1].alias).toBe('@123456789');
  });

  it('does not generate or replace device keys after rejected ID credentials', async () => {
    post.and.returnValue(throwError(() => ({ status: 401 })));
    await expectAsync(service.loginWithAlias('123456789', 'synthetic-invalid-password', 'login')).toBeRejected();
    expect(prepareKeys).not.toHaveBeenCalled();
    expect(service.busy()).toBeFalse();
  });

  it('creates a private account without a supplied alias, phone or email and rejects a short PIN', async () => {
    post.and.returnValue(of(session));
    await expectAsync(service.createPrivateAccount('1234')).toBeRejected();
    expect(post).not.toHaveBeenCalled();
    await service.createPrivateAccount('synthetic-test-password');
    expect(post.calls.first().args[0]).toBe('/auth/register-private');
    const payload = post.calls.first().args[1];
    expect(payload.alias).toBeUndefined();
    expect(payload.phone).toBeUndefined();
    expect(payload.email).toBeUndefined();
  });
});
