import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import { ProductGuideService } from '../../core/services/product-guide.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

@Component({
  standalone: true, selector: 'app-product-guide', imports: [IonContent, RouterLink, TranslatePipe],
  templateUrl: './guide.page.html', styleUrl: './guide.page.scss',
})
export class GuidePage {
  readonly guide = inject(ProductGuideService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly userId = computed(() => this.auth.session()?.user.id || '');
  readonly progress = computed(() => this.guide.progress(this.userId()));
  readonly tasks = [
    { id: 'account', title: 'Tu cuenta ya está creada', copy: 'En Cuenta puedes elegir tu nombre y foto. Guarda tu ID Nivra o alias para que tus contactos te encuentren. Nunca compartas tu contraseña.', path: '/app/account', fragment: 'account-profile', action: 'Ver mi perfil' },
    { id: 'contact', title: 'Agrega a tu primera persona', copy: 'Abre Contactos desde Chats, busca su ID Nivra o alias exacto y envía una solicitud. También puedes compartir tu pase o escanear su QR. Para conversar, revisa las solicitudes recibidas.', path: '/app/contacts', fragment: '', action: 'Abrir Contactos' },
    { id: 'message', title: 'Envía tu primer mensaje', copy: 'Abre una conversación, escribe y pulsa Enviar. Sin conexión, el texto queda pendiente: conserva la app abierta y desbloqueada para reintentar al volver la red. Puedes probar en tus notas propias desde Contactos.', path: '/app/chats', fragment: '', action: 'Ir a Chats' },
    { id: 'call', title: 'Haz una llamada', copy: 'Abre el chat de un contacto y pulsa el teléfono o la cámara. Autoriza micrófono y cámara cuando se soliciten. En Llamadas puedes volver a una llamada activa. Algunas redes necesitan un servicio de conexión adicional.', path: '/app/calls', fragment: '', action: 'Abrir Llamadas' },
    { id: 'recovery', title: 'Prepara tu recuperación', copy: 'En Cuenta → Perfil verifica un correo y guarda tu frase de recuperación en un lugar privado. Activa Modo Seguro para bloquear el acceso a esta app. Revisa y retira los dispositivos que ya no uses.', path: '/app/account', fragment: 'account-profile', action: 'Proteger mi cuenta' },
  ];
  readonly features = [
    { title: 'Chats y notas propias', copy: 'Conversaciones privadas, grupos, adjuntos, reacciones y búsqueda. Las notas propias están en Contactos y se sincronizan con tus dispositivos vinculados.', path: '/app/chats' },
    { title: 'Contactos e invitaciones', copy: 'Guarda personas, revisa solicitudes y comparte tu pase. Las cuentas privadas requieren un ID, alias exacto o invitación.', path: '/app/contacts' },
    { title: 'Grupos y comunidades', copy: 'Los grupos reúnen conversaciones. Una comunidad organiza varios grupos y avisos; las acciones disponibles dependen de tu rol.', path: '/app/communities' },
    { title: 'Listas de difusión', copy: 'Envía un texto por separado a varios contactos. Cada persona lo recibe en su chat privado y no ve a los demás destinatarios.', path: '/app/broadcasts' },
    { title: 'Mundo e historias', copy: 'Publica y consulta historias. Antes de publicar, revisa la audiencia: podrá ver lo que compartas. Puedes responder desde el visor.', path: '/app/world' },
    { title: 'Bóveda y salas', copy: 'Guarda elementos y participa en salas con sus propias reglas de acceso y duración. Revisa la caducidad y las condiciones antes de compartir.', path: '/app/vault' },
    { title: 'Voz, video y pantalla', copy: 'Llama desde un chat. Durante una llamada compatible puedes invitar a otras personas o compartir pantalla con el permiso del sistema.', path: '/app/calls' },
    { title: 'Juegos y traducción', copy: 'En una llamada conectada abre Juegos para invitar a jugar. La traducción es opcional y depende del dispositivo; se activa en los controles de llamada.', path: '/app/calls' },
    { title: 'Privacidad y bloqueo', copy: 'Elige quién ve tu perfil y cómo se muestran los avisos. En Modo Seguro configura el bloqueo; revisa cuidadosamente las opciones sensibles antes de activarlas.', path: '/app/account', fragment: 'account-lock' },
    { title: 'Notificaciones', copy: 'Comprueba permisos, conexión con el servicio y registro de este dispositivo. Si un aviso no llega, consulta el diagnóstico y los ajustes del sistema.', path: '/app/notification-check' },
    { title: 'Dispositivos e historial', copy: 'Vincula tus equipos y aprueba el historial desde uno que todavía pueda abrir tus mensajes. Revoca los equipos perdidos desde Cuenta.', path: '/app/account', fragment: 'account-devices' },
    { title: 'Apariencia, idioma y actualizaciones', copy: 'Personaliza el tema, los fondos y el idioma desde Cuenta. Allí también puedes consultar las actualizaciones de tu plataforma.', path: '/app/account', fragment: 'account-appearance' },
  ];
  learn(): void { this.guide.introduce(this.userId()); }
  async finish(): Promise<void> { this.learn(); await this.router.navigateByUrl('/app/chats'); }
}
