import { VaultPage } from './vault.page';

describe('temporary chat composer', () => {
  const setup = () => {
    const room = { id: 'temporary', retentionMode: 'BurnOnExit', members: [{ userId: 'me', status: 'Active' }, { userId: 'peer', status: 'Active' }] };
    const vault = { activeRoom: () => room, sending: () => false, roomConnected: () => true, isCurrentUser: (id: string) => id === 'me', sendRoomText: jasmine.createSpy().and.resolveTo(), currentMember: () => ({ status: 'Active' }) };
    const page: any = Object.assign(Object.create(VaultPage.prototype), { vault, roomMessage: 'Primer mensaje', busyId: '', error: '', notice: '', isCurrentPage: () => true, isIncognito: () => true });
    return { page, vault, room };
  };
  it('does not erase the next text typed while an earlier message is sending', async () => {
    const { page, vault } = setup(); let finish!: () => void;
    vault.sendRoomText.and.returnValue(new Promise<void>(resolve => finish = resolve));
    const sending = page.sendMessage(); page.roomMessage = 'Siguiente mensaje'; finish(); await sending;
    expect(vault.sendRoomText).toHaveBeenCalledOnceWith('Primer mensaje'); expect(page.roomMessage).toBe('Siguiente mensaje');
  });
  it('keeps a failed text in memory and allows an explicit retry', async () => {
    const { page, vault } = setup(); vault.sendRoomText.and.rejectWith(new Error('Sin conexión'));
    await page.sendMessage(); expect(page.roomMessage).toBe('Primer mensaje'); expect(page.busyId).toBe('');
    vault.sendRoomText.and.resolveTo(); await page.sendMessage(); expect(page.roomMessage).toBe('');
  });
  it('waits for the other participant and prevents duplicate clicks', async () => {
    const { page, vault, room } = setup(); room.members[1].status = 'Invited'; await page.sendMessage(); expect(vault.sendRoomText).not.toHaveBeenCalled();
    room.members[1].status = 'Active'; let finish!: () => void; vault.sendRoomText.and.returnValue(new Promise<void>(resolve => finish = resolve));
    const sending = page.sendMessage(); await page.sendMessage(); expect(vault.sendRoomText).toHaveBeenCalledTimes(1); finish(); await sending;
  });
});
