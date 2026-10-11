import { RouteReuseStrategy, PreloadAllModules, provideRouter, withPreloading } from '@angular/router';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';

import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { authInterceptor } from './app/core/interceptors/auth.interceptor';
import { apiFailoverInterceptor } from './app/core/interceptors/api-failover.interceptor';
import { ApiEndpointPool } from './app/core/services/api-endpoint-pool.service';
import { inject, provideAppInitializer } from '@angular/core';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular({ mode: 'ios', animated: true }),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    provideHttpClient(withInterceptors([authInterceptor, apiFailoverInterceptor])),
    provideAppInitializer(() => { void inject(ApiEndpointPool).prepare(); }),
    provideAnimations(),
  ],
})
  .catch((error) => console.error(error));
