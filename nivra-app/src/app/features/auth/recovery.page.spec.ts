import { TestBed } from '@angular/core/testing';
import { Location } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { RecoveryPage } from './recovery.page';

describe('account recovery form', () => {
  let api: { post: jasmine.Spy };
  const token = 'a'.repeat(43);
  function page(fragment: string | null) {
    api = { post: jasmine.createSpy().and.returnValue(of({ message: 'Actualizado' })) };
    TestBed.configureTestingModule({ providers: [
      { provide: NivraApiService, useValue: api },
      { provide: ActivatedRoute, useValue: { snapshot: { fragment } } },
      { provide: Location, useValue: { replaceState: jasmine.createSpy() } },
    ] });
    return TestBed.runInInjectionContext(() => new RecoveryPage());
  }
  it('does not consume emailed tokens on page load and removes the URL fragment', () => {
    const form = page('token=' + token + '&purpose=verify-email');
    expect(form.token).toBe(token); expect(api.post).not.toHaveBeenCalled();
    expect(TestBed.inject(Location).replaceState).toHaveBeenCalledWith('/recover');
  });
  it('requires matching strong passwords before consuming a reset token', async () => {
    const form = page('token=' + token);
    form.password = 'ten-characters'; form.confirmation = 'different';
    await form.submit(); expect(api.post).not.toHaveBeenCalled(); expect(form.error).toContain('coincidan');
  });
  it('clears sensitive form values after successful password reset', async () => {
    const form = page('token=' + token); form.password = form.confirmation = 'strong-test-password';
    await form.submit();
    expect(api.post).toHaveBeenCalledWith('/auth/recovery/complete', { token, newPassword: 'strong-test-password' }, { skipAuth: true });
    expect(form.completed).toBeTrue(); expect(form.token + form.password + form.confirmation).toBe('');
  });
  it('displays expired-link errors without claiming a password changed', async () => {
    const form = page('token=' + token + '&purpose=verify-email');
    api.post.and.returnValue(throwError(() => ({ error: { message: 'Enlace vencido' } })));
    await form.submit(); expect(form.error).toBe('Enlace vencido'); expect(form.completed).toBeFalse();
  });
});
