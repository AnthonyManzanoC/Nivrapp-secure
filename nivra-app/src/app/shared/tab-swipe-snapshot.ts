// Plain inert visual nodes only: never retain a second live Angular/Ionic tree.
const VISUAL_PROPERTIES = ['display','box-sizing','position','top','right','bottom','left','width','height','min-width','min-height','max-width','max-height','margin','padding',
  'flex','flex-direction','flex-wrap','align-items','align-content','align-self','justify-content','gap','grid-template-columns','grid-template-rows','grid-column','grid-row',
  'background-color','background-image','background-size','background-position','border','border-radius','box-shadow','color','font','font-weight','font-size','line-height',
  'letter-spacing','text-align','text-transform','text-decoration','white-space','word-break','overflow-wrap','vertical-align','overflow','overflow-x','overflow-y','opacity','transform','object-fit','object-position'];
const PRIVATE_SURFACES = 'input,textarea,select,output,form,[contenteditable]:not([contenteditable="false"]),[data-snapshot-private],app-account-identity-recovery,app-live-device-link,.phrase,.share-qr,.qr-scanner';
const FORBIDDEN = 'script,style,link,iframe,object,embed,template,video,audio,canvas,ion-modal,ion-alert,ion-action-sheet,ion-popover,ion-picker,dialog,[aria-modal="true"],[role="menu"],[aria-hidden="true"],[inert]';
const SVG_ATTRIBUTES = new Set(['viewBox','d','fill','fill-rule','clip-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','cx','cy','r','rx','ry','x','y','x1','y1','x2','y2','width','height','points','transform']);

/** Bounded same-session RAM snapshot. Forms, recovery phrases, media and capabilities are omitted. */
export function tabSwipeSnapshot(page: HTMLElement, viewport: DOMRect): HTMLElement {
  let budget = 1800;
  const copy = (source: Node): Node | null => {
    if (--budget < 0) return null;
    if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent ?? '');
    if (!(source instanceof Element) || source.matches(FORBIDDEN)) return null;
    const rect = source.getBoundingClientRect(), style = getComputedStyle(source);
    if (style.display === 'none' || style.visibility === 'hidden' || source.hasAttribute('hidden')) return null;
    const svg = source.namespaceURI === 'http://www.w3.org/2000/svg';
    const clone = svg ? document.createElementNS(source.namespaceURI!, source.localName)
      : document.createElement(source.localName === 'img' ? 'img' : 'div');
    for (const attr of Array.from(source.attributes)) {
      if (attr.name === 'class' || attr.name.startsWith('_ngcontent-') || (svg && SVG_ATTRIBUTES.has(attr.name))) clone.setAttribute(attr.name, attr.value);
    }
    const element = clone as HTMLElement;
    for (const name of VISUAL_PROPERTIES) element.style.setProperty(name, style.getPropertyValue(name));
    element.style.setProperty('animation', 'none', 'important'); element.style.setProperty('transition', 'none', 'important');
    element.style.setProperty('pointer-events', 'none', 'important'); element.style.setProperty('user-select', 'none', 'important');
    // Retain the box of clipped/off-screen rows without retaining their private descendants.
    const outside = rect.width > 0 && rect.height > 0 && (rect.bottom < viewport.top || rect.top > viewport.bottom || rect.right < viewport.left || rect.left > viewport.right);
    if (outside || source.matches(PRIVATE_SURFACES)) {
      element.style.boxSizing = 'border-box'; element.style.width = `${rect.width}px`; element.style.height = `${rect.height}px`;
      element.style.setProperty('background-image', 'none', 'important');
      return clone;
    }
    if (source instanceof HTMLImageElement && source.currentSrc) (clone as HTMLImageElement).src = source.currentSrc;
    if (source instanceof HTMLElement) {
      if (source.scrollTop) clone.setAttribute('data-preview-scroll-top', String(source.scrollTop));
      if (source.scrollLeft) clone.setAttribute('data-preview-scroll-left', String(source.scrollLeft));
    }
    const children = source.localName === 'slot' ? (source as HTMLSlotElement).assignedNodes({ flatten: true }) : source.shadowRoot?.childNodes ?? source.childNodes;
    for (const child of Array.from(children)) { const result = copy(child); if (result) clone.appendChild(result); }
    return clone;
  };
  const result = copy(page) as HTMLElement | null ?? document.createElement('div');
  result.setAttribute('aria-hidden', 'true'); result.inert = true;
  result.style.position = 'relative'; result.style.margin = '0'; result.style.width = `${viewport.width}px`; result.style.height = `${viewport.height}px`;
  result.style.transform = 'none'; result.style.overflow = 'hidden';
  return result;
}

export function restoreTabSnapshotScroll(root: HTMLElement): void {
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('[data-preview-scroll-top],[data-preview-scroll-left]'))]) {
    element.scrollTop = Number(element.getAttribute('data-preview-scroll-top') ?? 0);
    element.scrollLeft = Number(element.getAttribute('data-preview-scroll-left') ?? 0);
  }
}
