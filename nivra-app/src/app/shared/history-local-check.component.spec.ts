import { TestBed } from '@angular/core/testing';
import { HistoryLocalCheckComponent } from './history-local-check.component';
import { TranslateService } from '../core/services/translate.service';

describe('local history recovery presentation', () => {
  it('distinguishes local checking from unavailable copies without requesting a device approval', async () => {
    TestBed.configureTestingModule({ imports: [HistoryLocalCheckComponent], providers: [
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    const fixture = TestBed.createComponent(HistoryLocalCheckComponent); const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('state', 'checking'); fixture.detectChanges();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.textContent).toContain('no requiere otro dispositivo');
    expect(host.querySelector('button')).toBeNull(); expect(host.querySelector('code')).toBeNull();
    fixture.componentRef.setInput('state', 'retryable'); fixture.detectChanges();
    const retry = jasmine.createSpy(); fixture.componentInstance.retry.subscribe(retry);
    host.querySelector('button')!.click(); expect(retry).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Al recuperar la conexión');
    for (const width of [320, 390]) {
      host.style.width = `${width}px`; await new Promise<void>(done => requestAnimationFrame(() => done()));
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(host.querySelector('button')!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    fixture.componentRef.setInput('state', 'unavailable'); fixture.detectChanges();
    expect(host.textContent).toContain('Algunas copias antiguas'); expect(host.textContent).not.toContain('Al recuperar la conexión');
    fixture.componentInstance.open = true; fixture.componentRef.setInput('state', 'idle'); fixture.detectChanges();
    expect(host.querySelector('section')).toBeNull(); expect(fixture.componentInstance.open).toBeFalse();
  });
});
