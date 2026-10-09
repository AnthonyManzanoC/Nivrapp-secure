import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateService } from '../../core/services/translate.service';
import { ChatIdentityChangeNoticeComponent } from './chat-identity-change-notice.component';

describe('chat identity change notice', () => {
  let fixture: ComponentFixture<ChatIdentityChangeNoticeComponent>;
  const root = () => fixture.nativeElement as HTMLElement;
  const action = () => root().querySelector<HTMLButtonElement>('.identity-verify-action')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatIdentityChangeNoticeComponent],
      providers: [{ provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } }],
    }).compileComponents();
    fixture = TestBed.createComponent(ChatIdentityChangeNoticeComponent);
    fixture.detectChanges();
  });

  it('renders a clear security change explanation and an explicit verification action', () => {
    expect(root().querySelector('[role="alert"]')).not.toBeNull();
    expect(root().textContent).toContain('El código de seguridad cambió');
    expect(root().textContent).toContain('Compara el código con tu contacto para continuar.');
    expect(action().textContent).toContain('Verificar identidad');
    expect(action().type).toBe('button');
  });

  it('opens verification only after an intentional tap', () => {
    const verify = jasmine.createSpy('verify');
    fixture.componentInstance.verify.subscribe(verify);
    expect(verify).not.toHaveBeenCalled();
    action().click();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('prevents the action while the composer is busy', () => {
    const verify = jasmine.createSpy('verify');
    fixture.componentInstance.verify.subscribe(verify);
    fixture.componentRef.setInput('disabled', true); fixture.detectChanges();
    expect(action().disabled).toBeTrue(); action().click();
    expect(verify).not.toHaveBeenCalled();
  });
});
