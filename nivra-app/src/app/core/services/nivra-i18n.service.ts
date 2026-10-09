import { Injectable, computed, effect, inject } from '@angular/core';
import { AppSettingsService } from './app-settings.service';

type TranslationDictionary = Record<string, Record<string, string>>;
const SUPPORTED_LANGUAGES = new Set(['es', 'en', 'zh-Hans', 'hi', 'ar', 'pt', 'ru', 'ja', 'fr', 'de']);

const TRANSLATIONS: TranslationDictionary = {
  es: {
    'settings.chat.title': 'Ajustes de chats',
    'settings.chat.previewName': 'Anthony Manzano',
    'settings.chat.previewIncoming': 'Asi se veran tus mensajes con el ajuste actual.',
    'settings.chat.previewOutgoing': 'Listo, aplicado en el chat real.',
    'settings.chat.textSize': 'Tamano del texto del mensaje',
    'settings.chat.radius': 'Esquinas de los mensajes',
    'settings.chat.wallpaper': 'Fondo',
    'settings.chat.color': 'Color',
    'settings.chat.twoLines': 'Dos lineas',
    'settings.chat.threeLines': 'Tres lineas',
    'settings.chat.enterToSend': 'Enviar con la tecla Intro',
    'settings.chat.animations': 'Animaciones',
    'settings.chat.showNextMedia': 'Mostrar siguiente al tocar multimedia',
    'settings.theme.system': 'Sistema',
    'settings.theme.dark': 'Oscuro',
    'settings.theme.light': 'Claro',
    'settings.wallpaper.nivra': 'Nivra',
    'settings.wallpaper.clean': 'Limpio',
    'settings.wallpaper.botanic': 'Botanico',
    'settings.wallpaper.midnight': 'Nocturno',
    'settings.wallpaper.paper': 'Papel',
    'settings.language.title': 'Idioma',
    'settings.language.showTranslate': 'Mostrar boton Traducir',
    'settings.language.translateChats': 'Traducir chats enteros',
    'settings.data.title': 'Datos y almacenamiento',
    'settings.data.refresh': 'Actualizar almacenamiento',
    'settings.data.savePrivate': 'Guardar chats privados en galeria',
    'settings.data.saveGroups': 'Guardar grupos en galeria',
    'settings.data.saveChannels': 'Guardar canales en galeria',
    'settings.data.streaming': 'Streaming de video y audio',
    'settings.data.lowDataCalls': 'Usar menos datos en llamadas',
    'settings.data.proxy': 'Proxy',
    'settings.data.deleteDrafts': 'Eliminar borradores',
    'settings.behavior.title': 'Otros ajustes',
    'settings.behavior.directShare': 'Direct Share',
    'settings.behavior.appBrowser': 'Navegador en la app',
    'settings.behavior.adultContent': 'Mostrar contenido +18',
    'settings.behavior.raiseListen': 'Levantar para escuchar',
    'settings.behavior.raiseTalk': 'Levantar para hablar',
    'settings.behavior.pauseRecord': 'Pausar musica al grabar',
    'settings.behavior.pausePlayback': 'Pausar musica al reproducir',
    'settings.diagnostics.title': 'Ayuda y depuracion',
    'settings.diagnostics.sendLogs': 'Enviar registros',
    'settings.diagnostics.includeRecent': 'Incluir ultimos eventos locales',
    'settings.diagnostics.copy': 'Copiar diagnostico',
    'settings.diagnostics.reset': 'Restaurar ajustes',
    'settings.notice.applied': 'Ajuste aplicado.',
    'settings.notice.colorApplied': 'Color aplicado.',
    'settings.notice.themeApplied': 'Tema aplicado.',
    'settings.notice.languageApplied': 'Idioma aplicado en tiempo real.',
  },
  en: {
    'settings.chat.title': 'Chat settings',
    'settings.chat.previewName': 'Anthony Manzano',
    'settings.chat.previewIncoming': 'This is how your messages will look with the current setting.',
    'settings.chat.previewOutgoing': 'Done, applied to the real chat.',
    'settings.chat.textSize': 'Message text size',
    'settings.chat.radius': 'Message corners',
    'settings.chat.wallpaper': 'Background',
    'settings.chat.color': 'Color',
    'settings.chat.twoLines': 'Two lines',
    'settings.chat.threeLines': 'Three lines',
    'settings.chat.enterToSend': 'Send with Enter',
    'settings.chat.animations': 'Animations',
    'settings.chat.showNextMedia': 'Show next media on tap',
    'settings.theme.system': 'System',
    'settings.theme.dark': 'Dark',
    'settings.theme.light': 'Light',
    'settings.wallpaper.nivra': 'Nivra',
    'settings.wallpaper.clean': 'Clean',
    'settings.wallpaper.botanic': 'Botanic',
    'settings.wallpaper.midnight': 'Midnight',
    'settings.wallpaper.paper': 'Paper',
    'settings.language.title': 'Language',
    'settings.language.showTranslate': 'Show Translate button',
    'settings.language.translateChats': 'Translate entire chats',
    'settings.data.title': 'Data and storage',
    'settings.data.refresh': 'Refresh storage',
    'settings.data.savePrivate': 'Save private chats to gallery',
    'settings.data.saveGroups': 'Save groups to gallery',
    'settings.data.saveChannels': 'Save channels to gallery',
    'settings.data.streaming': 'Video and audio streaming',
    'settings.data.lowDataCalls': 'Use less data for calls',
    'settings.data.proxy': 'Proxy',
    'settings.data.deleteDrafts': 'Delete drafts',
    'settings.behavior.title': 'Other settings',
    'settings.behavior.directShare': 'Direct Share',
    'settings.behavior.appBrowser': 'In-app browser',
    'settings.behavior.adultContent': 'Show +18 content',
    'settings.behavior.raiseListen': 'Raise to listen',
    'settings.behavior.raiseTalk': 'Raise to talk',
    'settings.behavior.pauseRecord': 'Pause music while recording',
    'settings.behavior.pausePlayback': 'Pause music on playback',
    'settings.diagnostics.title': 'Help and debugging',
    'settings.diagnostics.sendLogs': 'Send logs',
    'settings.diagnostics.includeRecent': 'Include recent local events',
    'settings.diagnostics.copy': 'Copy diagnostics',
    'settings.diagnostics.reset': 'Reset settings',
    'settings.notice.applied': 'Setting applied.',
    'settings.notice.colorApplied': 'Color applied.',
    'settings.notice.themeApplied': 'Theme applied.',
    'settings.notice.languageApplied': 'Language applied in real time.',
  },
  pt: {
    'settings.chat.title': 'Ajustes de chats',
    'settings.chat.wallpaper': 'Fundo',
    'settings.chat.color': 'Cor',
    'settings.chat.twoLines': 'Duas linhas',
    'settings.chat.threeLines': 'Tres linhas',
    'settings.theme.system': 'Sistema',
    'settings.theme.dark': 'Escuro',
    'settings.theme.light': 'Claro',
    'settings.language.title': 'Idioma',
    'settings.data.title': 'Dados e armazenamento',
    'settings.behavior.title': 'Outros ajustes',
    'settings.diagnostics.title': 'Ajuda e depuracao',
    'settings.notice.languageApplied': 'Idioma aplicado em tempo real.',
  },
  fr: {
    'settings.chat.title': 'Reglages des chats',
    'settings.chat.wallpaper': 'Fond',
    'settings.chat.color': 'Couleur',
    'settings.chat.twoLines': 'Deux lignes',
    'settings.chat.threeLines': 'Trois lignes',
    'settings.theme.system': 'Systeme',
    'settings.theme.dark': 'Sombre',
    'settings.theme.light': 'Clair',
    'settings.language.title': 'Langue',
    'settings.data.title': 'Donnees et stockage',
    'settings.behavior.title': 'Autres reglages',
    'settings.diagnostics.title': 'Aide et diagnostic',
    'settings.notice.languageApplied': 'Langue appliquee en temps reel.',
  },
  'zh-Hans': {
    'settings.chat.title': '聊天设置',
    'settings.chat.wallpaper': '背景',
    'settings.chat.color': '颜色',
    'settings.chat.twoLines': '两行',
    'settings.chat.threeLines': '三行',
    'settings.theme.system': '系统',
    'settings.theme.dark': '深色',
    'settings.theme.light': '浅色',
    'settings.language.title': '语言',
    'settings.data.title': '数据和存储',
    'settings.behavior.title': '其他设置',
    'settings.diagnostics.title': '帮助与调试',
    'settings.notice.languageApplied': '语言已实时应用。',
  },
  'zh-Hant': {
    'settings.chat.title': '聊天設定',
    'settings.chat.wallpaper': '背景',
    'settings.chat.color': '顏色',
    'settings.chat.twoLines': '兩行',
    'settings.chat.threeLines': '三行',
    'settings.theme.system': '系統',
    'settings.theme.dark': '深色',
    'settings.theme.light': '淺色',
    'settings.language.title': '語言',
    'settings.data.title': '資料與儲存空間',
    'settings.behavior.title': '其他設定',
    'settings.diagnostics.title': '說明與偵錯',
    'settings.notice.languageApplied': '語言已即時套用。',
  },
};

