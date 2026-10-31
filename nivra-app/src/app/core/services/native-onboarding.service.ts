import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';

const ONBOARDING_KEY = 'nivra.nativeOnboarding.v1';

@Injectable({ providedIn: 'root' })
export class NativeOnboardingService {
  private completedInMemory = false;

  isPackagedApp(): boolean {
    return Capacitor.isNativePlatform()
      || (typeof window !== 'undefined' && 'nivraSecureVault' in window);
  }

  isComplete(): boolean {
    if (this.completedInMemory) return true;
    try {
      return localStorage.getItem(ONBOARDING_KEY) === 'complete';
    } catch {
      return false;
    }
  }

  complete(): void {
    // Keep navigation working even when this device refuses persistent storage.
    this.completedInMemory = true;
    try {
      localStorage.setItem(ONBOARDING_KEY, 'complete');
    } catch {
      // The welcome may appear next launch, but can be dismissed this session.
    }
  }

  restart(): void {
    this.completedInMemory = false;
    try { localStorage.removeItem(ONBOARDING_KEY); } catch { /* Memory still follows this logout. */ }
  }
}
