import { tabSwipeSnapshot } from './tab-swipe-snapshot';

describe('ephemeral tab preview redaction', () => {
  let page: HTMLElement;
  beforeEach(() => {
    page = document.createElement('section'); page.style.cssText = 'position:fixed;width:390px;height:600px;inset:0';
    page.innerHTML = '<p id="private-id" onclick="danger()">Visible chat fixture</p><form><input value="password fixture"><label>Form secret fixture</label></form><output>root phrase fixture</output><div class="phrase">Root recovery phrase</div><div data-snapshot-private>private payload</div><canvas></canvas><video src="https://invalid.test/video"></video><a href="https://invalid.test/token?secret=fixture">Visible link</a>';
    document.body.appendChild(page);
  });
  afterEach(() => page.remove());
  it('copies visible content into plain inert nodes without secrets, live controls, capabilities or duplicate IDs', () => {
    const snapshot = tabSwipeSnapshot(page, page.getBoundingClientRect());
    expect(snapshot.inert).toBeTrue(); expect(snapshot.getAttribute('aria-hidden')).toBe('true');
    expect(snapshot.textContent).toContain('Visible chat fixture'); expect(snapshot.textContent).toContain('Visible link');
    for (const secret of ['password fixture', 'Form secret fixture', 'root phrase fixture', 'Root recovery phrase', 'private payload', 'secret=fixture']) expect(snapshot.outerHTML).not.toContain(secret);
    expect(snapshot.querySelector('input,output,form,canvas,video,a,[id],[onclick],[href]')).toBeNull();
    expect(snapshot.style.width).toBe('390px'); expect(snapshot.style.height).toBe('600px');
  });
  it('flattens an existing shadow tree without instantiating another custom element or retaining listeners', () => {
    const component = document.createElement('preview-secret-component'); const shadow = component.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<strong>Shadow visible</strong><textarea>Do not retain secret</textarea>';
    page.replaceChildren(component);
    const snapshot = tabSwipeSnapshot(page, page.getBoundingClientRect());
    expect(snapshot.textContent).toContain('Shadow visible'); expect(snapshot.textContent).not.toContain('Do not retain secret');
    expect(snapshot.querySelector('preview-secret-component,textarea')).toBeNull();
  });
  it('omits overlay trees and image capabilities from redacted private surfaces', () => {
    const privateArea = page.querySelector<HTMLElement>('[data-snapshot-private]')!;
    privateArea.style.backgroundImage = 'url("https://invalid.test/private-background-capability")';
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); modal.textContent = 'Inline modal sensitive text';
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.textContent = 'Private menu content';
    page.append(modal, menu);
    const snapshot = tabSwipeSnapshot(page, page.getBoundingClientRect());
    for (const value of ['private-background-capability', 'Inline modal sensitive text', 'Private menu content']) expect(snapshot.outerHTML).not.toContain(value);
  });
});
