/** Only known theme IDs travel in a story; remote content never supplies CSS. */
export const STORY_TEXT_THEMES = [
  {id:'nivra',name:'Esmeralda',background:'linear-gradient(145deg,#245e53,#0c1b25)',color:'#ffffff'},
  {id:'ocean',name:'Océano',background:'linear-gradient(145deg,#006e91,#163468)',color:'#ffffff'},
  {id:'lavender',name:'Lavanda',background:'linear-gradient(145deg,#6b4ea2,#37295a)',color:'#ffffff'},
  {id:'rose',name:'Rosa',background:'linear-gradient(145deg,#c65080,#803a6e)',color:'#ffffff'},
  {id:'sunset',name:'Atardecer',background:'linear-gradient(145deg,#c85a45,#8f3159)',color:'#ffffff'},
  {id:'cocoa',name:'Cacao',background:'linear-gradient(145deg,#8a624f,#3e3634)',color:'#ffffff'},
  {id:'forest',name:'Bosque',background:'linear-gradient(145deg,#477049,#193d3a)',color:'#ffffff'},
  {id:'midnight',name:'Medianoche',background:'linear-gradient(145deg,#29394d,#101720)',color:'#ffffff'},
  {id:'coral',name:'Coral',background:'#f5a694',color:'#33212a'},
  {id:'sand',name:'Arena',background:'#eddfbb',color:'#332f24'},
  {id:'mint',name:'Menta',background:'#bce9db',color:'#163c32'},
  {id:'lilac',name:'Lila',background:'#ddd3ed',color:'#38294a'},
] as const;
export function storyTextTheme(value: unknown) {
  return STORY_TEXT_THEMES.find(theme=>theme.id===value) ?? STORY_TEXT_THEMES[0];
}
