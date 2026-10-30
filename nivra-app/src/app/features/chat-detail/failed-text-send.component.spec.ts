import { TestBed } from '@angular/core/testing';
import { TranslateService } from '../../core/services/translate.service';
import { FailedTextSendComponent } from './failed-text-send.component';

describe('Failed text recovery controls', () => {
  it('keeps long text inside mobile widths and exposes independent accessible actions', async () => {
    TestBed.configureTestingModule({ imports: [FailedTextSendComponent], providers: [
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    const fixture = TestBed.createComponent(FailedTextSendComponent);
    fixture.componentRef.setInput('text', 'Mensaje pendiente con un enlace ' + 'a'.repeat(600));
    const retry = jasmine.createSpy(), discard = jasmine.createSpy();
    fixture.componentInstance.retry.subscribe(retry); fixture.componentInstance.discard.subscribe(discard);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    for (const width of [320, 390]) {
      host.style.width = `${width}px`;
      await new Promise<void>(done => requestAnimationFrame(() => done()));
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      for (const button of Array.from(host.querySelectorAll('button'))) {
        expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
    }
    const buttons = host.querySelectorAll('button');
    buttons[0].click(); buttons[1].click();
    expect(retry).toHaveBeenCalledTimes(1); expect(discard).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('retryDisabled', true); fixture.componentRef.setInput('busy', true); fixture.detectChanges();
    buttons[0].click(); buttons[1].click();
    expect(retry).toHaveBeenCalledTimes(1); expect(discard).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Mensaje sin enviar');
  });
});
