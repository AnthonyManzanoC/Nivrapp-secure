import { Injectable, signal } from '@angular/core';

/** Overlay leases restore the current page theme after the last viewer closes. */
@Injectable({ providedIn: 'root' })
export class SystemUiService {
  readonly darkOverlay = signal(false);
  private readonly leases = new Set<symbol>();
  acquireDarkOverlay(): () => void {
    const lease = Symbol();
    this.leases.add(lease);
    this.darkOverlay.set(true);
    return () => { this.leases.delete(lease); this.darkOverlay.set(this.leases.size > 0); };
  }
}
