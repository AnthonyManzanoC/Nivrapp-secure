import { SignalrService } from './signalr.service';
describe('vault realtime failure visibility', () => {
  it('propagates a rejected room subscription so the UI can recover', async () => {
    const service: any = Object.assign(Object.create(SignalrService.prototype), { ensureConnected: async () => {}, connection: { invoke: jasmine.createSpy().and.rejectWith(new Error('La sala terminó')) } });
    await expectAsync(service.joinVaultRoom('closed-room')).toBeRejectedWithError('La sala terminó');
  });
  it('never reports a successful send without a realtime connection', async () => {
    const service: any = Object.assign(Object.create(SignalrService.prototype), { ensureConnected: async () => {}, connection: null });
    await expectAsync(service.sendVaultRoomMessage('room', { clientMessageId: 'id', kind: 'Text', recipients: [] })).toBeRejected();
  });
});
