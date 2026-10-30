import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { TranslateService } from '../../core/services/translate.service';
import { AttachmentReviewComponent, AttachmentReviewItem } from './attachment-review.component';
import { ChatDetailPage } from './chat-detail.page';

const item = (id: number, file = new File(['photo'], 'photo.png', { type: 'image/png' })): AttachmentReviewItem => ({ id, file, originalFile: file, url: URL.createObjectURL(file) });

describe('Attachment review files and upload boundaries', () => {
  let page: ChatDetailPage;
  let internal: any;
  let sendFile: jasmine.Spy;
  let generationScope: { user: { id: string }; device: { id: string } };
  beforeEach(() => {
    page = Object.create(ChatDetailPage.prototype);
    internal = page;
    generationScope = { user: { id: 'me' }, device: { id: 'phone' } };
    sendFile = jasmine.createSpy('sendFile').and.resolveTo({ id: 'sent' });
    Object.assign(page, {
      auth: { session: () => generationScope }, chat: { sendFile, uploading: () => false, sendTyping: jasmine.createSpy().and.resolveTo() },
      conversation: () => ({ id: 'chat' }), canSendMessages: () => true, isBlocked: () => false,
      currentPolicy: () => ({ ttlSeconds: null }), scrollBottom: jasmine.createSpy(),
      composerGeneration: 0, destroyed: false, sending: false, attachmentError: '',
      pendingAttachmentFiles: [], pendingAttachmentCaption: '', pendingAttachmentDraftSeed: '', pendingAttachmentSequence: 0,
      draft: 'mensaje de las fotos', tr: (_key: string, fallback: string) => fallback,
    });
  });
  afterEach(() => internal.clearPendingAttachments(false));

  it('appends photos without losing the selection or caption and assigns stable unique identities', () => {
    internal.preparePendingAttachments([new File(['one'], 'same.png', { type: 'image/png' })], 'media');
    const first = page.pendingAttachmentFiles[0];
    page.pendingAttachmentCaption = 'Mi caption';
    internal.preparePendingAttachments([new File(['two'], 'same.png', { type: 'image/png' })], 'media');
    expect(page.pendingAttachmentFiles[0]).toBe(first);
    expect(page.pendingAttachmentFiles[1].id).not.toBe(first.id);
    expect(page.pendingAttachmentCaption).toBe('Mi caption');
  });

  it('releases old preview URLs on edit and keeps the original for restoration', () => {
    const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();
    internal.preparePendingAttachments([new File(['one'], 'photo.png', { type: 'image/png' })], 'media');
    const initial = page.pendingAttachmentFiles[0];
    const edited = new File(['changed'], 'photo.jpg', { type: 'image/jpeg' });
    page.replacePendingAttachment({ id: initial.id, file: edited });
    expect(revoke).toHaveBeenCalledWith(initial.url!);
    expect(page.pendingAttachmentFiles[0].originalFile).toBe(initial.file);
    page.replacePendingAttachment({ id: initial.id, file: initial.originalFile });
    expect(page.pendingAttachmentFiles[0].file).toBe(initial.file);
  });

  it('removes a photo and revokes every remaining local URL on navigation cleanup', () => {
    const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();
    internal.preparePendingAttachments([new File(['one'], '1.png', { type: 'image/png' }), new File(['two'], '2.png', { type: 'image/png' })], 'media');
    const urls = page.pendingAttachmentFiles.map(value => value.url);
    page.removePendingAttachment(page.pendingAttachmentFiles[0].id);
    expect(page.pendingAttachmentFiles.length).toBe(1);
    internal.clearPendingAttachments(false);
    urls.forEach(url => expect(revoke).toHaveBeenCalledWith(url!));
    expect(page.pendingAttachmentFiles).toEqual([]);
  });

  it('keeps only failed files for retry and does not resend successful attachments', async () => {
    const first = new File(['one'], '1.pdf', { type: 'application/pdf' });
    const second = new File(['two'], '2.pdf', { type: 'application/pdf' });
    internal.preparePendingAttachments([first, second], 'document');
    sendFile.and.callFake(async (_conversation, file) => {
      if (file === first) throw new Error('sin conexión');
      return { id: 'ok' };
    });
    await page.sendPendingAttachments();
    expect(page.pendingAttachmentFiles.map(value => value.file)).toEqual([first]);
    expect(page.attachmentError).toBe('sin conexión');
    expect(page.pendingAttachmentCaption).toBe('');
    sendFile.calls.reset();
    sendFile.and.resolveTo({ id: 'retry' });
    await page.sendPendingAttachments();
    expect(sendFile).toHaveBeenCalledOnceWith(jasmine.objectContaining({ id: 'chat' }), first, jasmine.any(Object));
    expect(page.pendingAttachmentFiles).toEqual([]);
  });

  it('stops a multi-file batch after the session changes', async () => {
    let resolve!: (value: unknown) => void;
    sendFile.and.returnValue(new Promise(done => resolve = done));
    internal.preparePendingAttachments([new File(['1'], '1.pdf'), new File(['2'], '2.pdf')], 'document');
    const pending = page.sendPendingAttachments();
    generationScope = { user: { id: 'new' }, device: { id: 'new' } };
    page.attachmentError = 'nuevo estado';
    resolve({ id: 'old' });
    await pending;
    expect(sendFile).toHaveBeenCalledTimes(1);
    expect(page.attachmentError).toBe('nuevo estado');
  });

  it('explains a provider quota refusal and retains the selected files and caption for retry', async () => {
    const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    internal.preparePendingAttachments([file], 'media'); page.pendingAttachmentCaption = 'Mi historia';
    sendFile.and.rejectWith({ status: 402, error: { code: 'storage_payment_required', message: 'private provider details' } });
    await page.sendPendingAttachments();
    expect(page.attachmentError).toContain('cuota o facturación');
    expect(page.attachmentError).not.toContain('private provider');
    expect(page.pendingAttachmentFiles.map(item => item.file)).toEqual([file]);
    expect(page.pendingAttachmentCaption).toBe('Mi historia'); expect(page.sending).toBeFalse();
    sendFile.and.resolveTo({ id: 'restored' }); await page.sendPendingAttachments();
    expect(page.pendingAttachmentFiles).toEqual([]);
  });
});

