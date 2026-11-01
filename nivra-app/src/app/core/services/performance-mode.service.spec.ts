import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { PerformanceModeService } from './performance-mode.service';
import { NativeDeviceService } from './native-device.service';

describe('adaptive performance diagnostics', () => {
  let visibility: jasmine.Spy;
  let diagnostics: jasmine.Spy;
  beforeEach(() => {
    visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    diagnostics = jasmine.createSpy('diagnostics').and.resolveTo({ nativeDiagnostics: { thermalStatus: 0 } });
    TestBed.configureTestingModule({ providers: [{ provide: NativeDeviceService, useValue: { diagnostics } }] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.classList.remove('nivra-efficiency-mode', 'nivra-offline', 'nivra-thermal-hot');
  });
  it('stops probes in the background and immediately refreshes when visible', fakeAsync(() => {
    const service = TestBed.inject(PerformanceModeService);
    flushMicrotasks();
    expect(diagnostics).toHaveBeenCalledTimes(1);
    visibility.and.returnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    tick(180_000); expect(diagnostics).toHaveBeenCalledTimes(1); expect(service.efficiencyMode()).toBeTrue();
    visibility.and.returnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); flushMicrotasks();
    expect(diagnostics).toHaveBeenCalledTimes(2); expect(service.efficiencyMode()).toBeFalse();
    TestBed.resetTestingModule(); tick(90_000); expect(diagnostics).toHaveBeenCalledTimes(2);
  }));
  it('prevents overlapping native calls and ignores results arriving after destruction', fakeAsync(() => {
    let resolve!: (value: unknown) => void;
    diagnostics.and.returnValue(new Promise(done => { resolve = done; }));
    const service = TestBed.inject(PerformanceModeService);
    tick(135_000); expect(diagnostics).toHaveBeenCalledTimes(1);
    TestBed.resetTestingModule(); resolve({ nativeDiagnostics: { thermalStatus: 4 } }); flushMicrotasks();
    expect(service.thermalHot()).toBeFalse();
    expect(document.documentElement.classList.contains('nivra-thermal-hot')).toBeFalse();
  }));
  it('retains thermal protection when a subsequent diagnostic call fails', fakeAsync(() => {
    diagnostics.and.resolveTo({ nativeDiagnostics: { thermalStatus: 3 } });
    const service = TestBed.inject(PerformanceModeService); flushMicrotasks();
    expect(service.thermalHot()).toBeTrue();
    diagnostics.and.rejectWith(new Error('native unavailable')); tick(45_000); flushMicrotasks();
    expect(service.thermalHot()).toBeTrue(); expect(service.efficiencyMode()).toBeTrue();
    TestBed.resetTestingModule();
  }));
});
