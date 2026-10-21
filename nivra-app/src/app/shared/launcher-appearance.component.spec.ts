import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LauncherAppearanceComponent } from './launcher-appearance.component';
import { LauncherAppearanceService } from '../core/services/launcher-appearance.service';
import { TranslateService } from '../core/services/translate.service';

describe('LauncherAppearanceComponent confirmed device preferences', () => {
  let fixture: ComponentFixture<LauncherAppearanceComponent>;
  let component: LauncherAppearanceComponent;
  let launcher: {
    platform: ReturnType<typeof signal<'android' | 'windows' | 'unsupported'>>;
    supported: ReturnType<typeof signal<boolean>>;
    current: ReturnType<typeof signal<'original' | 'emerald' | 'ivory'>>;
    busy: ReturnType<typeof signal<boolean>>;
    error: ReturnType<typeof signal<'unavailable' | 'failed' | null>>;
    refresh: jasmine.Spy;
    selectIcon: jasmine.Spy;
  };

  beforeEach(async () => {
    launcher = {
      platform: signal<'android' | 'windows' | 'unsupported'>('android'), supported: signal(true),
      current: signal<'original' | 'emerald' | 'ivory'>('original'), busy: signal(false),
      error: signal<'unavailable' | 'failed' | null>(null),
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

  it('hides controls completely in a web browser', () => {
    launcher.platform.set('unsupported');
    launcher.supported.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });

  it('keeps the previous selection until the native change is confirmed and blocks repeat clicks', async () => {
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
    expect(fixture.nativeElement.querySelector('.launcher-success').textContent).toContain('Icono actualizado.');
  });

  it('retains the old selection and exposes retry when a change fails', async () => {
    await component.selectIcon('ivory');
    fixture.detectChanges();
    expect(launcher.current()).toBe('original');
    expect(component.saved()).toBeFalse();
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('No pudimos confirmar el cambio.');
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
    expect(fixture.nativeElement.querySelector('.launcher-error').textContent).toContain('Actualiza Nivra');
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
});
