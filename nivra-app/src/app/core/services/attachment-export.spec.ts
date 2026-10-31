import { signal } from '@angular/core';
import { ChatService } from './chat.service';
import { ChatDetailPage } from '../../features/chat-detail/chat-detail.page';

describe('explicit attachment saving', () => {
  function harness() {
    const session = signal<any>({ user: { id: 'alice', alias: 'alice' }, device: { id: 'phone' } });
    const saveBlob = jasmine.createSpy('saveBlob').and.resolveTo({ public: true });
    const service: any = Object.assign(Object.create(ChatService.prototype), {
      auth: { session }, nativeDevice: { native: true, saveBlob },
      ensureMediaPreview: jasmine.createSpy().and.resolveTo({ url: 'blob:local-test' }),
      asFile: () => ({ type: 'file' }), fileMime: () => 'image/png', fileName: () => 'photo.png',
    });
    return { service, session, saveBlob };
  }
  it('saves an explicitly requested copy publicly without requiring automatic gallery saving', async () => {
    const { service, session, saveBlob } = harness();
    const blob = new Blob(['photo'], { type: 'image/png' });
    spyOn(window, 'fetch').and.resolveTo(new Response(blob));
    await service.downloadAttachment({ type: 'file' }, null, true);
    expect(saveBlob).toHaveBeenCalledOnceWith(jasmine.any(Blob), 'photo.png', 'image/png', true, 'image', jasmine.any(Function));
    const guard = saveBlob.calls.first().args[5]; expect(guard()).toBeTrue();
    session.set({ user: { id: 'bob' }, device: { id: 'phone-bob' } }); expect(guard()).toBeFalse();
  });
  it('does not save a decrypted file after switching accounts during blob retrieval', async () => {
    const { service, session, saveBlob } = harness();
    let resolve!: (response: Response) => void;
    const fetchSpy = spyOn(window, 'fetch').and.returnValue(new Promise<Response>(done => resolve = done));
    const saving = service.downloadAttachment({ type: 'file' }, null, true);
    for (let i = 0; i < 4 && !fetchSpy.calls.count(); i++) await Promise.resolve();
    session.set({ user: { id: 'bob' }, device: { id: 'phone-bob' } });
    resolve(new Response(new Blob(['private']))); await saving;
    expect(saveBlob).not.toHaveBeenCalled();
  });
  it('keeps protected attachments out of the export path', async () => {
    const downloadAttachment = jasmine.createSpy('download');
    const page: any = Object.assign(Object.create(ChatDetailPage.prototype), {
      isPendingViewOnce: () => false, canExportMessage: () => false,
      chat: { downloadAttachment }, translate: { instant: (_: string, fallback: string) => fallback },
    });
    await page.download({ id: 'protected' });
    expect(downloadAttachment).not.toHaveBeenCalled(); expect(page.attachmentError).toContain('privacidad');
  });
});