const GLOBAL_TRANSLATIONS: TranslationDictionary = {
  es: {
    'TABS.CHATS': 'Chats',
    'TABS.WORLD': 'Contactos',
    'TABS.VAULT': 'Boveda',
    'TABS.CALLS': 'Llamadas',
    'TABS.ACCOUNT': 'Cuenta',
    'TABS.LOGOUT': 'Salir',
    'LOGIN.LANGUAGE_LABEL': 'Elegir idioma',
    'LOGIN.ACTIVATE_ACCOUNT': 'Activar cuenta',
    'LOGIN.ALIAS': 'Alias',
    'LOGIN.ALIAS_HINT': 'Usa 3-32 caracteres: letras, numeros, punto, guion o guion bajo.',
    'LOGIN.CODE': 'Codigo',
    'LOGIN.CODE_SENT': 'Codigo enviado.',
    'LOGIN.COPY': 'Conecta con tu gente desde el móvil o el ordenador. Entra con tu ID Nivra o tu alias.',
    'LOGIN.CREATE': 'Crear',
    'LOGIN.CREATE_ACCOUNT': 'Crear cuenta',
    'LOGIN.ENCRYPTED_BEFORE_SEND': 'Mensaje cifrado antes de salir.',
    'LOGIN.ENTER': 'Entrar',
    'LOGIN.GENERATE_QR': 'Generar QR',
    'LOGIN.KEYS_READY': 'Llaves listas en este dispositivo.',
    'LOGIN.NAME': 'Nombre',
    'LOGIN.PASSWORD': 'Contraseña',
    'LOGIN.PHONE': 'Telefono',
    'LOGIN.PHONE_VERIFIED': 'Telefono verificado.',
    'LOGIN.QR_ACTIVE': 'QR activo.',
    'LOGIN.QR_READY': 'QR listo',
    'LOGIN.TAGLINE': 'Private messenger',
    'LOGIN.TITLE': 'Entra a tu espacio privado',
    'CALLS.INCOMING_VIDEO': 'Videollamada entrante',
    'CALLS.INCOMING_AUDIO': 'Llamada entrante',
    'CALLS.REJECT': 'Rechazar',
    'CALLS.ACCEPT': 'Aceptar',
    'ACCOUNT.TITLE': 'Cuenta',
    'ACCOUNT.PROFILE': 'Perfil',
    'ACCOUNT.CHANGE_PHOTO': 'Cambiar foto',
    'ACCOUNT.UPLOAD_PHOTO': 'Subir foto',
    'ACCOUNT.REMOVE': 'Quitar',
    'ACCOUNT.ALIAS': 'Alias',
    'ACCOUNT.ALIAS_CHECKING': 'Validando alias...',
    'ACCOUNT.ALIAS_TAKEN': 'Alias no disponible',
    'ACCOUNT.ALIAS_INVALID': 'Usa 3 a 32 caracteres: letras, numeros, punto, guion o _.',
    'ACCOUNT.ALIAS_AVAILABLE': 'Alias disponible',
    'ACCOUNT.ALIAS_HINT': 'Tu alias es unico y puede compartirse como',
    'ACCOUNT.NAME': 'Nombre',
    'ACCOUNT.EMAIL': 'Email',
    'ACCOUNT.PHONE': 'Telefono',
    'ACCOUNT.BIO': 'Bio',
    'ACCOUNT.VISIBLE_DIRECTORY': 'Visible en directorio',
    'ACCOUNT.SAVE_PROFILE': 'Guardar perfil',
    'ACCOUNT.SAFE_MODE': 'Modo Seguro',
    'ACCOUNT.APP_LOCK': 'Bloqueo de App',
    'ACCOUNT.ACTIVE': 'Activo',
    'ACCOUNT.DISABLED': 'Desactivado',
    'ACCOUNT.APPEARANCE': 'Apariencia',
    'ACCOUNT.LIGHT_THEME': 'Tema claro',
    'ACCOUNT.DARK_THEME': 'Tema oscuro',
    'ACCOUNT.LIGHT_COPY': 'Limpio, legible y luminoso.',
    'ACCOUNT.DARK_COPY': 'Privado, profundo y enfocado.',
    'ACCOUNT.PRIVACY': 'Privacidad',
    'ACCOUNT.PRESET': 'Preset',
    'ACCOUNT.PRIVATE': 'Privado',
    'ACCOUNT.BALANCED': 'Equilibrado',
    'ACCOUNT.OPEN': 'Abierto',
    'ACCOUNT.AUTO_DELETE_NEW': 'Autoeliminar mensajes nuevos',
    'ACCOUNT.NO_EXPIRATION': 'Sin expiracion',
    'ACCOUNT.HIDE_NOTIFICATION_CONTENT': 'Ocultar contenido en avisos',
    'ACCOUNT.ALLOW_FORWARDING': 'Permitir reenviar',
    'ACCOUNT.ALLOW_SCREENSHOTS': 'Permitir capturas',
    'ACCOUNT.READ_RECEIPTS': 'Confirmaciones de lectura',
    'ACCOUNT.SAVE_PRIVACY': 'Guardar privacidad',
    'ACCOUNT.ADVANCED_VISIBILITY': 'Visibilidad avanzada local',
    'ACCOUNT.LOCAL': 'Local',
    'ACCOUNT.PHONE_NUMBER': 'Numero de telefono',
    'ACCOUNT.LAST_SEEN': 'Ultima vez y en linea',
    'ACCOUNT.PROFILE_PHOTOS': 'Fotos del perfil',
    'ACCOUNT.FORWARDED_MESSAGES': 'Mensajes reenviados',
    'ACCOUNT.VOICE_MESSAGES': 'Mensajes de voz',
    'ACCOUNT.MESSAGES': 'Mensajes',
    'ACCOUNT.BIRTHDAY': 'Cumpleanos',
    'ACCOUNT.GIFTS': 'Regalos',
    'ACCOUNT.SAVED_MUSIC': 'Musica guardada',
    'ACCOUNT.INVITES': 'Invitaciones',
    'ACCOUNT.EVERYONE': 'Todos',
    'ACCOUNT.CONTACTS': 'Mis contactos',
    'ACCOUNT.NOBODY': 'Nadie',
    'CHATS.TITLE': 'Chats',
    'CHATS.CONVERSATIONS': 'conversaciones',
    'CHATS.SHARE_NIVRA': 'Compartir Nivra',
    'CHATS.NEW_GROUP': 'Nuevo grupo',
    'CHATS.SYNC': 'Sincronizar',
    'CHATS.SEARCH': 'Buscar',
    'CHATS.CLEAR_SEARCH': 'Limpiar busqueda',
    'CHATS.NO_RESULTS': 'Sin resultados',
    'CHATS.TRY_ALIAS': 'Prueba otro alias o nombre.',
    'CHATS.RECENT_SEARCHES': 'Busquedas recientes',
    'CHATS.CLOSE_RECENT': 'Cerrar busquedas recientes',
    'CHATS.DELETE_RECENT': 'Eliminar busquedas recientes',
    'CHATS.ALL': 'Todos',
    'CHATS.PINNED': 'Fijados',
    'CHATS.UNREAD': 'No leidos',
    'CHATS.ARCHIVED': 'Archivados',
    'CHATS.PIN': 'Fijar',
    'CHATS.UNPIN': 'Desfijar',
    'CHATS.MUTE': 'Silenciar',
    'CHATS.UNMUTE': 'Activar',
    'CHATS.ARCHIVE': 'Archivar',
    'CHATS.UNARCHIVE': 'Desarchivar',
    'CHATS.PINNED_TAG': 'Fijado',
    'CHATS.MUTED_TAG': 'Silenciado',
    'CHATS.UNREAD_TAG': 'No leido',
    'CHATS.EMPTY_COPY': 'Busca un alias para abrir tu primer chat.',
    'CHATS.SHARE_PASS': 'Compartir pase',
    'CHATS.SELECT_TO_CONTINUE': 'Selecciona un chat para continuar.',
    'CHATS.GROUP_PARTICIPANTS_SELECTED': 'participantes seleccionados',
    'CHAT.LEAVE_GROUP': 'Salir',
    'CHAT.LEAVE_GROUP_ARIA': 'Salir del grupo',
    'CHAT.LEAVE_GROUP_CONFIRM': 'Salir de este grupo? No podras volver a entrar a menos que un administrador te agregue.',
    'CHAT.LEFT_GROUP': 'Saliste del grupo.',
    'CHAT.ERROR_LEAVE_GROUP': 'No se pudo salir del grupo.',
    'WORLD.RADAR_TITLE': 'Radar cifrado',
    'WORLD.SCAN': 'Escanear',
    'WORLD.SYNCING_AGENDA': 'Sincronizando agenda',
    'WORLD.INVISIBLE_AGENDAS': 'Invisible para agendas',
    'WORLD.AVAILABLE_MATCHES': 'Disponible para coincidencias',
    'WORLD.AGENDA_SYNCED': 'Agenda sincronizada',
    'WORLD.AGENDA_SYNCED_COPY': 'Solo aparecen contactos visibles en directorio.',
    'WORLD.PHONES_READY': 'telefonos listos',
    'WORLD.PHONES_REVIEWED': 'telefonos revisados',
    'WORLD.CONTACTS_SYNCED_HINT': 'telefonos sincronizados. Si alguno visible usa Nivra, aparecera aqui.',
  },
  en: {
    'TABS.CHATS': 'Chats',
    'TABS.WORLD': 'Contacts',
    'TABS.VAULT': 'Vault',
    'TABS.CALLS': 'Calls',
    'TABS.ACCOUNT': 'Account',
    'TABS.LOGOUT': 'Log out',
    'LOGIN.LANGUAGE_LABEL': 'Choose language',
    'LOGIN.ACTIVATE_ACCOUNT': 'Activate account',
    'LOGIN.ALIAS': 'Alias',
    'LOGIN.ALIAS_HINT': 'Use 3-32 characters: letters, numbers, dot, dash or underscore.',
    'LOGIN.CODE': 'Code',
    'LOGIN.CODE_SENT': 'Code sent.',
    'LOGIN.COPY': 'Connect with your people on your phone or computer. Sign in with your Nivra ID or alias.',
    'LOGIN.CREATE': 'Create',
    'LOGIN.CREATE_ACCOUNT': 'Create account',
    'LOGIN.ENCRYPTED_BEFORE_SEND': 'Message encrypted before it leaves.',
    'LOGIN.ENTER': 'Enter',
    'LOGIN.GENERATE_QR': 'Generate QR',
    'LOGIN.KEYS_READY': 'Keys ready on this device.',
    'LOGIN.NAME': 'Name',
    'LOGIN.PASSWORD': 'Password',
    'LOGIN.PHONE': 'Phone',
    'LOGIN.PHONE_VERIFIED': 'Phone verified.',
    'LOGIN.QR_ACTIVE': 'QR active.',
    'LOGIN.QR_READY': 'QR ready',
    'LOGIN.TAGLINE': 'Private messenger',
    'LOGIN.TITLE': 'Enter your private space',
    'CALLS.INCOMING_VIDEO': 'Incoming video call',
    'CALLS.INCOMING_AUDIO': 'Incoming call',
    'CALLS.REJECT': 'Reject',
    'CALLS.ACCEPT': 'Accept',
    'ACCOUNT.TITLE': 'Account',
    'ACCOUNT.PROFILE': 'Profile',
    'ACCOUNT.CHANGE_PHOTO': 'Change photo',
    'ACCOUNT.UPLOAD_PHOTO': 'Upload photo',
    'ACCOUNT.REMOVE': 'Remove',
    'ACCOUNT.ALIAS': 'Alias',
    'ACCOUNT.ALIAS_CHECKING': 'Checking alias...',
    'ACCOUNT.ALIAS_TAKEN': 'Alias unavailable',
    'ACCOUNT.ALIAS_INVALID': 'Use 3 to 32 characters: letters, numbers, dot, dash or _.',
    'ACCOUNT.ALIAS_AVAILABLE': 'Alias available',
    'ACCOUNT.ALIAS_HINT': 'Your alias is unique and can be shared as',
    'ACCOUNT.NAME': 'Name',
    'ACCOUNT.EMAIL': 'Email',
    'ACCOUNT.PHONE': 'Phone',
    'ACCOUNT.BIO': 'Bio',
    'ACCOUNT.VISIBLE_DIRECTORY': 'Visible in directory',
    'ACCOUNT.SAVE_PROFILE': 'Save profile',
    'ACCOUNT.SAFE_MODE': 'Safe Mode',
    'ACCOUNT.APP_LOCK': 'App Lock',
    'ACCOUNT.ACTIVE': 'Active',
    'ACCOUNT.DISABLED': 'Disabled',
    'ACCOUNT.APPEARANCE': 'Appearance',
    'ACCOUNT.LIGHT_THEME': 'Light theme',
    'ACCOUNT.DARK_THEME': 'Dark theme',
    'ACCOUNT.LIGHT_COPY': 'Clean, readable and bright.',
    'ACCOUNT.DARK_COPY': 'Private, deep and focused.',
    'ACCOUNT.PRIVACY': 'Privacy',
    'ACCOUNT.PRESET': 'Preset',
    'ACCOUNT.PRIVATE': 'Private',
    'ACCOUNT.BALANCED': 'Balanced',
    'ACCOUNT.OPEN': 'Open',
    'ACCOUNT.AUTO_DELETE_NEW': 'Auto-delete new messages',
    'ACCOUNT.NO_EXPIRATION': 'No expiration',
    'ACCOUNT.HIDE_NOTIFICATION_CONTENT': 'Hide content in alerts',
    'ACCOUNT.ALLOW_FORWARDING': 'Allow forwarding',
    'ACCOUNT.ALLOW_SCREENSHOTS': 'Allow screenshots',
    'ACCOUNT.READ_RECEIPTS': 'Read receipts',
    'ACCOUNT.SAVE_PRIVACY': 'Save privacy',
    'ACCOUNT.ADVANCED_VISIBILITY': 'Advanced local visibility',
    'ACCOUNT.LOCAL': 'Local',
    'ACCOUNT.PHONE_NUMBER': 'Phone number',
    'ACCOUNT.LAST_SEEN': 'Last seen and online',
    'ACCOUNT.PROFILE_PHOTOS': 'Profile photos',
    'ACCOUNT.FORWARDED_MESSAGES': 'Forwarded messages',
    'ACCOUNT.VOICE_MESSAGES': 'Voice messages',
    'ACCOUNT.MESSAGES': 'Messages',
    'ACCOUNT.BIRTHDAY': 'Birthdays',
    'ACCOUNT.GIFTS': 'Gifts',
    'ACCOUNT.SAVED_MUSIC': 'Saved music',
    'ACCOUNT.INVITES': 'Invites',
    'ACCOUNT.EVERYONE': 'Everyone',
    'ACCOUNT.CONTACTS': 'My contacts',
    'ACCOUNT.NOBODY': 'Nobody',
    'CHATS.TITLE': 'Chats',
    'CHATS.CONVERSATIONS': 'conversations',
    'CHATS.SHARE_NIVRA': 'Share Nivra',
    'CHATS.NEW_GROUP': 'New group',
    'CHATS.SYNC': 'Sync',
    'CHATS.SEARCH': 'Search',
    'CHATS.CLEAR_SEARCH': 'Clear search',
    'CHATS.NO_RESULTS': 'No results',
    'CHATS.TRY_ALIAS': 'Try another alias or name.',
    'CHATS.RECENT_SEARCHES': 'Recent searches',
    'CHATS.CLOSE_RECENT': 'Close recent searches',
    'CHATS.DELETE_RECENT': 'Delete recent searches',
    'CHATS.ALL': 'All',
    'CHATS.PINNED': 'Pinned',
    'CHATS.UNREAD': 'Unread',
    'CHATS.ARCHIVED': 'Archived',
    'CHATS.PIN': 'Pin',
    'CHATS.UNPIN': 'Unpin',
    'CHATS.MUTE': 'Mute',
    'CHATS.UNMUTE': 'Unmute',
    'CHATS.ARCHIVE': 'Archive',
    'CHATS.UNARCHIVE': 'Unarchive',
    'CHATS.PINNED_TAG': 'Pinned',
    'CHATS.MUTED_TAG': 'Muted',
    'CHATS.UNREAD_TAG': 'Unread',
    'CHATS.EMPTY_COPY': 'Search an alias to open your first chat.',
    'CHATS.SHARE_PASS': 'Share pass',
    'CHATS.SELECT_TO_CONTINUE': 'Select a chat to continue.',
    'CHATS.GROUP_PARTICIPANTS_SELECTED': 'participants selected',
    'CHAT.CHANGE_GROUP_PHOTO': 'Change group photo',
    'CHAT.ERROR_GROUP_PHOTO': 'Could not load the group photo.',
    'CHAT.ERROR_UPDATE_GROUP': 'Could not update the group.',
    'CHAT.GROUP_NAME': 'Group name',
    'CHAT.GROUP_SETTINGS': 'Group settings',
    'CHAT.GROUP_STORIES': 'Group stories',
    'CHAT.GROUP_UPDATED': 'Group updated.',
    'CHAT.NO_GROUP_STORIES': 'There are no active stories for this group yet.',
    'CHAT.LEAVE_GROUP': 'Leave',
    'CHAT.LEAVE_GROUP_ARIA': 'Leave group',
    'CHAT.LEAVE_GROUP_CONFIRM': 'Leave this group? You will not be able to rejoin unless an admin adds you again.',
    'CHAT.LEFT_GROUP': 'You left the group.',
    'CHAT.ERROR_LEAVE_GROUP': 'Could not leave the group.',
    'CHATS.CREATE_GROUP': 'Create group',
    'CHATS.ERROR_CREATE_GROUP': 'Could not create the group.',
    'CHATS.GROUP_NAME_PLACEHOLDER': 'Family, team, friends',
    'CHATS.NO_CONTACTS_GROUP_COPY': 'Find contacts first to create a group.',
    'WORLD.RADAR_TITLE': 'Encrypted radar',
    'WORLD.SCAN': 'Scan',
    'WORLD.SYNCING_AGENDA': 'Syncing address book',
    'WORLD.INVISIBLE_AGENDAS': 'Hidden from address books',
    'WORLD.AVAILABLE_MATCHES': 'Available for matches',
    'WORLD.AGENDA_SYNCED': 'Address book synced',
    'WORLD.AGENDA_SYNCED_COPY': 'Only contacts visible in the directory appear.',
    'WORLD.PHONES_READY': 'phones ready',
    'WORLD.PHONES_REVIEWED': 'phones reviewed',
    'WORLD.CONTACTS_SYNCED_HINT': 'phones synced. If any visible contact uses Nivra, they will appear here.',
  },
  'zh-Hans': {
    'settings.chat.title': '聊天设置',
    'settings.chat.previewIncoming': '当前设置下你的消息将这样显示。',
    'settings.chat.previewOutgoing': '已应用到真实聊天。',
    'settings.chat.textSize': '消息文字大小',
    'settings.chat.radius': '消息圆角',
    'settings.chat.wallpaper': '背景',
    'settings.chat.color': '颜色',
    'settings.chat.twoLines': '两行',
    'settings.chat.threeLines': '三行',
    'settings.chat.enterToSend': '按 Enter 发送',
    'settings.chat.animations': '动画',
    'settings.chat.showNextMedia': '点击媒体时显示下一个',
    'settings.theme.system': '系统',
    'settings.theme.dark': '深色',
    'settings.theme.light': '浅色',
    'settings.wallpaper.nivra': 'Nivra',
    'settings.wallpaper.clean': '简洁',
    'settings.wallpaper.botanic': '植物',
    'settings.wallpaper.midnight': '午夜',
    'settings.wallpaper.paper': '纸张',
    'settings.language.title': '语言',
    'settings.language.showTranslate': '显示翻译按钮',
    'settings.language.translateChats': '翻译整个聊天',
    'settings.data.title': '数据和存储',
    'settings.data.refresh': '刷新存储',
    'settings.data.savePrivate': '保存私聊媒体到图库',
    'settings.data.saveGroups': '保存群组媒体到图库',
    'settings.data.saveChannels': '保存频道媒体到图库',
    'settings.data.streaming': '视频和音频流式播放',
    'settings.data.lowDataCalls': '通话少用流量',
    'settings.data.proxy': '代理',
    'settings.data.deleteDrafts': '删除草稿',
    'settings.behavior.title': '其他设置',
    'settings.behavior.directShare': '直接分享',
    'settings.behavior.appBrowser': '应用内浏览器',
    'settings.behavior.adultContent': '显示 +18 内容',
    'settings.behavior.raiseListen': '拿起收听',
    'settings.behavior.raiseTalk': '拿起说话',
    'settings.behavior.pauseRecord': '录制时暂停音乐',
    'settings.behavior.pausePlayback': '播放时暂停音乐',
    'settings.diagnostics.title': '帮助与调试',
    'settings.diagnostics.sendLogs': '发送日志',
    'settings.diagnostics.includeRecent': '包含最近本地事件',
    'settings.diagnostics.copy': '复制诊断信息',
    'settings.diagnostics.reset': '重置设置',
    'settings.notice.applied': '设置已应用。',
    'settings.notice.colorApplied': '颜色已应用。',
    'settings.notice.themeApplied': '主题已应用。',
    'settings.notice.languageApplied': '语言已实时应用。',
    'TABS.CHATS': '聊天',
    'TABS.WORLD': '联系人',
    'TABS.VAULT': '保险库',
    'TABS.CALLS': '通话',
    'TABS.ACCOUNT': '账户',
    'TABS.LOGOUT': '退出',
    'CALLS.INCOMING_VIDEO': '视频来电',
    'CALLS.INCOMING_AUDIO': '来电',
    'CALLS.REJECT': '拒绝',
    'CALLS.ACCEPT': '接听',
    'ACCOUNT.TITLE': '账户',
    'ACCOUNT.PROFILE': '个人资料',
    'ACCOUNT.CHANGE_PHOTO': '更换照片',
    'ACCOUNT.UPLOAD_PHOTO': '上传照片',
    'ACCOUNT.REMOVE': '移除',
    'ACCOUNT.ALIAS': '用户名',
    'ACCOUNT.NAME': '姓名',
    'ACCOUNT.EMAIL': '邮箱',
    'ACCOUNT.PHONE': '电话',
    'ACCOUNT.BIO': '简介',
    'ACCOUNT.VISIBLE_DIRECTORY': '在目录中可见',
    'ACCOUNT.SAVE_PROFILE': '保存资料',
    'ACCOUNT.SAFE_MODE': '安全模式',
    'ACCOUNT.APP_LOCK': '应用锁',
    'ACCOUNT.ACTIVE': '已启用',
    'ACCOUNT.DISABLED': '已禁用',
    'ACCOUNT.APPEARANCE': '外观',
    'ACCOUNT.LIGHT_THEME': '浅色主题',
    'ACCOUNT.DARK_THEME': '深色主题',
    'ACCOUNT.PRIVACY': '隐私',
    'ACCOUNT.PRESET': '预设',
    'ACCOUNT.PRIVATE': '私密',
    'ACCOUNT.BALANCED': '平衡',
    'ACCOUNT.OPEN': '开放',
    'ACCOUNT.AUTO_DELETE_NEW': '自动删除新消息',
    'ACCOUNT.NO_EXPIRATION': '不过期',
    'ACCOUNT.HIDE_NOTIFICATION_CONTENT': '隐藏通知内容',
    'ACCOUNT.ALLOW_FORWARDING': '允许转发',
    'ACCOUNT.ALLOW_SCREENSHOTS': '允许截图',
    'ACCOUNT.READ_RECEIPTS': '已读回执',
    'ACCOUNT.SAVE_PRIVACY': '保存隐私',
    'ACCOUNT.ADVANCED_VISIBILITY': '本地高级可见性',
    'ACCOUNT.LOCAL': '本地',
    'ACCOUNT.PHONE_NUMBER': '电话号码',
    'ACCOUNT.LAST_SEEN': '最后上线和在线',
    'ACCOUNT.PROFILE_PHOTOS': '头像照片',
    'ACCOUNT.FORWARDED_MESSAGES': '转发消息',
    'ACCOUNT.VOICE_MESSAGES': '语音消息',
    'ACCOUNT.MESSAGES': '消息',
    'ACCOUNT.BIRTHDAY': '生日',
    'ACCOUNT.GIFTS': '礼物',
    'ACCOUNT.SAVED_MUSIC': '保存的音乐',
    'ACCOUNT.INVITES': '邀请',
    'ACCOUNT.EVERYONE': '所有人',
    'ACCOUNT.CONTACTS': '我的联系人',
    'ACCOUNT.NOBODY': '没有人',
    'CHATS.TITLE': '聊天',
    'CHATS.CONVERSATIONS': '个会话',
    'CHATS.SHARE_NIVRA': '分享 Nivra',
    'CHATS.NEW_GROUP': '新建群组',
    'CHATS.SYNC': '同步',
    'CHATS.SEARCH': '搜索',
    'CHATS.CLEAR_SEARCH': '清除搜索',
    'CHATS.NO_RESULTS': '没有结果',
    'CHATS.TRY_ALIAS': '试试其他用户名或姓名。',
    'CHATS.RECENT_SEARCHES': '最近搜索',
    'CHATS.CLOSE_RECENT': '关闭最近搜索',
    'CHATS.DELETE_RECENT': '删除最近搜索',
    'CHATS.ALL': '全部',
    'CHATS.PINNED': '置顶',
    'CHATS.UNREAD': '未读',
    'CHATS.ARCHIVED': '已归档',
    'CHATS.PIN': '置顶',
    'CHATS.UNPIN': '取消置顶',
    'CHATS.MUTE': '静音',
    'CHATS.UNMUTE': '取消静音',
    'CHATS.ARCHIVE': '归档',
    'CHATS.UNARCHIVE': '取消归档',
    'CHATS.PINNED_TAG': '已置顶',
    'CHATS.MUTED_TAG': '已静音',
    'CHATS.UNREAD_TAG': '未读',
    'CHATS.EMPTY_COPY': '搜索用户名来开始第一个聊天。',
    'CHATS.SHARE_PASS': '分享邀请',
    'CHATS.SELECT_TO_CONTINUE': '选择一个聊天继续。',
    'CHATS.GROUP_PARTICIPANTS_SELECTED': '位参与者已选择',
  },
  'zh-Hant': {
    'TABS.CHATS': '聊天',
    'TABS.WORLD': '聯絡人',
    'TABS.VAULT': '保險庫',
    'TABS.CALLS': '通話',
    'TABS.ACCOUNT': '帳戶',
    'TABS.LOGOUT': '登出',
  },
};

