import { ChatService } from './chat.service';

describe('self conversation identity', () => {
  const own={id:'notes',type:'Direct',participants:[{userId:'me'}]} as any;
  const direct={id:'direct',type:'Direct',participants:[{userId:'me'},{userId:'peer'}]} as any;
  it('never reuses an ordinary direct chat as the own-account conversation', () => {
    const service:any=Object.create(ChatService.prototype);
    service.auth={session:()=>({user:{id:'me',displayName:'Alex',profilePhotoDataUrl:'own-photo'}})};
    expect(service.isDirectConversationWith(direct,'me')).toBeFalse();
    expect(service.isDirectConversationWith(own,'me')).toBeTrue();
    expect(service.isDirectConversationWith(direct,'peer')).toBeTrue();
    expect(service.conversationTitle(own)).toBe('Alex (Tú)');
    expect(service.presenceLabel(own)).toBe('Mensajes para ti');
    expect(service.isSelfConversation({...own,participants:[{userId:'me',removedAt:'2026-11-01'}]})).toBeFalse();
  });
});
