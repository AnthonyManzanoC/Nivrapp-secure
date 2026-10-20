import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { NIVRA_ANDROID_DOWNLOAD_URL, NIVRA_VERSION, NIVRA_WINDOWS_DOWNLOAD_URL } from '../../core/release';
import {
  arrowDownOutline, arrowForwardOutline, callOutline, chatbubbleEllipsesOutline,
  checkmarkDoneOutline, desktopOutline,
  ellipsisHorizontal, globeOutline, happyOutline, keyOutline, lockClosedOutline,
  logoAndroid, logoWindows, micOutline, musicalNotesOutline, searchOutline,
  shieldCheckmarkOutline, videocamOutline,
} from 'ionicons/icons';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, IonIcon],
  templateUrl: './landing.page.html',
  styleUrls: ['./landing.page.scss'],
})
export class LandingPage {
  readonly androidDownloadUrl = NIVRA_ANDROID_DOWNLOAD_URL;
  readonly windowsDownloadUrl = NIVRA_WINDOWS_DOWNLOAD_URL;
  readonly version = NIVRA_VERSION;

  constructor() {
    addIcons({
      arrowDownOutline, arrowForwardOutline, callOutline, chatbubbleEllipsesOutline,
      checkmarkDoneOutline, desktopOutline,
      ellipsisHorizontal, globeOutline, happyOutline, keyOutline, lockClosedOutline,
      logoAndroid, logoWindows, micOutline, musicalNotesOutline, searchOutline,
      shieldCheckmarkOutline, videocamOutline,
    });
  }

  scrollTo(id: string, event: Event): void {
    event.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  }
}
