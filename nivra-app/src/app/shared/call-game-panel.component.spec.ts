import { TestBed } from '@angular/core/testing';
import { CallGamePanelComponent } from './call-game-panel.component';
import { applyCallGameAction, createCallGame } from '../core/games/call-game-engine';

describe('CallGamePanelComponent', () => {
  it('offers three real games and emits a selected game only after connection', async () => {
    await TestBed.configureTestingModule({ imports: [CallGamePanelComponent] }).compileComponents();
    const fixture = TestBed.createComponent(CallGamePanelComponent);
    const component = fixture.componentInstance;
    const created = spyOn(component.create, 'emit');
    fixture.detectChanges();
    const choices = fixture.nativeElement.querySelectorAll('.game-choice') as NodeListOf<HTMLButtonElement>;
    expect(choices.length).toBe(3);
    expect(choices[0].disabled).toBeTrue();
    component.transportReady = true;
    fixture.detectChanges();
    choices[1].click();
    expect(created).toHaveBeenCalledOnceWith('connect-four');
  });

  it('sends versioned moves only for the current player', () => {
    const component = new CallGamePanelComponent();
    let state = createCallGame('tic-tac-toe', 'game', 'host');
    state = applyCallGameAction(state, 'guest', { type: 'join', gameId: 'game', expectedRevision: 0 }).state;
    component.state = applyCallGameAction(state, 'host', { type: 'start', gameId: 'game', expectedRevision: 1 }).state;
    component.transportReady = true;
    component.currentUserId = 'spectator';
    const sent = spyOn(component.action, 'emit');
    component.move(0);
    expect(sent).not.toHaveBeenCalled();
    component.currentUserId = 'host';
    component.move(0);
    expect(sent).toHaveBeenCalledOnceWith({ type: 'move', gameId: 'game', expectedRevision: 2, index: 0 });
  });

  it('keeps closing the panel separate from changing the game or ending the call', async () => {
    await TestBed.configureTestingModule({ imports: [CallGamePanelComponent] }).compileComponents();
    const fixture = TestBed.createComponent(CallGamePanelComponent);
    const closed = spyOn(fixture.componentInstance.closed, 'emit');
    const action = spyOn(fixture.componentInstance.action, 'emit');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.close-game') as HTMLButtonElement).click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps the game text readable when the app uses the light theme', async () => {
    document.body.classList.add('nivra-light-theme');
    try {
      await TestBed.configureTestingModule({ imports: [CallGamePanelComponent] }).compileComponents();
      const fixture = TestBed.createComponent(CallGamePanelComponent);
      fixture.detectChanges();

      const panel = fixture.nativeElement.querySelector('.call-games') as HTMLElement;
      const title = fixture.nativeElement.querySelector('h2') as HTMLElement;
      expect(getComputedStyle(panel).backgroundColor).toBe('rgb(255, 255, 255)');
      expect(getComputedStyle(title).color).toBe('rgb(17, 24, 39)');
    } finally {
      document.body.classList.remove('nivra-light-theme');
    }
  });
});
