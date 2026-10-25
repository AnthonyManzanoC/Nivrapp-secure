import { PushService } from './push.service';

describe('Web Push receipt and notification click', () => {
  let service: any;
  let handled: jasmine.Spy;
  const message = { type: 'message', conversationId: 'private-chat', recipientUserId: 'alice', recipientDeviceId: 'browser-alice' };
  const normalizedMessage = { ...message, tag: 'private-chat' };

  beforeEach(() => {
    service = Object.create(PushService.prototype);
    handled = spyOn(service, 'handlePushData').and.resolveTo();
  });

  it('delivers a visible-window receipt without a navigation intent', () => {
    service.handleServiceWorkerMessage({ type: 'nivra.push.received', intent: 'receive', data: message });
    expect(handled).toHaveBeenCalledOnceWith(normalizedMessage, 'web-fcm');
    expect(handled.calls.first().args[0]['nivraRouteIntent']).toBeUndefined();
  });

  it('discards stale routing markers on explicit reception rather than opening another chat', () => {
    service.handleServiceWorkerMessage({ type: 'nivra.push.received', intent: 'receive', data: { ...message, nivraRouteIntent: 'tap' } });
    expect(handled).toHaveBeenCalledOnceWith(normalizedMessage, 'web-fcm');
  });

  it('preserves navigation only for an actual worker notification click', () => {
    service.handleServiceWorkerMessage({ type: 'nivra.push', intent: 'click', data: message });
    expect(handled).toHaveBeenCalledOnceWith({ ...normalizedMessage, nivraRouteIntent: 'tap' }, 'service-worker-click');
  });

  it('keeps real clicks from the previous worker working while upgrading', () => {
    service.handleServiceWorkerMessage({ type: 'nivra.push', data: { ...message, nivraRouteIntent: 'tap' } });
    expect(handled).toHaveBeenCalledOnceWith({ ...normalizedMessage, nivraRouteIntent: 'tap' }, 'service-worker-click');
  });

  it('treats an unmarked message from the previous worker as receipt', () => {
    service.handleServiceWorkerMessage({ type: 'nivra.push', data: message });
    expect(handled).toHaveBeenCalledOnceWith(normalizedMessage, 'web-fcm');
  });

  it('cannot promote a receipt event to navigation through payload markers', () => {
    service.handleServiceWorkerMessage({ type: 'nivra.push.received', intent: 'click', data: { ...message, nivraRouteIntent: 'tap' } });
    expect(handled).toHaveBeenCalledOnceWith(normalizedMessage, 'web-fcm');
  });

  it('ignores unrelated worker messages', () => {
    service.handleServiceWorkerMessage(null);
    service.handleServiceWorkerMessage({ type: 'other', intent: 'click', data: message });
    expect(handled).not.toHaveBeenCalled();
  });
});
