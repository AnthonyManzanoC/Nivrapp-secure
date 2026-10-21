import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowForwardOutline, chatbubbleOutline, globeOutline, lockClosedOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { NativeOnboardingService } from '../../core/services/native-onboarding.service';
import { TranslateService } from '../../core/services/translate.service';

@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [FormsModule, IonContent, IonIcon, TranslatePipe],
  templateUrl: './welcome.page.html',
  styleUrls: ['./welcome.page.scss'],
})
export class WelcomePage {
  readonly translate = inject(TranslateService);
  private readonly onboarding = inject(NativeOnboardingService);
  private readonly router = inject(Router);
  readonly languageOptions = [
    { native: 'Español', label: 'Spanish', labelKey: 'LANGUAGE.ES', value: 'es' },
    { native: 'English', label: 'English', labelKey: 'LANGUAGE.EN', value: 'en' },
    { native: '简体中文', label: 'Chinese (Simplified)', labelKey: 'LANGUAGE.ZH_HANS', value: 'zh-Hans' },
    { native: 'हिन्दी', label: 'Hindi', labelKey: 'LANGUAGE.HI', value: 'hi' },
    { native: 'العربية', label: 'Arabic', labelKey: 'LANGUAGE.AR', value: 'ar' },
    { native: 'Português', label: 'Portuguese', labelKey: 'LANGUAGE.PT', value: 'pt' },
    { native: 'Русский', label: 'Russian', labelKey: 'LANGUAGE.RU', value: 'ru' },
    { native: '日本語', label: 'Japanese', labelKey: 'LANGUAGE.JA', value: 'ja' },
    { native: 'Français', label: 'French', labelKey: 'LANGUAGE.FR', value: 'fr' },
    { native: 'Deutsch', label: 'German', labelKey: 'LANGUAGE.DE', value: 'de' },
  ];
  continuing = false;
  error = '';

  constructor() {
    addIcons({ arrowForwardOutline, chatbubbleOutline, globeOutline, lockClosedOutline });
  }

  setLanguage(language: string): void {
    this.translate.use(language);
  }

  async next(): Promise<void> {
    if (this.continuing) return;
    this.continuing = true;
    this.error = '';
    this.onboarding.complete();
    try {
      const navigated = await this.router.navigateByUrl('/auth', { replaceUrl: true });
      if (!navigated) this.showNavigationError();
    } catch {
      this.showNavigationError();
    } finally {
      this.continuing = false;
    }
  }

  private showNavigationError(): void {
    this.error = this.translate.instant('WELCOME.NAVIGATION_ERROR', 'No pudimos abrir el acceso. Vuelve a intentarlo.');
  }
}
