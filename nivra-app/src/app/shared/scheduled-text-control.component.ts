import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppLockService } from '../core/services/app-lock.service';
import { QueuedText } from '../core/services/text-outbox.service';
import { localScheduleInput, parseLocalScheduleInput, scheduledMessageTime } from '../core/utils/message-schedule';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-scheduled-text-control', standalone: true, imports: [CommonModule, FormsModule, TranslatePipe],
  template: `
    @if (canSchedule || entries.length) {
      <div class="schedule-row">
        @if (entries.length) {
          <details class="scheduled-list"><summary>{{ 'SCHEDULE.LIST' | translate:'Programados' }} <span>{{ entries.length }}</span></summary>
            <p class="local-copy">{{ 'SCHEDULE.LOCAL_SHORT' | translate:'Guardados en este dispositivo. Se envían con esta cuenta abierta y desbloqueada.' }}</p>
            @for (entry of entries; track entry.id) {
              <article><div><time [attr.datetime]="entry.scheduledFor">{{ dateLabel(entry.scheduledFor!) }}</time><p>{{ entry.payload.text | slice:0:100 }}</p></div>
                <button type="button" (click)="cancelScheduled.emit(entry.id)" [attr.aria-label]="'SCHEDULE.CANCEL_ITEM' | translate:'Cancelar mensaje programado'">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</button>
              </article>
            }
          </details>
        }
        @if (canSchedule) { <button class="schedule-open" type="button" (click)="show()"><span aria-hidden="true">◷</span> {{ 'SCHEDULE.OPEN' | translate:'Programar' }}</button> }
      </div>
    }
    <dialog #scheduleDialog [attr.aria-labelledby]="headingId" (cancel)="close()">
      <form (ngSubmit)="submit()">
        <header><h2 [id]="headingId">{{ 'SCHEDULE.TITLE' | translate:'Programar texto' }}</h2><button type="button" (click)="close()" [attr.aria-label]="'COMMON.CLOSE' | translate:'Cerrar'">×</button></header>
        <p class="explanation">{{ 'SCHEDULE.LOCAL_COPY' | translate:'El texto queda cifrado en este dispositivo. Para enviarlo a la hora elegida, esta cuenta debe estar abierta, desbloqueada y con conexión. Si está cerrada, Nivra lo intentará cuando vuelvas.' }}</p>
        <div class="presets"><button type="button" (click)="delay(10)">10 min</button><button type="button" (click)="delay(60)">1 h</button><button type="button" (click)="tomorrow()">{{ 'SCHEDULE.TOMORROW' | translate:'Mañana, 9:00' }}</button></div>
        <label>{{ 'SCHEDULE.WHEN' | translate:'Fecha y hora local' }}<input type="datetime-local" required name="scheduleAt" [(ngModel)]="localTime" [min]="minimum" [max]="maximum"></label>
        <p class="timezone">{{ zone }} · {{ 'SCHEDULE.TTL' | translate:'La caducidad elegida empieza al preparar el primer envío, no al programarlo.' }}</p>
        @if (error) { <p class="error" role="alert">{{ error }}</p> }
        <footer><button type="button" (click)="close()">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</button><button type="submit" class="confirm" [disabled]="!canSchedule">{{ 'SCHEDULE.CONFIRM' | translate:'Guardar programación' }}</button></footer>
      </form>
    </dialog>
  `,
  styles: [`
    :host{display:block;color:var(--nivra-text)}
    .schedule-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:0 14px 8px}
    button{font:inherit;cursor:pointer;color:var(--nivra-text);background:transparent;border:1px solid var(--nivra-line);border-radius:11px;padding:9px 12px;min-height:42px}
    button:disabled{opacity:.5;cursor:default}.schedule-open{display:flex;gap:6px;align-items:center;margin-left:auto;font-size:12px;border-color:transparent;color:var(--nivra-muted)}
    .schedule-open span{font-size:19px}.scheduled-list{flex:1;min-width:0;padding:8px 0;font-size:12px}.scheduled-list summary{cursor:pointer;color:var(--nivra-brand-2);min-height:26px}.scheduled-list summary span{font-variant-numeric:tabular-nums;margin-left:5px}
    article{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--nivra-line)}article>div{flex:1;min-width:0}article p{margin:4px 0;overflow-wrap:anywhere;color:var(--nivra-muted)}article button{font-size:11px}time{font-size:12px}
    .local-copy{color:var(--nivra-muted);font-size:11px;line-height:1.5}
    dialog{width:min(440px,calc(100vw - 28px));max-height:calc(100dvh - 40px);padding:22px;border:1px solid var(--nivra-line);border-radius:20px;background:var(--nivra-panel-solid);color:var(--nivra-text);box-sizing:border-box;box-shadow:0 20px 70px #0005}
    dialog::backdrop{background:#07151088}header{display:flex;align-items:center;justify-content:space-between;gap:15px}h2{font-size:20px;margin:0}header button{font-size:23px;border:0;padding:4px 9px;min-width:40px}
    .explanation,.timezone{font-size:12px;line-height:1.6;color:var(--nivra-muted)}.presets{display:flex;flex-wrap:wrap;gap:7px;margin:18px 0}.presets button{font-size:12px}label{display:grid;gap:9px;font-size:13px;font-weight:600}
    input{min-width:0;width:100%;box-sizing:border-box;border:1px solid var(--nivra-line);border-radius:11px;background:var(--nivra-bg-3);color:var(--nivra-text);font:inherit;padding:12px;color-scheme:light dark}
    :host-context(.nivra-light-theme) input{color-scheme:light}:host-context(.ion-palette-dark) input{color-scheme:dark}
    footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}footer button{font-size:12px}.confirm{background:var(--nivra-brand);color:var(--nivra-on-brand);border-color:transparent}.error{color:var(--ion-color-danger,#ba4646);font-size:12px}
    :is(button,input,summary):focus-visible{outline:2px solid var(--nivra-brand-2);outline-offset:3px}
  `],
})
export class ScheduledTextControlComponent implements OnChanges, OnDestroy {
  @Input() canSchedule = false;
  @Input() entries: QueuedText[] = [];
  @Input() context = '';
  @Output() schedule = new EventEmitter<number>();
  @Output() cancelScheduled = new EventEmitter<string>();
  @ViewChild('scheduleDialog') dialog?: ElementRef<HTMLDialogElement>;
  private readonly lock = inject(AppLockService);
  private previousContext = '';
  readonly headingId = 'schedule-heading-' + crypto.randomUUID();
  readonly zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  localTime = '';
  minimum = '';
  maximum = '';
  error = '';
  constructor() { effect(() => { if (this.lock.isContentLocked()) untracked(() => this.close()); }); }
  ngOnChanges(): void { if (!this.canSchedule || this.previousContext !== this.context) this.close(); this.previousContext = this.context; }
  ngOnDestroy(): void { this.close(); }
  show(): void {
    if (!this.canSchedule || this.lock.isContentLocked()) return;
    const now = Date.now(); this.localTime = localScheduleInput(now + 3600000);
    this.minimum = localScheduleInput(now + 60000); this.maximum = localScheduleInput(now + 30 * 86400000); this.error = '';
    this.dialog?.nativeElement.showModal();
  }
  close(): void { this.dialog?.nativeElement.close(); this.localTime = ''; this.error = ''; }
  delay(minutes: number): void { this.localTime = localScheduleInput(Date.now() + minutes * 60000); this.error = ''; }
  tomorrow(): void { const date = new Date(Date.now()); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); this.localTime = localScheduleInput(date.getTime()); this.error = ''; }
  submit(): void {
    if (!this.canSchedule || this.lock.isContentLocked()) { this.close(); return; }
    try { const at = parseLocalScheduleInput(this.localTime); scheduledMessageTime(at); this.schedule.emit(at); this.close(); }
    catch (error) { this.error = error instanceof Error ? error.message : 'Elige una fecha y hora válidas.'; }
  }
  dateLabel(value: string): string { return new Intl.DateTimeFormat(undefined, { day:'numeric', month:'short', hour:'numeric', minute:'2-digit' }).format(new Date(value)); }
}
