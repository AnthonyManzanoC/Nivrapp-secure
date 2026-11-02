import { Directive, EventEmitter, HostBinding, HostListener, Input, OnChanges, OnDestroy, Output } from '@angular/core';

/** Expire action feedback without changing the workflow/error state behind it. */
@Directive({selector:'[appTransientNotice]',standalone:true})
export class TransientNoticeDirective implements OnChanges, OnDestroy {
  @Input() appTransientNotice: unknown;
  @Input() appNoticeDuration = 8000;
  @Output() noticeExpired = new EventEmitter<void>();
  @HostBinding('attr.data-notice-expired') expired: 'true' | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private remaining = 0;
  private started = 0;
  private hovered = false;
  private focused = false;

  ngOnChanges(): void {
    this.clearTimer(); this.expired = null;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.remaining = Math.min(30000,Math.max(3000,Number(this.appNoticeDuration) || 8000));
    // Reading can pause the short timer, but feedback must never remain forever.
    if (this.appTransientNotice) this.deadline = setTimeout(() => this.expire(),30000);
    if (this.appTransientNotice && !this.hovered && !this.focused) this.resume();
  }
  ngOnDestroy(): void { this.clearTimer(); if (this.deadline !== null) clearTimeout(this.deadline); }
  @HostListener('mouseenter') enter(): void { this.hovered = true; this.pause(); }
  @HostListener('mouseleave') leave(): void { this.hovered = false; if (!this.focused) this.resume(); }
  @HostListener('focusin') focus(): void { this.focused = true; this.pause(); }
  @HostListener('focusout') blur(): void { this.focused = false; if (!this.hovered) this.resume(); }
  private pause(): void {
    if (this.timer !== null) this.remaining = Math.max(0,this.remaining-(Date.now()-this.started));
    this.clearTimer();
  }
  private resume(): void {
    if (this.timer !== null || this.expired || !this.appTransientNotice) return;
    this.started = Date.now();
    this.timer = setTimeout(() => this.expire(),this.remaining);
  }
  private expire(): void {
    if (this.expired) return;
    this.clearTimer(); if (this.deadline !== null) clearTimeout(this.deadline); this.deadline = null;
    this.expired = 'true'; this.noticeExpired.emit();
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
}
