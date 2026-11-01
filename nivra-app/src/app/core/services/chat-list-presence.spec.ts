import { ChatService } from './chat.service';

describe('three-line conversation status', () => {
  function label(preview: string, presence: string, protectedChat = false) {
    const service: any = Object.create(ChatService.prototype);
    service.privateChats = { isProtected: () => protectedChat };
    service.conversationSubtitle = () => preview;
    service.presenceLabel = () => presence;
    return service.conversationListPresence({ id: 'conversation' } as any);
  }
  it('omits the repeated empty-chat security label regardless of case and spacing', () => {
    expect(label('Cifrado extremo a extremo', 'cifrado extremo a extremo')).toBe('');
    expect(label('  Cifrado   extremo a extremo ', 'cifrado extremo a extremo')).toBe('');
    expect(label('Archivado - Cifrado extremo a extremo', 'cifrado extremo a extremo')).toBe('');
  });
  it('retains meaningful presence, typing, group size and reconnection state', () => {
    for (const presence of ['online', 'visto hace 4 min', 'Ana esta escribiendo', '3 participantes', 'reconectando']) {
      expect(label('Cifrado extremo a extremo', presence)).toBe(presence);
    }
    expect(label('hola', 'cifrado extremo a extremo')).toBe('cifrado extremo a extremo');
  });
  it('never reveals presence under a protected conversation', () => {
    expect(label('Chat protegido', 'online', true)).toBe('');
  });
});
