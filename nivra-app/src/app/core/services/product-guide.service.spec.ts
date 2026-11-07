import { TestBed } from '@angular/core/testing';
import { ProductGuideService } from './product-guide.service';

describe('product guide preferences', () => {
  const alice = 'guide-test-alice', bob = 'guide-test-bob';
  beforeEach(() => { localStorage.removeItem(`nivra.guide.v1.${alice}`); localStorage.removeItem(`nivra.guide.v1.${bob}`); });
  afterEach(() => { localStorage.removeItem(`nivra.guide.v1.${alice}`); localStorage.removeItem(`nivra.guide.v1.${bob}`); });
  it('keeps introduction and practice progress separate for each account', () => {
    const guide = TestBed.inject(ProductGuideService);
    guide.introduce(alice); guide.toggle(alice, 'contact');
    expect(guide.progress(alice)).toEqual({ introduced: true, completed: ['contact'] });
    expect(guide.progress(bob)).toEqual({ introduced: false, completed: [] });
    guide.toggle(alice, 'contact');
    expect(guide.progress(alice).completed).toEqual([]);
  });
  it('restores progress after relaunch without claiming tasks were verified', () => {
    TestBed.inject(ProductGuideService).toggle(alice, 'recovery');
    TestBed.resetTestingModule();
    expect(TestBed.inject(ProductGuideService).progress(alice)).toEqual({ introduced: false, completed: ['recovery'] });
  });
  it('handles damaged storage and accepts only supported task IDs', () => {
    localStorage.setItem(`nivra.guide.v1.${alice}`, '{broken');
    const guide = TestBed.inject(ProductGuideService);
    expect(guide.progress(alice).introduced).toBeFalse();
    guide.toggle(alice, 'unknown');
    expect(guide.progress(alice).completed).toEqual([]);
  });
  it('remains usable when browser storage is blocked', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    const guide = TestBed.inject(ProductGuideService);
    guide.introduce(alice); guide.toggle(alice, 'message');
    expect(guide.progress(alice)).toEqual({ introduced: true, completed: ['message'] });
  });
});
