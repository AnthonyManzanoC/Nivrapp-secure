import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { CallReturnBarComponent, globalCallReturnVisible } from './call-return-bar.component';
import { CallsService } from '../core/services/calls.service';
import { TranslateService } from '../core/services/translate.service';

describe('Unified call return bar',()=>{
  it('never adds a second global bar over the shell, a ringing call or locked content',()=>{
    const context={url:'/contact?alias=ana',authenticated:true,locked:false,active:true,phase:'connected'};
    expect(globalCallReturnVisible(context)).toBeTrue();
    for(const url of ['/app','/app/chats','/app/calls','/app/world?source=story'])expect(globalCallReturnVisible({...context,url})).toBeFalse();
    expect(globalCallReturnVisible({...context,locked:true})).toBeFalse();
    expect(globalCallReturnVisible({...context,phase:'ringing'})).toBeFalse();
    expect(globalCallReturnVisible({...context,active:false})).toBeFalse();
  });
  let calls:any;
  beforeEach(async()=>{
    calls={activeCall:signal<any>({id:'call',type:'Voice',startedAt:new Date().toISOString()}),resumableCall:signal(null),
      callTitle:()=> 'Ana',callStatusLabel:()=> 'Conectado',audioOutput:{playbackBlocked:signal(false),resume:jasmine.createSpy('resume')}};
    await TestBed.configureTestingModule({imports:[CallReturnBarComponent],providers:[provideRouter([]),
      {provide:CallsService,useValue:calls},{provide:TranslateService,useValue:{instant:(_:string,fallback:string)=>fallback,currentLanguage:signal('es')}},
    ]}).compileComponents();
  });
  it('combines title, elapsed status, return action and blocked-audio repair in one bar',()=>{
    const fixture=TestBed.createComponent(CallReturnBarComponent);fixture.detectChanges();
    const page:HTMLElement=fixture.nativeElement;
    expect(page.querySelectorAll('.call-return-bar').length).toBe(1);
    expect(page.textContent).toContain('Ana');expect(page.textContent).toContain('Conectado');
    const navigate=spyOn(TestBed.inject(Router),'navigate').and.resolveTo(true);
    (page.querySelector('.return-action') as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith(['/app/calls']);
    calls.audioOutput.playbackBlocked.set(true);fixture.detectChanges();
    (page.querySelector('.resume-audio') as HTMLButtonElement).click();expect(calls.audioOutput.resume).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });
});