describe('Attachment image edits', () => {
  let component: AttachmentReviewComponent;
  const decode = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } finally { URL.revokeObjectURL(url); }
  };
  const picture = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 100, 100);
    context.fillStyle = '#0000ff'; context.fillRect(100, 0, 100, 100);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(result => resolve(result!), 'image/png'));
    return new File([blob], 'photo.png', { type: 'image/png' });
  };
  beforeEach(() => component = new AttachmentReviewComponent());
  afterEach(() => { component.items.forEach(value => { if (value.url) URL.revokeObjectURL(value.url); }); component.ngOnDestroy(); });

  it('rotates the actual pixels and swaps the image dimensions', async () => {
    component.items = [item(1, await picture())];
    component.ngOnChanges();
    const replace = spyOn(component.replaced, 'emit');
    await component.editImage('rotate');
    const output = await decode(replace.calls.mostRecent().args[0]!.file);
    expect(output.naturalWidth).toBe(100);
    expect(output.naturalHeight).toBe(200);
    expect(component.items[0].file).toBe(component.items[0].originalFile);
    expect(component.processing).toBeFalse();
  });

  it('exports the chosen crop rather than the whole image', async () => {
    component.items = [item(1, await picture())];
    component.ngOnChanges();
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 100 });
    (component as any).cropFrame = new ElementRef(frame);
    component.cropX = 50;
    const replace = spyOn(component.replaced, 'emit');
    await component.editImage('crop');
    const output = await decode(replace.calls.mostRecent().args[0]!.file);
    expect(output.naturalWidth).toBe(100);
    expect(output.naturalHeight).toBe(100);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(output, 0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    expect(pixel[0]).toBeGreaterThan(240);
    expect(pixel[2]).toBeLessThan(10);
  });

  it('preserves the original on decode failure and releases the temporary URL', async () => {
    component.items = [item(1)];
    component.ngOnChanges();
    const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();
    const replace = spyOn(component.replaced, 'emit');
    await component.editImage('rotate');
    expect(replace).not.toHaveBeenCalled();
    expect(component.editError).toBe('CHAT.ERROR_EDIT_IMAGE');
    expect(component.processing).toBeFalse();
    expect(revoke).toHaveBeenCalled();
  });

  it('does not flatten animated GIFs or edit SVGs', () => {
    expect(component.editable(item(1, new File(['gif'], 'animated.gif', { type: 'image/gif' })))).toBeFalse();
    expect(component.editable(item(2, new File(['svg'], 'image.svg', { type: 'image/svg+xml' })))).toBeFalse();
  });
});

describe('Attachment review renderer', () => {
  beforeEach(() => TestBed.configureTestingModule({
    imports: [AttachmentReviewComponent],
    providers: [provideIonicAngular({ animated: false }), { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } }],
  }));

  it('renders a real large image and a selectable thumbnail rail', () => {
    const fixture = TestBed.createComponent(AttachmentReviewComponent);
    const first = item(1);
    const second = item(2);
    fixture.componentRef.setInput('items', [first, second]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img.full-image').src).toBe(first.url);
    const buttons = fixture.nativeElement.querySelectorAll('button.thumbnail') as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(2);
    buttons[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()?.id).toBe(2);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    fixture.destroy();
    URL.revokeObjectURL(first.url!); URL.revokeObjectURL(second.url!);
  });

  it('renders playable video and disables sending during an unapplied crop', () => {
    const fixture = TestBed.createComponent(AttachmentReviewComponent);
    const video = item(1, new File(['video'], 'video.mp4', { type: 'video/mp4' }));
    fixture.componentRef.setInput('items', [video]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('video.full-video').controls).toBeTrue();
    fixture.componentInstance.editing = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.send-button').disabled).toBeTrue();
    fixture.destroy(); URL.revokeObjectURL(video.url!);
  });
});
