import { ChatDetailPage } from './chat-detail.page';

describe('incognito entry overlay lifecycle', () => {
  const setup = () => {
    const vault = { createRoom: jasmine.createSpy().and.resolveTo({ id: 'temporary-room' }), leaveRoom: jasmine.createSpy().and.resolveTo() };
    const modal = { dismiss: jasmine.createSpy().and.resolveTo(true) };
    const router = { navigate: jasmine.createSpy().and.resolveTo(true) };
    const page: any = Object.assign(Object.create(ChatDetailPage.prototype), {
      auth: { session: () => ({ user: { id: 'me' } }), sessionGeneration: () => 1 },
      conversation: () => ({ id: 'normal-chat', participants: [{ userId: 'peer' }] }),
      chat: { isGroup: () => false, isSelfConversation: () => false },
      injector: { get: () => vault }, incognitoModal: modal, router,
      isBlocked: () => false, privateChatLocked: () => false, busyAction: '', destroyed: false, incognitoConfirmOpen: true,
    });
    return { page, vault, modal, router };
  };
  it('waits for the dialog to disappear before changing pages', async () => {
    const { page, modal, router } = setup();
    let close!: () => void;
    modal.dismiss.and.returnValue(new Promise(resolve => close = () => resolve(true)));
    const opening = page.startIncognito(); await Promise.resolve(); await Promise.resolve();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(modal.dismiss).toHaveBeenCalledWith(undefined, 'incognito-start');
    close(); await opening;
    expect(router.navigate).toHaveBeenCalledWith(['/app/vault'], { queryParams: { room: 'temporary-room', mode: 'incognito', from: 'normal-chat' } });
    expect(page.incognitoConfirmOpen).toBeFalse(); expect(page.busyAction).toBe('');
  });
  it('cleans up a room if navigation is cancelled and allows another attempt', async () => {
    const { page, vault, router } = setup(); router.navigate.and.resolveTo(false);
    await page.startIncognito();
    expect(vault.leaveRoom).toHaveBeenCalledWith('temporary-room'); expect(page.busyAction).toBe('');
  });
  it('shows a retryable error inside the still-open dialog after creation fails', async () => {
    const { page, vault, router } = setup(); vault.createRoom.and.rejectWith(new Error('Sin conexión'));
    await page.startIncognito();
    expect(page.notice).toBe('Sin conexión'); expect(page.incognitoConfirmOpen).toBeTrue(); expect(page.busyAction).toBe(''); expect(router.navigate).not.toHaveBeenCalled();
  });
});
