import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { StoryActivityComponent } from './story-activity.component';
import { SocialService } from '../../core/services/social.service';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';

describe('creator story activity', () => {
  let component: StoryActivityComponent;
  let session: ReturnType<typeof signal<any>>;
  let social: any;
  let chat: any;
  let navigate: jasmine.Spy;
  beforeEach(() => {
    session = signal({ user: { id: 'creator' }, device: { id: 'phone' } });
    social = { refreshStoryActivity: jasmine.createSpy('refresh').and.resolveTo(), closeStory: jasmine.createSpy('close') };
    chat = { createDirectConversation: jasmine.createSpy('direct').and.resolveTo({ id: 'conversation' }) };
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } }, { provide: SocialService, useValue: social },
      { provide: ChatService, useValue: chat }, { provide: Router, useValue: { navigate } },
    ] });
    component = TestBed.runInInjectionContext(() => new StoryActivityComponent());
    component.story = {
      id: 'story', owner: { id: 'creator' }, viewCount: 8,
      views: [{ user: { id: 'old' }, viewedAt: '2026-01-01T10:00:00Z' }, { user: { id: 'new' }, viewedAt: '2026-01-01T11:00:00Z' }],
      reactions: [{ id: 'reaction', user: { id: 'new' }, emoji: '❤️', reactedAt: '2026-01-01T11:01:00Z' }],
      comments: [{ id: 'reply', user: { id: 'new' }, commentedAt: '2026-01-01T11:02:00Z' }],
    } as any;
  });
  it('keeps server view counts and orders real viewers, with their own reactions', () => {
    expect(component.views).toBe(8);
    expect(component.people.map((view) => view.user.id)).toEqual(['new', 'old']);
    expect(component.reactionFor('new')).toBe('❤️');
    expect(component.reactionFor('old')).toBe('');
  });
  it('does not reveal creator activity or refresh another user’s statistics', async () => {
    session.set({ user: { id: 'other' }, device: { id: 'phone' } });
    expect(component.authorized).toBeFalse();
    await component.refresh();
    expect(social.refreshStoryActivity).not.toHaveBeenCalled();
  });
  it('opens the real reply conversation and stops the viewer', async () => {
    spyOn(component.closed, 'emit');
    await component.openReply(component.replies[0]);
    expect(chat.createDirectConversation).toHaveBeenCalledOnceWith(component.replies[0].user);
    expect(component.closed.emit).toHaveBeenCalled();
    expect(social.closeStory).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnceWith(['/app/chats', 'conversation']);
  });
  it('does not navigate a delayed reply into a different account or device', async () => {
    let finish!: (value: any) => void;
    chat.createDirectConversation.and.returnValue(new Promise((resolve) => finish = resolve));
    const opening = component.openReply(component.replies[0]);
    session.set({ user: { id: 'creator' }, device: { id: 'new-device' } });
    finish({ id: 'private-chat' }); await opening;
    expect(navigate).not.toHaveBeenCalled();
    expect(social.closeStory).not.toHaveBeenCalled();
  });
});
