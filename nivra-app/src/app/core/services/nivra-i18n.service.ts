import { Injectable, computed, effect, inject } from '@angular/core';
import { AppSettingsService } from './app-settings.service';

type TranslationDictionary = Record<string, Record<string, string>>;

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
    return TRANSLATIONS[language]?.[key]
      ?? TRANSLATIONS['en']?.[key]
      ?? TRANSLATIONS['es']?.[key]
      ?? fallback
      ?? key;
  }

  private normalizeLanguage(language: string): string {
    if (TRANSLATIONS[language]) {
      return language;
    }
    return language.startsWith('zh') ? 'zh-Hans' : (language.startsWith('es') ? 'es' : 'en');
  }

  private applyDocumentLanguage(language: string): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }
}
