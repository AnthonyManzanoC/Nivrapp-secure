import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateService } from '../../core/services/translate.service';
import { CHAT_EMOJIS, CHAT_STICKERS, ChatEmoji, ChatSticker, EMOJI_CATEGORIES, EmojiCategoryId, matchesExpression } from './chat-expression.data';

export const CHAT_EXPRESSION_RECENTS_KEY = 'nivra.chat-expression.recents.v1';
export const CHAT_EXPRESSION_RECENTS_LIMIT = 24;
type ExpressionTab = 'emoji' | 'sticker';

/** Converts only the bundled original artwork. No message text, account data or remote media is involved. */
export function createStickerPng(sticker: ChatSticker): Promise<File> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (!context) { reject(new Error('Canvas unavailable')); return; }
    const source = URL.createObjectURL(new Blob([sticker.svg], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    let settled = false;
    const cleanup = () => { window.clearTimeout(timeout); URL.revokeObjectURL(source); image.onload = null; image.onerror = null; };
    const fail = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Sticker conversion failed')); };
    const timeout = window.setTimeout(fail, 15000);
    image.onerror = fail;
    image.onload = () => {
      try {
        context.drawImage(image, 0, 0, 384, 384);
        canvas.toBlob((blob) => {
          if (settled) return;
          if (!blob?.size || blob.type !== 'image/png') { fail(); return; }
          settled = true;
          cleanup();
          resolve(new File([blob], `nivra-sticker-${sticker.id}.png`, { type: 'image/png' }));
        }, 'image/png');
      } catch { fail(); }
    };
    image.src = source;
  });
}

@Component({
  selector: 'app-chat-expression-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-expression-picker.component.html',
  styleUrls: ['./chat-expression-picker.component.scss'],
})
export class ChatExpressionPickerComponent implements OnChanges, OnDestroy {
  private readonly translate = inject(TranslateService);
  @Input() disabled = false;
  @Input() stickersDisabled = false;
  @Output() emojiSelected = new EventEmitter<string>();
  @Output() stickerSelected = new EventEmitter<File>();
  @Output() closed = new EventEmitter<void>();

  readonly categories = EMOJI_CATEGORIES;
  tab: ExpressionTab = 'emoji';
  category: EmojiCategoryId | 'recent' = 'faces';
  stickerCategory: 'all' | 'recent' = 'all';
  query = '';
  busy = false;
  error = '';
  recentEmojis: string[] = [];
  recentStickers: string[] = [];
  private destroyed = false;
  private generation = 0;

