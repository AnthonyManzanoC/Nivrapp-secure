import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { EncryptedDownloadService } from './encrypted-download.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { VaultService } from './vault.service';

describe('vault room subscriptions after API replacement', () => {
  it('rejoins the selected room when the replacement hub creates a new connection', () => {
    const events = new Subject<any>();
    const join = jasmine.createSpy('join').and.resolveTo();
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { isAuthenticated: () => false } },
      { provide: ChatService, useValue: {} }, { provide: CryptoService, useValue: {} },
      { provide: NivraApiService, useValue: {} }, { provide: EncryptedDownloadService, useValue: {} },
      { provide: SignalrService, useValue: { events$: events, joinVaultRoom: join } },
    ] });
    const vault = TestBed.inject(VaultService);
    vault.activeRoomId.set('synthetic-room');
    events.next({ type: 'connected', payload: null });
    events.next({ type: 'reconnected', payload: null });
    expect(join.calls.allArgs()).toEqual([['synthetic-room'], ['synthetic-room']]);
    TestBed.resetTestingModule();
  });
});