const LAUNCH_TRANSLATIONS: TranslationDictionary = {
  "es": {
    "LAUNCH.CHECKING": "Preparando tu espacio privado",
    "LAUNCH.ENCRYPTED": "Tus mensajes permanecen cifrados",
    "settings.wallpaper.silk": "Seda"
  },
  "en": {
    "LAUNCH.CHECKING": "Preparing your private space",
    "LAUNCH.ENCRYPTED": "Your messages stay encrypted",
    "settings.wallpaper.silk": "Silk"
  },
  "ar": {
    "LAUNCH.CHECKING": "جارٍ تجهيز مساحتك الخاصة",
    "LAUNCH.ENCRYPTED": "تبقى رسائلك مشفرة",
    "settings.wallpaper.silk": "حرير"
  },
  "de": {
    "LAUNCH.CHECKING": "Dein privater Bereich wird vorbereitet",
    "LAUNCH.ENCRYPTED": "Deine Nachrichten bleiben verschlüsselt",
    "settings.wallpaper.silk": "Seide"
  },
  "fr": {
    "LAUNCH.CHECKING": "Préparation de votre espace privé",
    "LAUNCH.ENCRYPTED": "Vos messages restent chiffrés",
    "settings.wallpaper.silk": "Soie"
  },
  "hi": {
    "LAUNCH.CHECKING": "आपका निजी स्थान तैयार हो रहा है",
    "LAUNCH.ENCRYPTED": "आपके संदेश एन्क्रिप्टेड रहते हैं",
    "settings.wallpaper.silk": "रेशम"
  },
  "ja": {
    "LAUNCH.CHECKING": "プライベートな空間を準備しています",
    "LAUNCH.ENCRYPTED": "メッセージは暗号化されたままです",
    "settings.wallpaper.silk": "シルク"
  },
  "pt": {
    "LAUNCH.CHECKING": "Preparando seu espaço privado",
    "LAUNCH.ENCRYPTED": "Suas mensagens permanecem criptografadas",
    "settings.wallpaper.silk": "Seda"
  },
  "ru": {
    "LAUNCH.CHECKING": "Подготовка вашего личного пространства",
    "LAUNCH.ENCRYPTED": "Ваши сообщения остаются зашифрованными",
    "settings.wallpaper.silk": "Шёлк"
  },
  "zh-Hans": {
    "LAUNCH.CHECKING": "正在准备你的私人空间",
    "LAUNCH.ENCRYPTED": "你的消息始终保持加密",
    "settings.wallpaper.silk": "丝绸"
  }
};
for (const [language, terms] of Object.entries(LAUNCH_TRANSLATIONS)) {
  Object.assign(TRANSLATIONS[language] ??= {}, terms);
}

