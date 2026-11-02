import { STORY_TEXT_THEMES, storyTextTheme } from './story-theme';
describe('safe story background palette',()=>{
  it('keeps old stories readable and ignores untrusted CSS or unknown theme IDs',()=>{
    for(const value of [undefined,null,'old-style','url(https://example.invalid/pixel)','red;position:fixed',{}])expect(storyTextTheme(value).id).toBe('nivra');
  });
  it('offers twelve distinct stable themes with an explicit contrasting text color',()=>{
    expect(STORY_TEXT_THEMES.length).toBe(12);expect(new Set(STORY_TEXT_THEMES.map(t=>t.id)).size).toBe(12);
    for(const theme of STORY_TEXT_THEMES){expect(storyTextTheme(theme.id)).toEqual(theme);expect(theme.color).toMatch(/^#[a-f0-9]{6}$/i);}
  });
});
