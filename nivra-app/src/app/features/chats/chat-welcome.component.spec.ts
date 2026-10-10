import { TestBed } from '@angular/core/testing';
import { TranslateService } from '../../core/services/translate.service';
import { ChatWelcomeComponent } from './chat-welcome.component';

describe('Chat welcome guide', () => {
  it('connects each guide card and main action to a real entry point', async () => {
    await TestBed.configureTestingModule({ imports: [ChatWelcomeComponent], providers: [{ provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } }] }).compileComponents();
    const fixture = TestBed.createComponent(ChatWelcomeComponent);
    const chat = jasmine.createSpy();
    const pass = jasmine.createSpy();
    const group = jasmine.createSpy();
    const story = jasmine.createSpy();
    fixture.componentInstance.newChat.subscribe(chat);
    fixture.componentInstance.sharePass.subscribe(pass);
    fixture.componentInstance.newGroup.subscribe(group);
    fixture.componentInstance.newStory.subscribe(story);
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    buttons[0].click(); buttons[1].click(); buttons[2].click(); buttons[3].click(); buttons[4].click();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(group).toHaveBeenCalledTimes(1);
    expect(story).toHaveBeenCalledTimes(1);
  });

  it('shows a lighter workspace prompt once a conversation exists', async () => {
    await TestBed.configureTestingModule({ imports: [ChatWelcomeComponent], providers: [{ provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } }] }).compileComponents();
    const fixture = TestBed.createComponent(ChatWelcomeComponent);
    fixture.componentRef.setInput('firstConversation', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.welcome-guide')).toBeNull();
    expect(fixture.nativeElement.querySelector('h2').textContent).toContain('Un espacio para tu gente');
    expect(fixture.nativeElement.querySelectorAll('button').length).toBe(2);
  });
});