const CAMERA_RECOVERY_TRANSLATIONS: TranslationDictionary = {
  "es": {
    "CALLS.CAMERA_PERMISSION_ERROR": "Permite el acceso a la cámara y vuelve a intentarlo. El audio continúa.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "No se encontró una cámara. Conecta una cámara y vuelve a intentarlo; el audio continúa.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "No se pudo iniciar la cámara. Revisa los permisos del navegador y si otra aplicación la está usando; el audio continúa.",
    "CALLS.CAMERA_UPGRADE_ERROR": "No se pudo actualizar el video. El audio continúa; vuelve a intentarlo."
  },
  "en": {
    "CALLS.CAMERA_PERMISSION_ERROR": "Allow camera access and try again. Audio continues.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "No camera was found. Connect a camera and try again; audio continues.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "The camera could not start. Check browser permissions and whether another app is using it; audio continues.",
    "CALLS.CAMERA_UPGRADE_ERROR": "Video could not be updated. Audio continues; try again."
  },
  "ar": {
    "CALLS.CAMERA_PERMISSION_ERROR": "اسمح بالوصول إلى الكاميرا ثم حاول مجددًا. يستمر الصوت.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "لم يتم العثور على كاميرا. صِل كاميرا ثم حاول مجددًا؛ يستمر الصوت.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "تعذر تشغيل الكاميرا. تحقق من أذونات المتصفح ومن استخدام تطبيق آخر لها؛ يستمر الصوت.",
    "CALLS.CAMERA_UPGRADE_ERROR": "تعذر تحديث الفيديو. يستمر الصوت؛ حاول مجددًا."
  },
  "de": {
    "CALLS.CAMERA_PERMISSION_ERROR": "Erlaube den Kamerazugriff und versuche es erneut. Das Audio läuft weiter.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "Keine Kamera gefunden. Schließe eine Kamera an und versuche es erneut; das Audio läuft weiter.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "Die Kamera konnte nicht starten. Prüfe die Browserberechtigungen und ob eine andere App sie nutzt; das Audio läuft weiter.",
    "CALLS.CAMERA_UPGRADE_ERROR": "Das Video konnte nicht aktualisiert werden. Das Audio läuft weiter; versuche es erneut."
  },
  "fr": {
    "CALLS.CAMERA_PERMISSION_ERROR": "Autorisez l’accès à la caméra et réessayez. L’audio continue.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "Aucune caméra trouvée. Branchez une caméra et réessayez ; l’audio continue.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "La caméra n’a pas pu démarrer. Vérifiez les autorisations du navigateur et si une autre application l’utilise ; l’audio continue.",
    "CALLS.CAMERA_UPGRADE_ERROR": "La vidéo n’a pas pu être mise à jour. L’audio continue ; réessayez."
  },
  "hi": {
    "CALLS.CAMERA_PERMISSION_ERROR": "कैमरे की अनुमति दें और फिर कोशिश करें। ऑडियो जारी है।",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "कोई कैमरा नहीं मिला। कैमरा कनेक्ट करें और फिर कोशिश करें; ऑडियो जारी है।",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "कैमरा शुरू नहीं हो सका। ब्राउज़र की अनुमतियाँ और किसी दूसरे ऐप द्वारा कैमरे का उपयोग जाँचें; ऑडियो जारी है।",
    "CALLS.CAMERA_UPGRADE_ERROR": "वीडियो अपडेट नहीं हो सका। ऑडियो जारी है; फिर कोशिश करें।"
  },
  "ja": {
    "CALLS.CAMERA_PERMISSION_ERROR": "カメラへのアクセスを許可して再試行してください。音声は続きます。",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "カメラが見つかりません。カメラを接続して再試行してください。音声は続きます。",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "カメラを起動できませんでした。ブラウザの権限や他のアプリが使用していないか確認してください。音声は続きます。",
    "CALLS.CAMERA_UPGRADE_ERROR": "映像を更新できませんでした。音声は続きます。再試行してください。"
  },
  "pt": {
    "CALLS.CAMERA_PERMISSION_ERROR": "Permita o acesso à câmera e tente novamente. O áudio continua.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "Nenhuma câmera encontrada. Conecte uma câmera e tente novamente; o áudio continua.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "Não foi possível iniciar a câmera. Confira as permissões do navegador e se outro aplicativo está usando a câmera; o áudio continua.",
    "CALLS.CAMERA_UPGRADE_ERROR": "Não foi possível atualizar o vídeo. O áudio continua; tente novamente."
  },
  "ru": {
    "CALLS.CAMERA_PERMISSION_ERROR": "Разрешите доступ к камере и повторите попытку. Звук продолжается.",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "Камера не найдена. Подключите камеру и повторите попытку; звук продолжается.",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "Не удалось запустить камеру. Проверьте разрешения браузера и не использует ли её другое приложение; звук продолжается.",
    "CALLS.CAMERA_UPGRADE_ERROR": "Не удалось обновить видео. Звук продолжается; повторите попытку."
  },
  "zh-Hans": {
    "CALLS.CAMERA_PERMISSION_ERROR": "请允许访问摄像头后重试。音频会继续。",
    "CALLS.CAMERA_NOT_FOUND_ERROR": "未找到摄像头。请连接摄像头后重试；音频会继续。",
    "CALLS.CAMERA_UNAVAILABLE_ERROR": "无法启动摄像头。请检查浏览器权限以及其他应用是否正在使用它；音频会继续。",
    "CALLS.CAMERA_UPGRADE_ERROR": "无法更新视频。音频会继续；请重试。"
  }
};
for (const [language, terms] of Object.entries(CAMERA_RECOVERY_TRANSLATIONS)) {
  Object.assign(TRANSLATIONS[language] ??= {}, terms);
}