  constructor() {
    this.restoreRecents();
    if (this.recentEmojis.length) this.category = 'recent';
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['disabled']?.currentValue === true || changes['stickersDisabled']?.currentValue === true) { this.generation++; this.busy = false; }
  }

  ngOnDestroy(): void { this.destroyed = true; this.generation++; }

  t(key: string, fallback: string): string { return this.translate.instant(`CHAT_EXPRESSION.${key}`, fallback); }
  name(item: { es: string; en: string }): string { return this.translate.currentLanguage().startsWith('es') ? item.es : item.en; }

  get emojis(): readonly ChatEmoji[] {
    if (this.query.trim()) return CHAT_EMOJIS.filter((item) => matchesExpression(item, this.query));
    if (this.category === 'recent') return this.recentEmojis.map((value) => CHAT_EMOJIS.find((item) => item.value === value)!).filter(Boolean);
    return CHAT_EMOJIS.filter((item) => item.category === this.category);
  }

  get stickers(): readonly ChatSticker[] {
    if (this.query.trim()) return CHAT_STICKERS.filter((item) => matchesExpression(item, this.query));
    if (this.stickerCategory === 'recent') return this.recentStickers.map((id) => CHAT_STICKERS.find((item) => item.id === id)!).filter(Boolean);
    return CHAT_STICKERS;
  }

  get sectionLabel(): string {
    if (this.query.trim()) return this.t('RESULTS', 'Resultados');
    if (this.tab === 'sticker') return this.stickerCategory === 'recent' ? this.t('RECENT', 'Recientes') : this.t('STICKER_PACK', 'Momentos Nivra');
    if (this.category === 'recent') return this.t('RECENT', 'Recientes');
    const item = this.categories.find((entry) => entry.id === this.category)!;
    return this.t(`CATEGORY_${item.id.toUpperCase()}`, item.es);
  }

  selectTab(tab: ExpressionTab): void { this.tab = tab; this.error = ''; }
  selectCategory(category: EmojiCategoryId | 'recent'): void { this.category = category; this.query = ''; }
  selectStickerCategory(category: 'all' | 'recent'): void { this.stickerCategory = category; this.query = ''; }
  clearSearch(): void { this.query = ''; }

  selectEmoji(emoji: ChatEmoji): void {
    if (this.disabled || this.busy || this.destroyed || !CHAT_EMOJIS.some((item) => item.value === emoji.value)) return;
    this.recentEmojis = [emoji.value, ...this.recentEmojis.filter((value) => value !== emoji.value)].slice(0, CHAT_EXPRESSION_RECENTS_LIMIT);
    this.persistRecents();
    // The parent inserts this into its draft; choosing an emoji must never send that draft.
    this.emojiSelected.emit(emoji.value);
  }

  async selectSticker(sticker: ChatSticker): Promise<void> {
    if (this.disabled || this.stickersDisabled || this.busy || this.destroyed) return;
    const artwork = CHAT_STICKERS.find((item) => item.id === sticker.id);
    if (!artwork) return;
    this.busy = true;
    this.error = '';
    const generation = ++this.generation;
    try {
      const file = await this.createStickerFile(artwork);
      if (this.destroyed || this.disabled || this.stickersDisabled || generation !== this.generation) return;
      if (!file.size || file.type !== 'image/png') throw new Error('Invalid sticker');
      this.recentStickers = [artwork.id, ...this.recentStickers.filter((id) => id !== artwork.id)].slice(0, CHAT_EXPRESSION_RECENTS_LIMIT);
      this.persistRecents();
      this.stickerSelected.emit(file);
    } catch {
      if (!this.destroyed && generation === this.generation) this.error = this.t('STICKER_ERROR', 'No se pudo preparar el sticker. Inténtalo de nuevo.');
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }

  close(): void { this.generation++; this.busy = false; this.closed.emit(); }

  @HostListener('keydown.escape', ['$event'])
  onEscape(event: KeyboardEvent): void { event.preventDefault(); event.stopPropagation(); this.close(); }

  clearRecents(): void {
    this.recentEmojis = [];
    this.recentStickers = [];
    try { localStorage.removeItem(CHAT_EXPRESSION_RECENTS_KEY); } catch { /* Storage may be unavailable in private browsing. */ }
  }

  trackEmoji(_index: number, item: ChatEmoji): string { return item.value; }
  trackSticker(_index: number, item: ChatSticker): string { return item.id; }

  onTabKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    this.selectTab(event.key === 'Home' ? 'emoji' : event.key === 'End' ? 'sticker' : this.tab === 'emoji' ? 'sticker' : 'emoji');
    const list = (event.target as HTMLElement).closest('[role="tablist"]');
    list?.querySelector<HTMLElement>(`[data-tab="${this.tab}"]`)?.focus();
  }

  onGridKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    const grid = target.closest('.expression-grid');
    if (!grid) return;
    const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + step));
    event.preventDefault();
    buttons[next]?.focus();
  }

  private createStickerFile(sticker: ChatSticker): Promise<File> { return createStickerPng(sticker); }

  private restoreRecents(): void {
    try {
      const raw = localStorage.getItem(CHAT_EXPRESSION_RECENTS_KEY);
      if (!raw || raw.length > 12000) return;
      const stored = JSON.parse(raw) as { emojis?: unknown; stickers?: unknown };
      this.recentEmojis = this.validRecents(stored?.emojis, new Set(CHAT_EMOJIS.map((item) => item.value)));
      this.recentStickers = this.validRecents(stored?.stickers, new Set(CHAT_STICKERS.map((item) => item.id)));
    } catch { /* Malformed or unavailable storage cannot prevent opening the picker. */ }
  }

  private validRecents(value: unknown, allowed: Set<string>): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && allowed.has(item)))].slice(0, CHAT_EXPRESSION_RECENTS_LIMIT) : [];
  }

  private persistRecents(): void {
    try { localStorage.setItem(CHAT_EXPRESSION_RECENTS_KEY, JSON.stringify({ emojis: this.recentEmojis, stickers: this.recentStickers })); }
    catch { /* Recents are optional; selecting an expression still works. */ }
  }
}
