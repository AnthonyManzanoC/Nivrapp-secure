import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LauncherAppearanceComponent } from './launcher-appearance.component';
import { LauncherAppearanceService } from '../core/services/launcher-appearance.service';
import { TranslateService } from '../core/services/translate.service';

describe('LauncherAppearanceComponent confirmed account preferences', () => {
  let fixture: ComponentFixture<LauncherAppearanceComponent>;
  let component: LauncherAppearanceComponent;
  let launcher: {
    platform: ReturnType<typeof signal<'android' | 'windows' | 'web' | 'unsupported'>>;
    supported: ReturnType<typeof signal<boolean>>;
    current: ReturnType<typeof signal<'original' | 'emerald' | 'ivory'>>;
    busy: ReturnType<typeof signal<boolean>>;
    error: ReturnType<typeof signal<'unavailable' | 'failed' | 'sync' | 'conflict' | 'not-signed-in' | null>>;
    synced: ReturnType<typeof signal<boolean>>;
    revision: ReturnType<typeof signal<number | null>>;
    accountId: ReturnType<typeof signal<string | null>>;
    refresh: jasmine.Spy;
    selectIcon: jasmine.Spy;
  };

  beforeEach(async () => {
    launcher = {
      platform: signal<'android' | 'windows' | 'web' | 'unsupported'>('android'), supported: signal(true),
      current: signal<'original' | 'emerald' | 'ivory'>('original'), busy: signal(false),
      error: signal<'unavailable' | 'failed' | 'sync' | 'conflict' | 'not-signed-in' | null>(null),
      synced: signal(true), revision: signal<number | null>(1), accountId: signal<string | null>('usr_one'),
      refresh: jasmine.createSpy().and.resolveTo(), selectIcon: jasmine.createSpy().and.resolveTo(false),
    };
    await TestBed.configureTestingModule({
      imports: [LauncherAppearanceComponent], providers: [
        { provide: LauncherAppearanceService, useValue: launcher },
        { provide: TranslateService, useValue: { instant: (key: string, fallback: string) => fallback || key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LauncherAppearanceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });

  it('shows exactly three packaged options and the confirmed selection', () => {
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.launcher-option')) as HTMLButtonElement[];
    expect(buttons.length).toBe(3);
    expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(Array.from(fixture.nativeElement.querySelectorAll('img')).map((img: any) => img.getAttribute('src'))).toEqual([
      'assets/brand/launcher-original.svg', 'assets/brand/launcher-emerald.svg', 'assets/brand/launcher-ivory.svg',
    ]);
    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeNull();
  });

  it('hides controls completely only on unsupported platforms', () => {
    launcher.platform.set('unsupported');
    launcher.supported.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });

  it('keeps the previous selection until account and device confirmation and blocks repeat clicks', async () => {
    let finish!: (success: boolean) => void;
    launcher.selectIcon.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = component.selectIcon('emerald');
    await component.selectIcon('ivory');
    fixture.detectChanges();
    expect(launcher.selectIcon).toHaveBeenCalledOnceWith('emerald');
    expect(launcher.current()).toBe('original');
    expect(component.saved()).toBeFalse();
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.launcher-option')) as HTMLButtonElement[];
    expect(buttons.every(button => button.disabled)).toBeTrue();
    launcher.current.set('emerald');
    finish(true);
    await pending;
    fixture.detectChanges();
    expect(component.saved()).toBeTrue();
    expect(component.pendingIcon()).toBeNull();
    expect(fixture.nativeElement.querySelector('.launcher-success').textContent).toContain('Icono guardado en tu cuenta y aplicado aquí.');
  });

  it('retains the old selection and exposes retry when a change fails', async () => {
    await component.selectIcon('ivory');
    fixture.detectChanges();
    expect(launcher.current()).toBe('original');
    expect(component.saved()).toBeFalse();
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('No pudimos confirmar el cambio completo.');
    await component.refresh();
    expect(launcher.refresh).toHaveBeenCalledTimes(2);
    expect(component.localError()).toBeFalse();
  });

  it('offers the Original variant as a real reversible native selection', async () => {
    launcher.current.set('emerald');
    launcher.selectIcon.and.callFake(async (icon: 'original') => { launcher.current.set(icon); return true; });
    await component.selectIcon('original');
    expect(launcher.selectIcon).toHaveBeenCalledOnceWith('original');
    expect(launcher.current()).toBe('original');
    expect(component.saved()).toBeTrue();
  });

  it('does not advertise working choices when an installed app needs a newer native bridge', () => {
    launcher.supported.set(false);
    launcher.error.set('unavailable');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.launcher-options')).toBeNull();
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('Nivra esté actualizado');
  });

  it('contains an unexpected bridge rejection and explains the Windows scope', async () => {
    launcher.platform.set('windows');
    launcher.selectIcon.and.rejectWith(new Error('bridge gone'));
    await component.selectIcon('ivory');
    fixture.detectChanges();
    expect(component.pendingIcon()).toBeNull();
    expect(component.localError()).toBeTrue();
    expect(fixture.nativeElement.querySelector('.launcher-hint').textContent).toContain('acceso directo');
    expect(fixture.nativeElement.querySelector('.launcher-hint').textContent).toContain('ventana');
  });

  it('updates the web favicon and points PWA installation metadata at the selected account icon', () => {
    launcher.platform.set('web');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.launcher-option').length).toBe(3);
    expect(fixture.nativeElement.querySelector('.device-chip').textContent).toContain('Tu cuenta');
    expect(fixture.nativeElement.querySelector('.launcher-heading').textContent).toContain('Android, Windows y la web');
    const hint = fixture.nativeElement.querySelector('.launcher-hint').textContent;
    expect(hint).toContain('La pestaña cambia al instante');
    expect(hint).toContain('PWA actualiza el manifiesto');
    expect(hint).toContain('vuelve a abrir Nivra');
    expect(hint).not.toContain('pantalla de inicio');
  });

  it('shows a synchronization error and retries without claiming a saved preference', async () => {
    launcher.synced.set(false);
    launcher.error.set('sync');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('No pudimos sincronizar el icono con tu cuenta');
    expect(fixture.nativeElement.querySelector('.launcher-success')).toBeNull();
    (fixture.nativeElement.querySelector('.launcher-error button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(launcher.refresh).toHaveBeenCalledTimes(2);
    expect(component.saved()).toBeFalse();
  });

  it('explains a conflict from another device and offers to reload the latest account choice', () => {
    launcher.error.set('conflict');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('Cambió en otro dispositivo');
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('preferencia más reciente');
    expect(fixture.nativeElement.querySelector('.launcher-error button').textContent).toContain('Reintentar');
    expect(fixture.nativeElement.querySelector('.launcher-success')).toBeNull();
  });

  it('does not treat a locally applied icon as an account save before synchronization is confirmed', async () => {
    launcher.synced.set(false);
    launcher.revision.set(null);
    launcher.selectIcon.and.callFake(async (icon: 'emerald') => { launcher.current.set(icon); return true; });
    await component.selectIcon('emerald');
    fixture.detectChanges();
    expect(component.saved()).toBeFalse();
    expect(component.localError()).toBeTrue();
    expect(fixture.nativeElement.querySelector('.launcher-success')).toBeNull();
  });

  it('allows the current local icon to be selected when its account preference is still unconfirmed', async () => {
    launcher.synced.set(false);
    launcher.revision.set(null);
    launcher.selectIcon.and.callFake(async () => {
      launcher.synced.set(true);
      launcher.revision.set(2);
      return true;
    });
    await component.selectIcon('original');
    fixture.detectChanges();
    expect(launcher.selectIcon).toHaveBeenCalledOnceWith('original');
    expect(component.saved()).toBeTrue();
  });

  it('requires a signed-in account before enabling choices or sending a save', async () => {
    launcher.accountId.set(null);
    launcher.error.set('not-signed-in');
    launcher.synced.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('Inicia sesión');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.launcher-option')) as HTMLButtonElement[];
    expect(buttons.every(button => button.disabled)).toBeTrue();
    await component.selectIcon('emerald');
    expect(launcher.selectIcon).not.toHaveBeenCalled();
  });

  it('clears a saved confirmation when the signed-in account changes', async () => {
    launcher.selectIcon.and.callFake(async (icon: 'emerald') => { launcher.current.set(icon); return true; });
    await component.selectIcon('emerald');
    expect(component.saved()).toBeTrue();
    launcher.accountId.set('usr_two');
    fixture.detectChanges();
    expect(component.saved()).toBeFalse();
    expect(fixture.nativeElement.querySelector('.launcher-success')).toBeNull();
  });

  it('ignores a previous account save that resolves after switching accounts', async () => {
    let finish!: (success: boolean) => void;
    launcher.selectIcon.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = component.selectIcon('emerald');
    launcher.accountId.set('usr_two');
    launcher.current.set('emerald');
    fixture.detectChanges();
    finish(true);
    await pending;
    fixture.detectChanges();
    expect(component.saved()).toBeFalse();
    expect(component.localError()).toBeFalse();
    expect(component.pendingIcon()).toBeNull();
  });

  it('contains a rejected account refresh and leaves a retry message', async () => {
    launcher.refresh.and.rejectWith(new Error('offline'));
    await component.refresh();
    fixture.detectChanges();
    expect(component.localError()).toBeTrue();
    expect(fixture.nativeElement.querySelector('.launcher-error button')).not.toBeNull();
  });
});
