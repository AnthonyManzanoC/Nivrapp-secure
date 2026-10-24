import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateService } from '../core/services/translate.service';
import { ChatLoadingComponent } from './chat-loading.component';

describe('ChatLoadingComponent', () => {
  let fixture: ComponentFixture<ChatLoadingComponent>;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChatLoadingComponent], providers: [
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(ChatLoadingComponent);
  });
  it('announces one loading state while all conversation silhouettes remain decorative', () => {
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('[role="status"]').length).toBe(1);
    expect(root.querySelectorAll('.loading-avatar').length).toBe(5);
    expect(root.querySelector('.loading-silhouettes')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toContain('Preparando tus conversaciones');
    expect(root.querySelectorAll('button, a, input').length).toBe(0);
  });
  it('uses message silhouettes without inventing error messages or interactive bubbles', () => {
    fixture.componentInstance.mode = 'messages'; fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.message-loading')).not.toBeNull();
    expect(root.querySelectorAll('.loading-avatar').length).toBe(0);
    expect(root.querySelectorAll('.outgoing').length).toBe(2);
    expect(root.textContent).toContain('Preparando tus mensajes');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
  it('keeps refresh feedback compact so the caller can retain readable conversations', () => {
    fixture.componentInstance.compact = true; fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Actualizando tus chats');
    expect(root.querySelector('.loading-silhouettes')).toBeNull();
    fixture.componentInstance.mode = 'messages'; fixture.detectChanges();
    expect(root.textContent).toContain('Actualizando mensajes');
  });
  it('can stand in for one temporarily unreadable message without repeating live announcements', () => {
    fixture.componentInstance.mode = 'messages'; fixture.componentInstance.single = true;
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.loading-row').length).toBe(1);
    expect(root.querySelector('.chat-loading')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(root.querySelector('.loading-description')).toBeNull();
  });

  it('fills an existing conversation viewport with full rows using one accessible loading announcement', () => {
    fixture.componentInstance.rowCount = 9;
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.loading-row').length).toBe(9);
    expect(root.querySelectorAll('.loading-avatar').length).toBe(9);
    expect(root.querySelectorAll('[role="status"]').length).toBe(1);
  });
});
