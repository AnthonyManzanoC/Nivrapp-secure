import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { NIVRA_CALL_PROTOCOL, NIVRA_UPDATE_URL } from '../release';

@Injectable({ providedIn: 'root' })
export class ClientCompatibilityService {
  readonly updateRequired = signal(false);
  readonly message = signal('Hay una nueva versión de Nivra disponible. Actualiza para seguir llamando.');
  readonly updateUrl = NIVRA_UPDATE_URL;
  private readonly http = inject(HttpClient);

  requireUpdate(): void { this.updateRequired.set(true); }

  async check(apiBaseUrl: string): Promise<void> {
    try {
      const status = await firstValueFrom(this.http.get<{ minimumCallProtocol: number }>(`${apiBaseUrl}/client/compatibility`));
      this.updateRequired.set(status.minimumCallProtocol > NIVRA_CALL_PROTOCOL);
    } catch {
      // A network error is not proof of an obsolete client. Protected endpoints
      // still enforce the version and return 426 when an upgrade is necessary.
    }
  }
}