const HISTORY_DEVICE_TRANSLATIONS: TranslationDictionary = {
  "es": {
    "HISTORY_DEVICE.SYNCING": "Sincronizando tu historial",
    "HISTORY_DEVICE.PENDING": "Historial cifrado pendiente",
    "HISTORY_DEVICE.HINT": "Abre la versión actual de Nivra en un dispositivo donde ya veas tus chats y autoriza este código. Después tu historial se sincronizará cifrado.",
    "HISTORY_DEVICE.APPROVE_TITLE": "Vincular historial cifrado",
    "HISTORY_DEVICE.NEW_DEVICE": "Nuevo dispositivo",
    "HISTORY_DEVICE.COMPARE_HINT": "Compara este código con el que aparece en tu otro dispositivo. Compártelo sólo si ambos coinciden.",
    "HISTORY_DEVICE.COMPARED": "Los códigos coinciden en mis dos dispositivos",
    "HISTORY_DEVICE.SHARE": "Compartir mi historial",
    "HISTORY_DEVICE.APPROVAL_ERROR": "No se pudo compartir el historial. Comprueba el código y vuelve a intentar."
  },
  "en": {
    "HISTORY_DEVICE.SYNCING": "Syncing your history",
    "HISTORY_DEVICE.PENDING": "Encrypted history pending",
    "HISTORY_DEVICE.HINT": "Open the current version of Nivra on a device where you can already see your chats and approve this code. Your history will then sync encrypted.",
    "HISTORY_DEVICE.APPROVE_TITLE": "Link encrypted history",
    "HISTORY_DEVICE.NEW_DEVICE": "New device",
    "HISTORY_DEVICE.COMPARE_HINT": "Compare this code with the one shown on your other device. Share only if both match.",
    "HISTORY_DEVICE.COMPARED": "The codes match on both of my devices",
    "HISTORY_DEVICE.SHARE": "Share my history",
    "HISTORY_DEVICE.APPROVAL_ERROR": "History could not be shared. Check the code and try again."
  },
  "ar": {
    "HISTORY_DEVICE.SYNCING": "جارٍ مزامنة سجلك",
    "HISTORY_DEVICE.PENDING": "السجل المشفر قيد الانتظار",
    "HISTORY_DEVICE.HINT": "افتح الإصدار الحالي من Nivra على جهاز تظهر فيه محادثاتك بالفعل ووافق على هذا الرمز. بعدها ستتم مزامنة سجلك مشفرًا.",
    "HISTORY_DEVICE.APPROVE_TITLE": "ربط السجل المشفر",
    "HISTORY_DEVICE.NEW_DEVICE": "جهاز جديد",
    "HISTORY_DEVICE.COMPARE_HINT": "قارن هذا الرمز بالرمز الظاهر على جهازك الآخر. شارك فقط إذا تطابقا.",
    "HISTORY_DEVICE.COMPARED": "الرمزان متطابقان على جهازيّ",
    "HISTORY_DEVICE.SHARE": "مشاركة سجلي",
    "HISTORY_DEVICE.APPROVAL_ERROR": "تعذرت مشاركة السجل. تحقق من الرمز ثم حاول مجددًا."
  },
  "de": {
    "HISTORY_DEVICE.SYNCING": "Dein Verlauf wird synchronisiert",
    "HISTORY_DEVICE.PENDING": "Verschlüsselter Verlauf ausstehend",
    "HISTORY_DEVICE.HINT": "Öffne die aktuelle Nivra-Version auf einem Gerät, auf dem du deine Chats bereits siehst, und bestätige diesen Code. Dein Verlauf wird dann verschlüsselt synchronisiert.",
    "HISTORY_DEVICE.APPROVE_TITLE": "Verschlüsselten Verlauf verknüpfen",
    "HISTORY_DEVICE.NEW_DEVICE": "Neues Gerät",
    "HISTORY_DEVICE.COMPARE_HINT": "Vergleiche diesen Code mit dem auf deinem anderen Gerät. Teile nur, wenn beide übereinstimmen.",
    "HISTORY_DEVICE.COMPARED": "Die Codes stimmen auf meinen beiden Geräten überein",
    "HISTORY_DEVICE.SHARE": "Meinen Verlauf teilen",
    "HISTORY_DEVICE.APPROVAL_ERROR": "Der Verlauf konnte nicht geteilt werden. Prüfe den Code und versuche es erneut."
  },
  "fr": {
    "HISTORY_DEVICE.SYNCING": "Synchronisation de votre historique",
    "HISTORY_DEVICE.PENDING": "Historique chiffré en attente",
    "HISTORY_DEVICE.HINT": "Ouvrez la version actuelle de Nivra sur un appareil où vos discussions sont déjà visibles et autorisez ce code. Votre historique sera ensuite synchronisé de façon chiffrée.",
    "HISTORY_DEVICE.APPROVE_TITLE": "Lier l’historique chiffré",
    "HISTORY_DEVICE.NEW_DEVICE": "Nouvel appareil",
    "HISTORY_DEVICE.COMPARE_HINT": "Comparez ce code avec celui affiché sur votre autre appareil. Partagez seulement si les deux correspondent.",
    "HISTORY_DEVICE.COMPARED": "Les codes correspondent sur mes deux appareils",
    "HISTORY_DEVICE.SHARE": "Partager mon historique",
    "HISTORY_DEVICE.APPROVAL_ERROR": "L’historique n’a pas pu être partagé. Vérifiez le code et réessayez."
  },
  "hi": {
    "HISTORY_DEVICE.SYNCING": "आपका इतिहास सिंक हो रहा है",
    "HISTORY_DEVICE.PENDING": "एन्क्रिप्टेड इतिहास लंबित है",
    "HISTORY_DEVICE.HINT": "जिस डिवाइस पर आपकी चैट पहले से दिखती हैं, वहाँ Nivra का मौजूदा संस्करण खोलें और इस कोड को मंज़ूरी दें। इसके बाद आपका इतिहास एन्क्रिप्टेड रूप में सिंक होगा।",
    "HISTORY_DEVICE.APPROVE_TITLE": "एन्क्रिप्टेड इतिहास लिंक करें",
    "HISTORY_DEVICE.NEW_DEVICE": "नया डिवाइस",
    "HISTORY_DEVICE.COMPARE_HINT": "इस कोड की तुलना अपने दूसरे डिवाइस पर दिखने वाले कोड से करें। दोनों मेल खाने पर ही साझा करें।",
    "HISTORY_DEVICE.COMPARED": "मेरे दोनों डिवाइस पर कोड मेल खाते हैं",
    "HISTORY_DEVICE.SHARE": "मेरा इतिहास साझा करें",
    "HISTORY_DEVICE.APPROVAL_ERROR": "इतिहास साझा नहीं हो सका। कोड जाँचें और फिर कोशिश करें।"
  },
  "ja": {
    "HISTORY_DEVICE.SYNCING": "履歴を同期しています",
    "HISTORY_DEVICE.PENDING": "暗号化された履歴の同期待ち",
    "HISTORY_DEVICE.HINT": "チャットがすでに表示される端末で最新のNivraを開き、このコードを承認してください。その後、履歴は暗号化された状態で同期されます。",
    "HISTORY_DEVICE.APPROVE_TITLE": "暗号化された履歴をリンク",
    "HISTORY_DEVICE.NEW_DEVICE": "新しい端末",
    "HISTORY_DEVICE.COMPARE_HINT": "このコードをもう一方の端末のコードと比較してください。両方が一致する場合のみ共有してください。",
    "HISTORY_DEVICE.COMPARED": "両方の端末でコードが一致しています",
    "HISTORY_DEVICE.SHARE": "履歴を共有",
    "HISTORY_DEVICE.APPROVAL_ERROR": "履歴を共有できませんでした。コードを確認して再試行してください。"
  },
  "pt": {
    "HISTORY_DEVICE.SYNCING": "Sincronizando seu histórico",
    "HISTORY_DEVICE.PENDING": "Histórico criptografado pendente",
    "HISTORY_DEVICE.HINT": "Abra a versão atual do Nivra em um dispositivo onde seus chats já aparecem e autorize este código. Depois, seu histórico será sincronizado com criptografia.",
    "HISTORY_DEVICE.APPROVE_TITLE": "Vincular histórico criptografado",
    "HISTORY_DEVICE.NEW_DEVICE": "Novo dispositivo",
    "HISTORY_DEVICE.COMPARE_HINT": "Compare este código com o que aparece no outro dispositivo. Compartilhe somente se ambos forem iguais.",
    "HISTORY_DEVICE.COMPARED": "Os códigos coincidem nos meus dois dispositivos",
    "HISTORY_DEVICE.SHARE": "Compartilhar meu histórico",
    "HISTORY_DEVICE.APPROVAL_ERROR": "Não foi possível compartilhar o histórico. Confira o código e tente novamente."
  },
  "ru": {
    "HISTORY_DEVICE.SYNCING": "Синхронизация вашей истории",
    "HISTORY_DEVICE.PENDING": "Ожидается зашифрованная история",
    "HISTORY_DEVICE.HINT": "Откройте текущую версию Nivra на устройстве, где уже видны ваши чаты, и подтвердите этот код. Затем история синхронизируется в зашифрованном виде.",
    "HISTORY_DEVICE.APPROVE_TITLE": "Связать зашифрованную историю",
    "HISTORY_DEVICE.NEW_DEVICE": "Новое устройство",
    "HISTORY_DEVICE.COMPARE_HINT": "Сравните этот код с кодом на другом устройстве. Делитесь только при совпадении.",
    "HISTORY_DEVICE.COMPARED": "Коды совпадают на обоих моих устройствах",
    "HISTORY_DEVICE.SHARE": "Поделиться моей историей",
    "HISTORY_DEVICE.APPROVAL_ERROR": "Не удалось поделиться историей. Проверьте код и повторите попытку."
  },
  "zh-Hans": {
    "HISTORY_DEVICE.SYNCING": "正在同步你的历史记录",
    "HISTORY_DEVICE.PENDING": "加密历史记录等待同步",
    "HISTORY_DEVICE.HINT": "在已经能看到聊天的设备上打开当前版本的 Nivra，并授权此代码。之后历史记录将以加密方式同步。",
    "HISTORY_DEVICE.APPROVE_TITLE": "关联加密历史记录",
    "HISTORY_DEVICE.NEW_DEVICE": "新设备",
    "HISTORY_DEVICE.COMPARE_HINT": "将此代码与另一台设备上显示的代码进行比较。仅在两者一致时共享。",
    "HISTORY_DEVICE.COMPARED": "两台设备上的代码一致",
    "HISTORY_DEVICE.SHARE": "共享我的历史记录",
    "HISTORY_DEVICE.APPROVAL_ERROR": "无法共享历史记录。请检查代码后重试。"
  }
};
for (const [language, terms] of Object.entries(HISTORY_DEVICE_TRANSLATIONS)) {
  Object.assign(TRANSLATIONS[language] ??= {}, terms);
}

