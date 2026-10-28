import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PrivateChatLockService } from '../core/services/private-chat-lock.service';
import { TranslateService } from '../core/services/translate.service';
import { PrivateChatLockComponent } from './private-chat-lock.component';

describe('PrivateChatLockComponent', () => {
  let fixture: ComponentFixture<PrivateChatLockComponent>;
  let locks: any;

  beforeEach(() => {
    locks = {
      ready: signal(true), busy: signal(false), error: signal(''),
      appLock: { canUseBiometric: () => false, pinRetrySeconds: signal(0) },
      authenticate: jasmine.createSpy('authenticate'),
      relock: jasmine.createSpy('relock'), configure: jasmine.createSpy('configure'),
    };
    TestBed.configureTestingModule({
      imports: [PrivateChatLockComponent],
      providers: [
        { provide: PrivateChatLockService, useValue: locks },
        { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      ],
    });
    fixture = TestBed.createComponent(PrivateChatLockComponent);
    fixture.componentRef.setInput('conversationId', 'chat-protected');
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('cancels an outstanding verification when the sheet is dismissed', async () => {
    let finish!: (result: boolean) => void;
    locks.authenticate.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const completed = jasmine.createSpy('completed');
    fixture.componentInstance.completed.subscribe(completed);

    const verification = fixture.componentInstance.verify(false);
    fixture.destroy();
    expect(locks.relock).toHaveBeenCalledTimes(1);
    finish(true);
    await verification;
    expect(completed).not.toHaveBeenCalled();
  });

  it('preserves the authenticated one-chat grant while its sheet closes', async () => {
    locks.authenticate.and.resolveTo(true);
    const completed = jasmine.createSpy('completed');
    fixture.componentInstance.completed.subscribe(completed);

    await fixture.componentInstance.verify(false);
    expect(completed).toHaveBeenCalledTimes(1);
    fixture.destroy();
    expect(locks.relock).not.toHaveBeenCalled();
  });
});
