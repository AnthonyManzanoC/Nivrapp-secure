import { SystemUiService } from './system-ui.service';

describe('System UI overlay restoration', () => {
  it('keeps system bars legible until the last overlapping story viewer closes', () => {
    const ui = new SystemUiService();
    const first = ui.acquireDarkOverlay(), second = ui.acquireDarkOverlay();
    first();
    expect(ui.darkOverlay()).toBeTrue();
    first(); // Destroy callbacks may be invoked after another overlay has opened.
    expect(ui.darkOverlay()).toBeTrue();
    second();
    expect(ui.darkOverlay()).toBeFalse();
    const next = ui.acquireDarkOverlay();
    expect(ui.darkOverlay()).toBeTrue();
    next();
    expect(ui.darkOverlay()).toBeFalse();
  });
});