const IDENTITY_CHANGE_TRANSLATIONS: TranslationDictionary = {
  "es": {
    "CHAT.IDENTITY_CHANGED_TITLE": "El código de seguridad cambió",
    "CHAT.IDENTITY_CHANGED_COPY": "Puede ocurrir al vincular otro dispositivo o reinstalar. Compara el código con tu contacto para continuar.",
    "CHAT.IDENTITY_VERIFY_ACTION": "Verificar identidad"
  },
  "en": {
    "CHAT.IDENTITY_CHANGED_TITLE": "The security code changed",
    "CHAT.IDENTITY_CHANGED_COPY": "This can happen after linking another device or reinstalling. Compare the code with your contact to continue.",
    "CHAT.IDENTITY_VERIFY_ACTION": "Verify identity"
  },
  "ar": {
    "CHAT.IDENTITY_CHANGED_TITLE": "تغيّر رمز الأمان",
    "CHAT.IDENTITY_CHANGED_COPY": "قد يحدث هذا عند ربط جهاز آخر أو إعادة التثبيت. قارن الرمز مع جهة اتصالك للمتابعة.",
    "CHAT.IDENTITY_VERIFY_ACTION": "التحقق من الهوية"
  },
  "de": {
    "CHAT.IDENTITY_CHANGED_TITLE": "Der Sicherheitscode hat sich geändert",
    "CHAT.IDENTITY_CHANGED_COPY": "Dies kann nach dem Verknüpfen eines weiteren Geräts oder einer Neuinstallation passieren. Vergleiche den Code mit deinem Kontakt, um fortzufahren.",
    "CHAT.IDENTITY_VERIFY_ACTION": "Identität prüfen"
  },
  "fr": {
    "CHAT.IDENTITY_CHANGED_TITLE": "Le code de sécurité a changé",
    "CHAT.IDENTITY_CHANGED_COPY": "Cela peut arriver après l’association d’un autre appareil ou une réinstallation. Comparez le code avec votre contact pour continuer.",
    "CHAT.IDENTITY_VERIFY_ACTION": "Vérifier l’identité"
  },
  "hi": {
    "CHAT.IDENTITY_CHANGED_TITLE": "सुरक्षा कोड बदल गया है",
    "CHAT.IDENTITY_CHANGED_COPY": "ऐसा कोई दूसरा डिवाइस जोड़ने या दोबारा इंस्टॉल करने के बाद हो सकता है। जारी रखने के लिए अपने संपर्क से कोड की तुलना करें।",
    "CHAT.IDENTITY_VERIFY_ACTION": "पहचान सत्यापित करें"
  },
  "ja": {
    "CHAT.IDENTITY_CHANGED_TITLE": "セキュリティコードが変更されました",
    "CHAT.IDENTITY_CHANGED_COPY": "別のデバイスのリンクや再インストールによって変更されることがあります。続けるには相手とコードを比較してください。",
    "CHAT.IDENTITY_VERIFY_ACTION": "本人確認"
  },
  "pt": {
    "CHAT.IDENTITY_CHANGED_TITLE": "O código de segurança mudou",
    "CHAT.IDENTITY_CHANGED_COPY": "Isso pode acontecer após vincular outro dispositivo ou reinstalar. Compare o código com seu contato para continuar.",
    "CHAT.IDENTITY_VERIFY_ACTION": "Verificar identidade"
  },
  "ru": {
    "CHAT.IDENTITY_CHANGED_TITLE": "Код безопасности изменился",
    "CHAT.IDENTITY_CHANGED_COPY": "Это может произойти после привязки другого устройства или переустановки. Сравните код с контактом, чтобы продолжить.",
    "CHAT.IDENTITY_VERIFY_ACTION": "Проверить личность"
  },
  "zh-Hans": {
    "CHAT.IDENTITY_CHANGED_TITLE": "安全代码已更改",
    "CHAT.IDENTITY_CHANGED_COPY": "关联其他设备或重新安装后可能出现这种情况。请与联系人核对代码后继续。",
    "CHAT.IDENTITY_VERIFY_ACTION": "验证身份"
  }
};
for (const [language, terms] of Object.entries(IDENTITY_CHANGE_TRANSLATIONS)) {
  Object.assign(TRANSLATIONS[language] ??= {}, terms);
}

