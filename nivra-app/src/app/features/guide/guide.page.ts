import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import { ProductGuideService } from '../../core/services/product-guide.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';

@Component({
  standalone: true, selector: 'app-product-guide', imports: [IonContent, RouterLink, TranslatePipe],
  templateUrl: './guide.page.html', styleUrl: './guide.page.scss',
})
export class GuidePage implements OnInit {
  readonly guide = inject(ProductGuideService);
  readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  readonly userId = computed(() => this.auth.session()?.user.id || '');
  readonly progress = computed(() => this.guide.progress(this.userId()));
  readonly featureQuery = signal('');
  readonly view = signal<'start' | 'features' | 'help'>('start');
  readonly activeStep = signal(0);
  readonly automatic = [
    { id: 'messages', title: 'Tus mensajes siguen su camino', copy: 'Los textos pendientes se reintentan cuando vuelve la conexión. Mantén esta cuenta activa y la app visible y desbloqueada; si un aviso pide revisar permisos o identidad, resuélvelo primero.' },
    { id: 'sync', title: 'Al volver, se buscan novedades', copy: 'Nivra vuelve a conectar y busca mensajes al retomar la app. Con tu identidad recuperable activa, guarda una copia cifrada del historial disponible y la recupera en tus otros equipos en segundo plano. No necesitas actualizar cada conversación a mano.' },
    { id: 'identity', title: 'La seguridad se comprueba durante el uso', copy: 'La app comprueba la continuidad de las identidades y los equipos autorizados. Verificar a la persona requiere comparar su código o QR. Un cambio de identidad se revisa contigo antes de volver a confiar.' },
    { id: 'navigation', title: 'Más espacio para conversar', copy: 'En móvil, al bajar por Chats se recogen las historias, el buscador y los filtros; al subir reaparecen. En Web y Escritorio puedes abrir la barra lateral con el botón bajo el escudo. Empieza compacta y recuerda tu elección; Android conserva la barra inferior.' },
  ];
  readonly deliveryStates = [
    { id: 'pending', mark: '◷', title: 'Pendiente', copy: 'Está en la cola de este dispositivo; el servidor todavía no confirmó el envío.' },
    { id: 'sent', mark: '✓', title: 'Enviado', copy: 'El servidor confirmó el envío. La otra persona todavía puede estar sin conexión.' },
    { id: 'delivered', mark: '✓✓', title: 'Entregado', copy: 'Hay confirmación de entrega de los destinatarios. En un grupo, se espera a todos.' },
    { id: 'read', mark: '✓✓', title: 'Leído', copy: 'Hay confirmación de lectura de los destinatarios. Depende también de sus ajustes de privacidad.' },
  ];
  readonly tasks = [
    { id: 'account', title: 'Tu cuenta ya está creada', copy: 'En Cuenta puedes elegir tu nombre y foto. Guarda tu ID Nivra o alias para que tus contactos te encuentren. Nunca compartas tu contraseña.', path: '/app/account', fragment: 'account-profile', action: 'Ver mi perfil' },
    { id: 'contact', title: 'Agrega a tu primera persona', copy: 'Abre Contactos desde Chats, busca su ID Nivra o alias exacto y envía una solicitud. También puedes compartir tu pase o escanear su QR. Para conversar, revisa las solicitudes recibidas.', path: '/app/contacts', fragment: '', action: 'Abrir Contactos' },
    { id: 'message', title: 'Envía tu primer mensaje', copy: 'Abre una conversación, escribe y pulsa Enviar. Los textos pendientes se reintentan al recuperar conexión con esta cuenta activa y la app visible y desbloqueada. Puedes practicar en tus notas propias desde Contactos.', path: '/app/chats', fragment: '', action: 'Ir a Chats' },
    { id: 'call', title: 'Haz una llamada', copy: 'Abre el chat de un contacto y pulsa el teléfono o la cámara. Autoriza micrófono y cámara cuando se soliciten. En Llamadas puedes volver a una llamada activa. Algunas redes necesitan un servicio de conexión adicional.', path: '/app/calls', fragment: '', action: 'Abrir Llamadas' },
    { id: 'recovery', title: 'Prepara tu recuperación', copy: 'En Cuenta → Perfil verifica un correo y guarda tu frase de recuperación en un lugar privado. Activa Modo Seguro para bloquear el acceso a esta app. Revisa y retira los dispositivos que ya no uses.', path: '/app/account', fragment: 'account-profile', action: 'Proteger mi cuenta' },
  ];
  readonly features = [
    { title: 'Chats y notas propias', copy: 'Conversaciones privadas, grupos, adjuntos, reacciones y búsqueda. Con Programar junto al cuadro de texto eliges una hora y puedes cancelar el pendiente. Requiere esta cuenta abierta, desbloqueada y con conexión; si está cerrada, envía al volver. Las notas propias están en Contactos y se sincronizan con tus dispositivos vinculados.', path: '/app/chats' },
    { title: 'Contactos e invitaciones', copy: 'Guarda personas, revisa solicitudes y comparte tu pase. Las cuentas privadas requieren un ID, alias exacto o invitación.', path: '/app/contacts' },
    { title: 'Grupos y comunidades', copy: 'Los grupos reúnen conversaciones. Una comunidad organiza varios grupos y avisos; las acciones disponibles dependen de tu rol.', path: '/app/communities' },
    { title: 'Listas de difusión', copy: 'Envía un texto por separado a varios contactos. Cada persona lo recibe en su chat privado y no ve a los demás destinatarios.', path: '/app/broadcasts' },
    { title: 'Mundo e historias', copy: 'Publica y consulta historias. Antes de publicar, revisa la audiencia: podrá ver lo que compartas. Puedes responder desde el visor.', path: '/app/world' },
    { title: 'Bóveda y salas', copy: 'Las notas de Bóveda se cifran con tu PIN local y quedan en este equipo. Las salas permiten compartir con reglas de acceso y duración. Revisa el PIN, los participantes y la caducidad antes de entrar.', path: '/app/vault' },
    { title: 'Voz, video y pantalla', copy: 'Llama desde un chat. Durante una llamada compatible puedes invitar a otras personas o compartir pantalla con el permiso del sistema.', path: '/app/calls' },
    { title: 'Juegos y traducción', copy: 'En una llamada conectada abre Juegos para invitar a jugar. La traducción es opcional y depende del dispositivo; se activa en los controles de llamada.', path: '/app/calls' },
    { title: 'Privacidad y bloqueo', copy: 'Elige quién ve tu perfil y cómo se muestran los avisos. En Modo Seguro configura el bloqueo; revisa cuidadosamente las opciones sensibles antes de activarlas.', path: '/app/account', fragment: 'account-lock' },
    { title: 'Notificaciones', copy: 'Comprueba permisos, conexión con el servicio y registro de este dispositivo. Si un aviso no llega, consulta el diagnóstico y los ajustes del sistema.', path: '/app/notification-check' },
    { title: 'Dispositivos e historial', copy: 'Usa tu cuenta en varios teléfonos, Web y Escritorio. Tus equipos firmados con la misma identidad reciben mensajes y recuperan las copias cifradas disponibles automáticamente. Revisa y revoca los equipos perdidos desde Cuenta.', path: '/app/account', fragment: 'account-devices' },
    { title: 'Apariencia, idioma y actualizaciones', copy: 'Personaliza el tema, los fondos y el idioma desde Cuenta. Allí también puedes consultar las actualizaciones de tu plataforma.', path: '/app/account', fragment: 'account-appearance' },
    { title: 'Verificación de contactos', copy: 'Abre el menú de un chat privado → Verificar identidad. Compara el QR o código con la persona por un canal conocido. La comprobación automática de claves ayuda a reconocer sus equipos; la confirmación de la persona la haces tú.', path: '/app/chats' },
    { title: 'Chat incógnito', copy: 'Desde el menú del chat abre e invita a una conversación temporal. Ambos deben estar dentro para conversar. Los mensajes se limpian al salir o desconectarse un participante; la otra persona puede conservar capturas.', path: '/app/chats' },
    { title: 'Organiza tus conversaciones', copy: 'Usa Todos, Fijados, No leídos y Archivados para encontrar cada chat. Puedes fijar, silenciar o archivar conversaciones y seleccionar varias para las acciones disponibles.', path: '/app/chats' },
    { title: 'Dos cuentas en el mismo dispositivo', copy: 'En Cuenta puedes añadir otra cuenta y cambiar entre ellas. Cada cuenta conserva su sesión e historial separados. Comprueba qué perfil está activo antes de escribir o compartir.', path: '/app/account' },
  ].map((feature, index) => ({ ...feature, key: `GUIDE.FEATURE_${index}` }));
  readonly filteredFeatures = computed(() => {
    const query = this.normalize(this.featureQuery().trim());
    return this.features.filter(feature => !query || this.normalize(
      this.translate.instant(`${feature.key}_TITLE`, feature.title) + ' '
      + this.translate.instant(`${feature.key}_COPY`, feature.copy),
    ).includes(query));
  });

  private normalize(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(); }
  ngOnInit(): void {
    // Seeing the guide is enough to dismiss its first-run redirect. Practice
    // remains optional and is never mistaken for completed account setup.
    this.learn();
    const next = this.tasks.findIndex(task => !this.progress().completed.includes(task.id));
    this.activeStep.set(Math.max(0, next));
  }
  stepBy(direction: number): void {
    this.activeStep.update(step => Math.max(0, Math.min(this.tasks.length - 1, step + direction)));
  }
  learn(): void { this.guide.introduce(this.userId()); }
  async finish(): Promise<void> { this.learn(); await this.router.navigateByUrl('/app/chats'); }
}
