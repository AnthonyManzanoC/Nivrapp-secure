import { SimpleChange, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '../../core/services/translate.service';
import { CHAT_EMOJIS, CHAT_STICKERS } from './chat-expression.data';
import { CHAT_EXPRESSION_RECENTS_KEY, CHAT_EXPRESSION_RECENTS_LIMIT, ChatExpressionPickerComponent, createStickerPng } from './chat-expression-picker.component';

describe('Local chat expression picker', () => {
  let picker: ChatExpressionPickerComponent;
  let previous: string | null;

  beforeEach(() => {
    previous = localStorage.getItem(CHAT_EXPRESSION_RECENTS_KEY);
    localStorage.removeItem(CHAT_EXPRESSION_RECENTS_KEY);
    TestBed.configureTestingModule({ providers: [
      { provide: TranslateService, useValue: { currentLanguage: signal('es'), instant: (_key: string, fallback: string) => fallback } },
    ] });
    picker = TestBed.runInInjectionContext(() => new ChatExpressionPickerComponent());
  });

  afterEach(() => {
    picker.ngOnDestroy();
    if (previous === null) localStorage.removeItem(CHAT_EXPRESSION_RECENTS_KEY);
    else localStorage.setItem(CHAT_EXPRESSION_RECENTS_KEY, previous);
  });

  it('searches the whole catalog in Spanish and English regardless of selected category', () => {
    picker.category = 'food';
    picker.query = 'LAGRIMAS de risa';
    expect(picker.emojis.map((item) => item.value)).toEqual(['😂']);
    picker.query = 'heart green';
    expect(picker.emojis.map((item) => item.value)).toEqual(['💚']);
    picker.query = 'cafe';
    expect(picker.emojis.map((item) => item.value)).toEqual(['☕']);
    picker.query = 'coffee';
    expect(picker.emojis.map((item) => item.value)).toEqual(['☕']);
    picker.query = 'xyz-no-such-emoji';
    expect(picker.emojis).toEqual([]);
  });

  it('searches stickers using bilingual names and aliases without a remote service', () => {
    picker.selectTab('sticker');
    picker.query = 'café';
    expect(picker.stickers.map((item) => item.id)).toEqual(['coffee']);
    picker.query = 'big hug';
    expect(picker.stickers.map((item) => item.id)).toEqual(['hug']);
    picker.query = 'lol';
    expect(picker.stickers.map((item) => item.id)).toEqual(['laugh']);
  });

  it('emits an emoji for draft insertion without emitting a sticker or closing', () => {
    const emoji = spyOn(picker.emojiSelected, 'emit');
    const sticker = spyOn(picker.stickerSelected, 'emit');
    const closed = spyOn(picker.closed, 'emit');
    picker.selectEmoji(CHAT_EMOJIS[0]);
    expect(emoji).toHaveBeenCalledOnceWith('😀');
    expect(sticker).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it('deduplicates and bounds recents and persists only expression IDs', () => {
    CHAT_EMOJIS.slice(0, 32).forEach((item) => picker.selectEmoji(item));
    picker.selectEmoji(CHAT_EMOJIS[12]);
    expect(picker.recentEmojis.length).toBe(CHAT_EXPRESSION_RECENTS_LIMIT);
    expect(picker.recentEmojis[0]).toBe(CHAT_EMOJIS[12].value);
    expect(picker.recentEmojis.filter((value) => value === CHAT_EMOJIS[12].value).length).toBe(1);
    const stored = JSON.parse(localStorage.getItem(CHAT_EXPRESSION_RECENTS_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(['emojis', 'stickers']);
    expect(stored.emojis).toEqual(picker.recentEmojis);
    const reopened = TestBed.runInInjectionContext(() => new ChatExpressionPickerComponent());
    expect(reopened.category).toBe('recent');
    expect(reopened.emojis.map((item) => item.value)).toEqual(picker.recentEmojis);
    reopened.ngOnDestroy();
  });

  it('ignores invalid stored entries and survives malformed or unavailable storage', () => {
    localStorage.setItem(CHAT_EXPRESSION_RECENTS_KEY, JSON.stringify({ emojis: ['😀', 'anything', '😀', null], stickers: ['love', '<svg>evil</svg>', 7, 'love'] }));
    const reopened = TestBed.runInInjectionContext(() => new ChatExpressionPickerComponent());
    expect(reopened.recentEmojis).toEqual(['😀']);
    expect(reopened.recentStickers).toEqual(['love']);
    reopened.ngOnDestroy();
    localStorage.setItem(CHAT_EXPRESSION_RECENTS_KEY, '{broken');
    const malformed = TestBed.runInInjectionContext(() => new ChatExpressionPickerComponent());
    expect(malformed.recentEmojis).toEqual([]);
    malformed.ngOnDestroy();
    const storage = spyOn(Storage.prototype, 'setItem').and.throwError('unavailable');
    const selected = spyOn(picker.emojiSelected, 'emit');
    expect(() => picker.selectEmoji(CHAT_EMOJIS[0])).not.toThrow();
    expect(selected).toHaveBeenCalledWith('😀');
    storage.and.callThrough();
  });

  it('clears recents on explicit request without changing the current search', () => {
    picker.selectEmoji(CHAT_EMOJIS[0]);
    picker.query = 'hello';
    picker.clearRecents();
    expect(picker.recentEmojis).toEqual([]);
    expect(picker.recentStickers).toEqual([]);
    expect(localStorage.getItem(CHAT_EXPRESSION_RECENTS_KEY)).toBeNull();
    expect(picker.query).toBe('hello');
  });

  it('emits a prepared image on explicit sticker selection without touching emoji output', async () => {
    const file = new File(['png'], 'sticker.png', { type: 'image/png' });
    spyOn<any>(picker, 'createStickerFile').and.resolveTo(file);
    const emitted = spyOn(picker.stickerSelected, 'emit');
    const emoji = spyOn(picker.emojiSelected, 'emit');
    await picker.selectSticker(CHAT_STICKERS[1]);
    expect(emitted).toHaveBeenCalledOnceWith(file);
    expect(emoji).not.toHaveBeenCalled();
    expect(picker.recentStickers).toEqual(['love']);
    expect(picker.busy).toBeFalse();
  });

  it('reports failed or empty sticker conversion without emitting an empty attachment', async () => {
    const render = spyOn<any>(picker, 'createStickerFile').and.rejectWith(new Error('Canvas unavailable'));
    const emitted = spyOn(picker.stickerSelected, 'emit');
    await picker.selectSticker(CHAT_STICKERS[0]);
    expect(emitted).not.toHaveBeenCalled();
    expect(picker.error).toContain('No se pudo preparar');
    expect(picker.recentStickers).toEqual([]);
    render.and.resolveTo(new File([], 'empty.png', { type: 'image/png' }));
    await picker.selectSticker(CHAT_STICKERS[0]);
    expect(emitted).not.toHaveBeenCalled();
    expect(picker.busy).toBeFalse();
  });

  it('ignores taps while disabled and suppresses preparation completing after close', async () => {
    const emoji = spyOn(picker.emojiSelected, 'emit');
    const emitted = spyOn(picker.stickerSelected, 'emit');
    picker.disabled = true;
    picker.selectEmoji(CHAT_EMOJIS[0]);
    await picker.selectSticker(CHAT_STICKERS[0]);
    expect(emoji).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
    picker.disabled = false;
    let resolve!: (file: File) => void;
    const pending = new Promise<File>((done) => resolve = done);
    const render = spyOn<any>(picker, 'createStickerFile').and.returnValue(pending);
    const first = picker.selectSticker(CHAT_STICKERS[0]);
    await picker.selectSticker(CHAT_STICKERS[1]);
    expect(render).toHaveBeenCalledTimes(1);
    picker.close();
    resolve(new File(['png'], 'sticker.png', { type: 'image/png' }));
    await first;
    expect(emitted).not.toHaveBeenCalled();
    expect(picker.recentStickers).toEqual([]);
  });

  it('suppresses delayed results after destruction or permission changes', async () => {
    let resolve!: (file: File) => void;
    spyOn<any>(picker, 'createStickerFile').and.returnValue(new Promise<File>((done) => resolve = done));
    const emitted = spyOn(picker.stickerSelected, 'emit');
    const pending = picker.selectSticker(CHAT_STICKERS[0]);
    picker.disabled = true;
    picker.ngOnChanges({ disabled: new SimpleChange(false, true, false) });
    picker.ngOnDestroy();
    resolve(new File(['png'], 'sticker.png', { type: 'image/png' }));
    await pending;
    expect(emitted).not.toHaveBeenCalled();
    expect(picker.recentStickers).toEqual([]);
  });

  it('allows draft emoji insertion while editing but prevents sticker sending and delayed conversion', async () => {
    const emoji = spyOn(picker.emojiSelected, 'emit');
    const emitted = spyOn(picker.stickerSelected, 'emit');
    picker.stickersDisabled = true;
    picker.selectEmoji(CHAT_EMOJIS[0]);
    await picker.selectSticker(CHAT_STICKERS[0]);
    expect(emoji).toHaveBeenCalledWith('😀');
    expect(emitted).not.toHaveBeenCalled();
    picker.stickersDisabled = false;
    let resolve!: (file: File) => void;
    spyOn<any>(picker, 'createStickerFile').and.returnValue(new Promise<File>((done) => resolve = done));
    const pending = picker.selectSticker(CHAT_STICKERS[0]);
    picker.stickersDisabled = true;
    picker.ngOnChanges({ stickersDisabled: new SimpleChange(false, true, false) });
    resolve(new File(['png'], 'sticker.png', { type: 'image/png' }));
    await pending;
    expect(emitted).not.toHaveBeenCalled();
  });

  it('switches accessible tabs with arrow keys and closes with Escape', () => {
    const prevent = jasmine.createSpy('preventDefault');
    picker.onTabKey({ key: 'ArrowRight', preventDefault: prevent, target: document.createElement('button') } as unknown as KeyboardEvent);
    expect(picker.tab).toBe('sticker');
    expect(prevent).toHaveBeenCalledTimes(1);
    const closed = spyOn(picker.closed, 'emit');
    picker.onEscape({ preventDefault: prevent, stopPropagation: jasmine.createSpy('stopPropagation') } as unknown as KeyboardEvent);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('renders the original vector artwork into a real transparent PNG attachment', async () => {
    const file = await createStickerPng(CHAT_STICKERS[0]);
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('nivra-sticker-joy.png');
    expect(file.size).toBeGreaterThan(1000);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const image = await createImageBitmap(file);
    expect(image.width).toBe(384);
    expect(image.height).toBe(384);
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 384;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
    expect(context.getImageData(192, 192, 1, 1).data[3]).toBe(255);
    image.close();
  });
});
