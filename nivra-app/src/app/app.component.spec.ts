import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';

import { AppComponent } from './app.component';

describe('AppComponent', () => {

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideHttpClient(),
        provideRouter([]),
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();
  });

  it('routes native recovery links with their token fragment', () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    (app as any).handleAppUrlOpen('https://nivrapp-secure.vercel.app/recover#token=abc&purpose=verify-email');
    expect(navigate).toHaveBeenCalledWith('/recover#token=abc&purpose=verify-email');
    navigate.calls.reset();
    (app as any).handleAppUrlOpen('https://example.test/recover#token=abc');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('coalesces overlapping native resume events', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    let complete!: () => void;
    const resume = spyOn<any>(app, 'resumeExistingSession').and.returnValue(new Promise<void>(resolve => complete = resolve));
    const first = (app as any).handleAppResume();
    const second = (app as any).handleAppResume();
    expect(first).toBe(second); expect(resume).toHaveBeenCalledTimes(1);
    complete(); await first;
    await (app as any).handleAppResume();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

});
