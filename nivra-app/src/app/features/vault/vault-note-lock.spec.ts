import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { LoadingController } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import { DeviceWipeService } from '../../core/services/device-wipe.service';
import { PanicPinService } from '../../core/services/panic-pin.service';
import { TranslateService } from '../../core/services/translate.service';
import { VaultService } from '../../core/services/vault.service';
import { VaultPage } from './vault.page';

describe('Vault local note editor lock boundary', () => {
  const owner = (id: string) => ({ user: { id }, device: { id: `device-${id}` } });
  let session: ReturnType<typeof signal<any>>;
  let generation: ReturnType<typeof signal<number>>;
  let vault: any;
  let fixture: ComponentFixture<VaultPage>;
  let extraFixture: ComponentFixture<VaultPage> | undefined;
  const compose = () => fixture.nativeElement.querySelector('.note-composer-panel') as HTMLElement | null;
  const settle = async () => {
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const enterPin = async (pin: string) => {
    fixture.componentInstance.pin = pin;
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.unlock-panel ion-button') as HTMLElement).click();
    await settle();
  };

  beforeEach(async () => {
    session = signal<any>(owner('alice'));
    generation = signal(0);
    vault = {
      unlocked: signal(false), loading: signal(false), items: signal([]), rooms: signal([]), people: signal([]),
      activeRoom: signal(null), activeRoomId: signal(null),
      load: jasmine.createSpy('load').and.resolveTo(),
      enablePrivacyShield: jasmine.createSpy('enablePrivacyShield').and.resolveTo(),
      disablePrivacyShield: jasmine.createSpy('disablePrivacyShield').and.resolveTo(),
      unlock: jasmine.createSpy('unlock').and.callFake(async (pin: string) => {
        if (pin !== 'fixture-valid-pin') throw new Error('PIN incorrecto');
        vault.unlocked.set(true);
      }),
      lock: jasmine.createSpy('lock').and.callFake(() => vault.unlocked.set(false)),
      createNote: jasmine.createSpy('createNote').and.resolveTo(),
      isCurrentUser: (id: string) => id === session()?.user.id,
    };
    await TestBed.configureTestingModule({ imports: [VaultPage], providers: [
      { provide: AuthService, useValue: { session, sessionGeneration: generation } },
      { provide: VaultService, useValue: vault },
      { provide: PanicPinService, useValue: { matches: jasmine.createSpy('matches').and.resolveTo(false) } },
      { provide: DeviceWipeService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback, currentLanguage: () => 'es' } },
      { provide: LoadingController, useValue: {} },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
      { provide: Router, useValue: {} },
    ] }).compileComponents();
    fixture = TestBed.createComponent(VaultPage);
    fixture.detectChanges();
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    extraFixture?.destroy();
    extraFixture = undefined;
    TestBed.resetTestingModule();
  });

  it('removes the complete editor, file picker and save action until the local PIN succeeds', async () => {
    expect(compose()).toBeNull();
    expect(fixture.nativeElement.querySelector('input[type="file"][multiple]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Nueva nota');
    expect(fixture.nativeElement.textContent).toContain('Crear sala privada');
    expect(fixture.nativeElement.querySelector('.unlock-panel').classList.contains('span-12')).toBeTrue();

    await enterPin('fixture-valid-pin');
    expect(vault.unlock).toHaveBeenCalledOnceWith('fixture-valid-pin');
    expect(compose()?.textContent).toContain('Nueva nota');
    expect(compose()?.querySelector('ion-input')).not.toBeNull();
    expect(compose()?.querySelector('ion-textarea')).not.toBeNull();
    expect(compose()?.querySelector('input[type="file"][multiple]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.unlock-panel').classList.contains('span-4')).toBeTrue();
  });

  it('keeps all note inputs outside the DOM after an invalid PIN', async () => {
    await enterPin('fixture-invalid-pin');
    expect(compose()).toBeNull();
    expect(fixture.nativeElement.querySelector('.error').textContent).toContain('PIN incorrecto');
    expect(vault.unlocked()).toBeFalse();
    expect(vault.createNote).not.toHaveBeenCalled();
  });

  it('hides the editor for the whole asynchronous unlock instead of exposing it at button press', async () => {
    let finish!: () => void;
    vault.unlock.and.callFake(() => new Promise<void>(resolve => {
      finish = () => { vault.unlocked.set(true); resolve(); };
    }));
    fixture.componentInstance.pin = 'fixture-valid-pin';
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.unlock-panel ion-button') as HTMLElement).click();
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    fixture.detectChanges();
    expect(compose()).toBeNull();
    finish();
    await settle();
    expect(compose()).not.toBeNull();
  });

  it('preserves an unsaved draft for the same account while concealing it again on every lock', async () => {
    await enterPin('fixture-valid-pin');
    const page = fixture.componentInstance;
    const file = new File(['private draft'], 'draft.txt', { type: 'text/plain' });
    page.title = 'Mi borrador'; page.body = 'Texto privado'; page.noteAttachments = [file];
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.vault-key-state ion-button') as HTMLElement).click();
    fixture.detectChanges();
    expect(compose()).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('draft.txt');
    await enterPin('fixture-invalid-pin');
    expect(compose()).toBeNull();
    await enterPin('fixture-valid-pin');
    expect(compose()?.querySelector('ion-input')?.value).toBe('Mi borrador');
    expect(compose()?.querySelector('ion-textarea')?.value).toBe('Texto privado');
    expect(compose()?.textContent).toContain('draft.txt');
    expect(page.noteAttachments).toEqual([file]);
  });

  it('conceals and releases the previous draft when accounts change, even if the new vault is already unlocked', async () => {
    await enterPin('fixture-valid-pin');
    const page = fixture.componentInstance;
    page.title = 'PRIVATE A'; page.body = 'ONLY A';
    page.noteAttachments = [new File(['A'], 'private-A.txt')];
    session.set(owner('bob')); generation.set(1);
    // A root-scoped vault may already be ready for B before this old view is destroyed.
    vault.unlocked.set(true);
    fixture.detectChanges();
    expect(compose()).toBeNull();
    expect(page.title).toBe(''); expect(page.body).toBe(''); expect(page.noteAttachments).toEqual([]);
    expect(fixture.nativeElement.textContent).not.toContain('private-A.txt');

    extraFixture = TestBed.createComponent(VaultPage);
    extraFixture.detectChanges();
    expect(extraFixture.nativeElement.querySelector('.note-composer-panel')).not.toBeNull();
    expect(extraFixture.componentInstance.title).toBe('');
    expect(extraFixture.componentInstance.body).toBe('');
    expect(extraFixture.componentInstance.noteAttachments).toEqual([]);

    session.set(owner('alice')); generation.set(2);
    fixture.detectChanges();
    expect(compose()).toBeNull();
  });

  it('ignores a file picker completion after locking and releases its draft when the view is destroyed', async () => {
    await enterPin('fixture-valid-pin');
    const page = fixture.componentInstance;
    vault.lock(); fixture.detectChanges();
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [new File(['late'], 'late.txt')] });
    page.noteFilesSelected({ target: input } as unknown as Event);
    expect(page.noteAttachments).toEqual([]);
    page.title = 'In memory'; page.body = 'Unsaved'; page.noteAttachments = [new File(['x'], 'private.txt')];
    fixture.destroy();
    expect(page.title).toBe(''); expect(page.body).toBe(''); expect(page.noteAttachments).toEqual([]);
  });
});
