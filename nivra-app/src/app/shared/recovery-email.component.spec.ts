import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { RecoveryEmailComponent } from './recovery-email.component';
import { NivraApiService } from '../core/services/nivra-api.service';

describe('recovery email refresh', () => {
  let component: RecoveryEmailComponent;
  let api: { get: jasmine.Spy };
  beforeEach(() => {
    api = { get: jasmine.createSpy().and.returnValue(of({ email: null, verified: false })) };
    TestBed.configureTestingModule({ providers: [{ provide: NivraApiService, useValue: api }] });
    component = TestBed.runInInjectionContext(() => new RecoveryEmailComponent());
  });
  afterEach(() => component.ngOnDestroy());
  it('recognizes a confirmation completed in another browser on return', async () => {
    await component.ngOnInit();
    component.editing = true; component.password = 'temporary';
    api.get.and.returnValue(of({ email: 'verified@example.test', verified: true }));
    const changed = spyOn(component.stateChange, 'emit');
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(component.verifiedEmail).toBe('verified@example.test');
    expect(component.editing).toBeFalse();
    expect(component.password).toBe('');
    expect(changed).toHaveBeenCalledWith({ email: 'verified@example.test', verified: true });
  });
  it('preserves confirmed status while offline', async () => {
    component.verifiedEmail = 'verified@example.test';
    api.get.and.returnValue(throwError(() => new Error('offline')));
    await component.refresh();
    expect(component.verifiedEmail).toBe('verified@example.test');
  });
  it('does not fetch after destruction', async () => {
    component.ngOnDestroy(); await component.refresh();
    expect(api.get).not.toHaveBeenCalled();
  });
});