@Injectable({ providedIn: 'root' })
export class NivraI18nService {
  private readonly appSettings = inject(AppSettingsService);

  readonly currentLanguage = computed(() => this.appSettings.settings().language);

  constructor() {
    effect(() => {
      this.applyDocumentLanguage(this.currentLanguage());
    });
  }

  use(language: string): void {
    this.appSettings.set('language', language);
    this.applyDocumentLanguage(language);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nivra:language-change', { detail: { language } }));
    }
  }

  t(key: string, fallback = ''): string {
    const language = this.normalizeLanguage(this.currentLanguage());
    return GLOBAL_TRANSLATIONS[language]?.[key]
      ?? TRANSLATIONS[language]?.[key]
      ?? GLOBAL_TRANSLATIONS['en']?.[key]
      ?? TRANSLATIONS['en']?.[key]
      ?? GLOBAL_TRANSLATIONS['es']?.[key]
      ?? TRANSLATIONS['es']?.[key]
      ?? fallback
      ?? key;
  }

  currentTerm(key: string): string {
    const language = this.normalizeLanguage(this.currentLanguage());
    return GLOBAL_TRANSLATIONS[language]?.[key]
      ?? TRANSLATIONS[language]?.[key]
      ?? '';
  }

  private normalizeLanguage(language: string): string {
    if (language.startsWith('zh')) {
      return 'zh-Hans';
    }
    const base = language.split('-')[0];
    if (SUPPORTED_LANGUAGES.has(language)) {
      return language;
    }
    if (SUPPORTED_LANGUAGES.has(base)) {
      return base;
    }
    return 'en';
  }

  private applyDocumentLanguage(language: string): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }
}
