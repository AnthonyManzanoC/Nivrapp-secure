import { Component } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { TransientNoticeDirective } from './transient-notice.directive';

@Component({standalone:true,imports:[TransientNoticeDirective],template:`@if(notice){<p [appTransientNotice]="notice" (noticeExpired)="notice=''">{{notice}}</p>}`})
class NoticeHost { notice='Guardado'; }
describe('temporary action feedback',()=>{
  it('expires even if a pointer or focus stays on the result',fakeAsync(()=>{
    const fixture=TestBed.createComponent(NoticeHost);fixture.detectChanges();
    fixture.nativeElement.querySelector('p').dispatchEvent(new Event('mouseenter'));
    tick(30000);fixture.detectChanges();expect(fixture.componentInstance.notice).toBe('');fixture.destroy();
  }));
  it('removes the result after eight seconds and resets for the next action',fakeAsync(()=>{
    const fixture=TestBed.createComponent(NoticeHost);fixture.detectChanges();
    tick(7999);expect(fixture.componentInstance.notice).toBe('Guardado');tick(1);fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('p')).toBeNull();
    fixture.componentInstance.notice='Otro resultado';fixture.detectChanges();tick(8000);fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('p')).toBeNull();fixture.destroy();
  }));
  it('keeps a fresh result until its own deadline and cancels the old timer',fakeAsync(()=>{
    const fixture=TestBed.createComponent(NoticeHost);fixture.detectChanges();tick(5000);
    fixture.componentInstance.notice='Actualizado';fixture.detectChanges();tick(3000);
    expect(fixture.componentInstance.notice).toBe('Actualizado');tick(5000);fixture.detectChanges();
    expect(fixture.componentInstance.notice).toBe('');fixture.destroy();
  }));
  it('pauses while the user reads a focused result and cleans up on destroy',fakeAsync(()=>{
    const fixture=TestBed.createComponent(NoticeHost);fixture.detectChanges();tick(3000);
    const p=fixture.nativeElement.querySelector('p');p.dispatchEvent(new Event('focusin'));tick(20000);
    expect(fixture.componentInstance.notice).toBe('Guardado');p.dispatchEvent(new Event('focusout'));tick(4999);
    expect(fixture.componentInstance.notice).toBe('Guardado');fixture.destroy();tick(10000);
    expect(fixture.componentInstance.notice).toBe('Guardado');
  }));
});
