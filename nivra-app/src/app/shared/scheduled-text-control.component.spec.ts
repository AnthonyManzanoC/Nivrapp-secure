import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppLockService } from '../core/services/app-lock.service';
import { TranslateService } from '../core/services/translate.service';
import { ScheduledTextControlComponent } from './scheduled-text-control.component';

describe('scheduled text control', () => {
  let fixture: ComponentFixture<ScheduledTextControlComponent>, locked: ReturnType<typeof signal<boolean>>;
  beforeEach(async () => {
    locked = signal(false);
    await TestBed.configureTestingModule({ imports: [ScheduledTextControlComponent], providers: [
      { provide: AppLockService, useValue: { isContentLocked: locked } },
      { provide: TranslateService, useValue: { instant: (_: string, fallback: string) => fallback, currentLanguage: signal('es') } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(ScheduledTextControlComponent);
    fixture.componentRef.setInput('canSchedule', true); fixture.componentRef.setInput('context', 'alice:phone:chat'); fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });
  it('explains the foreground requirement and emits a specific instant selected by a delay', () => {
    const component = fixture.componentInstance, scheduled = jasmine.createSpy(); component.schedule.subscribe(scheduled);
    component.show(); component.delay(10); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Si está cerrada');
    expect(fixture.nativeElement.querySelector('dialog').open).toBeTrue();
    const now = Date.now(); component.submit();
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled.calls.first().args[0]).toBeGreaterThan(now + 8 * 60000);
    expect(scheduled.calls.first().args[0]).toBeLessThanOrEqual(now + 10 * 60000);
    expect(fixture.nativeElement.querySelector('dialog').open).toBeFalse();
  });
  it('closes and clears the native top-layer dialog on app lock and account/chat replacement', () => {
    const component = fixture.componentInstance;
    component.show(); locked.set(true); TestBed.flushEffects(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog').open).toBeFalse(); expect(component.localTime).toBe('');
    locked.set(false); TestBed.flushEffects(); component.show();
    fixture.componentRef.setInput('context', 'bob:browser:another-chat'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog').open).toBeFalse(); expect(component.localTime).toBe('');
  });
  it('never schedules an invalid or already passed date and preserves the form for correction', () => {
    const component = fixture.componentInstance, scheduled = jasmine.createSpy(); component.schedule.subscribe(scheduled);
    component.show(); component.localTime = '2026-02-31T09:20'; component.submit();
    expect(scheduled).not.toHaveBeenCalled(); expect(component.error).not.toBe('');
    expect(fixture.nativeElement.querySelector('dialog').open).toBeTrue();
  });
});
