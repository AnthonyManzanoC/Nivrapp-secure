export type EmojiCategoryId = 'faces' | 'gestures' | 'hearts' | 'animals' | 'food' | 'travel' | 'objects';

export interface ChatEmoji {
  value: string;
  category: EmojiCategoryId;
  es: string;
  en: string;
  keywords: string;
}

export const EMOJI_CATEGORIES: { id: EmojiCategoryId; icon: string; es: string; en: string }[] = [
  { id: 'faces', icon: '😊', es: 'Caras', en: 'Faces' },
  { id: 'gestures', icon: '👋', es: 'Gestos', en: 'Gestures' },
  { id: 'hearts', icon: '💚', es: 'Amor', en: 'Love' },
  { id: 'animals', icon: '🐻', es: 'Naturaleza', en: 'Nature' },
  { id: 'food', icon: '🍕', es: 'Comida', en: 'Food' },
  { id: 'travel', icon: '🚀', es: 'Viajes', en: 'Travel' },
  { id: 'objects', icon: '💡', es: 'Objetos', en: 'Objects' },
];

// Deliberately local: searching and choosing expressions never sends a query to a service.
const groups: Record<EmojiCategoryId, [string, string, string, string?][]> = {
  faces: [
    ['😀', 'Sonrisa', 'Grinning face', 'feliz happy smile'], ['😃', 'Muy feliz', 'Happy face'],
    ['😄', 'Sonrisa con ojos felices', 'Smiling eyes'], ['😁', 'Sonrisa radiante', 'Beaming face'],
    ['😆', 'Carcajada', 'Laughing face'], ['😅', 'Sonrisa con sudor', 'Sweat smile', 'nervios nervous'],
    ['😂', 'Lágrimas de risa', 'Tears of joy', 'jajaja lol laughing'], ['🤣', 'Rodando de risa', 'Rolling on floor laughing', 'jajaja rofl'],
    ['😊', 'Sonrisa tímida', 'Blushing smile'], ['🙂', 'Sonrisa suave', 'Slight smile'],
    ['🙃', 'Cara al revés', 'Upside down face', 'ironia irony'], ['😉', 'Guiño', 'Winking face'],
    ['😍', 'Ojos de corazón', 'Heart eyes', 'amor love'], ['🥰', 'Cara con corazones', 'Smiling with hearts', 'amor love'],
    ['😘', 'Beso', 'Blowing kiss'], ['😗', 'Cara besando', 'Kissing face'],
    ['😎', 'Gafas de sol', 'Sunglasses face', 'cool genial'], ['🤩', 'Ojos de estrellas', 'Star struck'],
    ['🥳', 'Fiesta', 'Party face', 'celebrar celebrate birthday cumpleaños'], ['🤗', 'Abrazo', 'Hugging face'],
    ['🤔', 'Pensando', 'Thinking face', 'pregunta question'], ['🤨', 'Ceja levantada', 'Raised eyebrow'],
    ['😐', 'Cara neutral', 'Neutral face'], ['😑', 'Sin expresión', 'Expressionless face'],
    ['😶', 'Sin palabras', 'Face without mouth'], ['🫠', 'Derritiéndose', 'Melting face'],
    ['🤭', 'Tapándose la boca', 'Hand over mouth'], ['🫢', 'Sorprendido con mano', 'Surprised hand over mouth'],
    ['🤫', 'Silencio', 'Shushing face', 'secreto secret'], ['🤥', 'Mentira', 'Lying face'],
    ['😏', 'Sonrisa pícara', 'Smirking face'], ['😌', 'Alivio', 'Relieved face'],
    ['😴', 'Dormido', 'Sleeping face', 'sueño sleep'], ['🥱', 'Bostezo', 'Yawning face'],
    ['😪', 'Somnoliento', 'Sleepy face'], ['😋', 'Delicioso', 'Yummy face'],
    ['😛', 'Sacando la lengua', 'Tongue out'], ['😜', 'Guiño con lengua', 'Wink with tongue'],
    ['🤪', 'Cara alocada', 'Zany face'], ['🤑', 'Cara de dinero', 'Money mouth'],
    ['😔', 'Pensativo triste', 'Pensive face'], ['😞', 'Decepcionado', 'Disappointed face'],
    ['😢', 'Llorando', 'Crying face', 'triste sad'], ['😭', 'Llorando mucho', 'Loudly crying face'],
    ['🥺', 'Por favor', 'Pleading face'], ['🥹', 'Emocionado', 'Holding back tears'],
    ['😤', 'Resoplando', 'Huffing face'], ['😠', 'Enojado', 'Angry face'],
    ['😡', 'Muy enojado', 'Pouting face'], ['🤯', 'Cabeza explotando', 'Exploding head'],
    ['😳', 'Sonrojado', 'Flushed face'], ['😱', 'Grito de miedo', 'Screaming face'],
    ['😨', 'Asustado', 'Fearful face'], ['😰', 'Preocupado', 'Anxious face'],
    ['😮', 'Sorprendido', 'Surprised face'], ['😯', 'Asombrado', 'Hushed face'],
    ['😲', 'Atónito', 'Astonished face'], ['🤒', 'Fiebre', 'Thermometer face'],
    ['🤕', 'Vendaje', 'Bandaged face'], ['🤢', 'Náuseas', 'Nauseated face'],
    ['🤧', 'Estornudo', 'Sneezing face'], ['😷', 'Mascarilla', 'Medical mask'],
    ['🤠', 'Vaquero', 'Cowboy face'], ['🥸', 'Disfraz', 'Disguised face'],
    ['😇', 'Ángel', 'Angel face'], ['👻', 'Fantasma', 'Ghost'],
    ['🤖', 'Robot', 'Robot'], ['👽', 'Alien', 'Alien'],
  ],
  gestures: [
    ['👋', 'Hola', 'Waving hand', 'saludo hello bye adios'], ['🤚', 'Mano levantada', 'Raised back hand'],
    ['✋', 'Alto', 'Raised hand', 'stop'], ['🖖', 'Saludo vulcano', 'Vulcan salute'],
    ['👌', 'Perfecto', 'OK hand'], ['🤌', 'Dedos juntos', 'Pinched fingers'],
    ['🤏', 'Un poquito', 'Pinching hand'], ['✌️', 'Paz', 'Victory hand'],
    ['🤞', 'Dedos cruzados', 'Crossed fingers', 'suerte luck'], ['🤟', 'Te quiero', 'Love you gesture'],
    ['🤘', 'Rock', 'Sign of horns'], ['🤙', 'Llámame', 'Call me hand'],
    ['👈', 'Izquierda', 'Point left'], ['👉', 'Derecha', 'Point right'],
    ['👆', 'Arriba', 'Point up'], ['👇', 'Abajo', 'Point down'],
    ['👍', 'Me gusta', 'Thumbs up', 'bien good yes si'], ['👎', 'No me gusta', 'Thumbs down'],
    ['✊', 'Puño', 'Raised fist'], ['👊', 'Choque de puños', 'Fist bump'],
    ['👏', 'Aplausos', 'Clapping hands', 'bravo'], ['🙌', 'Celebración', 'Raising hands'],
    ['👐', 'Manos abiertas', 'Open hands'], ['🤲', 'Manos juntas', 'Palms together'],
    ['🤝', 'Acuerdo', 'Handshake'], ['🙏', 'Gracias', 'Folded hands', 'please prayer oracion por favor'],
    ['💪', 'Fuerza', 'Flexed biceps'], ['🫶', 'Manos corazón', 'Heart hands'],
    ['🫵', 'Tú', 'Point at you'], ['🤳', 'Selfie', 'Selfie'],
  ],
  hearts: [
    ['❤️', 'Corazón rojo', 'Red heart', 'amor love'], ['🧡', 'Corazón naranja', 'Orange heart'],
    ['💛', 'Corazón amarillo', 'Yellow heart'], ['💚', 'Corazón verde', 'Green heart'],
    ['💙', 'Corazón azul', 'Blue heart'], ['💜', 'Corazón violeta', 'Purple heart'],
    ['🖤', 'Corazón negro', 'Black heart'], ['🤍', 'Corazón blanco', 'White heart'],
    ['🤎', 'Corazón marrón', 'Brown heart'], ['🩷', 'Corazón rosa', 'Pink heart'],
    ['🩵', 'Corazón celeste', 'Light blue heart'], ['🩶', 'Corazón gris', 'Grey heart'],
    ['💔', 'Corazón roto', 'Broken heart'], ['❤️‍🔥', 'Corazón en llamas', 'Heart on fire'],
    ['❤️‍🩹', 'Corazón sanando', 'Mending heart'], ['💕', 'Dos corazones', 'Two hearts'],
    ['💞', 'Corazones girando', 'Revolving hearts'], ['💓', 'Corazón latiendo', 'Beating heart'],
    ['💗', 'Corazón creciendo', 'Growing heart'], ['💖', 'Corazón brillante', 'Sparkling heart'],
    ['💘', 'Corazón con flecha', 'Heart with arrow'], ['💝', 'Corazón de regalo', 'Heart with ribbon'],
    ['💌', 'Carta de amor', 'Love letter'], ['💋', 'Marca de beso', 'Kiss mark'],
  ],
  animals: [
    ['🐶', 'Perro', 'Dog'], ['🐱', 'Gato', 'Cat'], ['🐭', 'Ratón', 'Mouse'],
    ['🐹', 'Hámster', 'Hamster'], ['🐰', 'Conejo', 'Rabbit'], ['🦊', 'Zorro', 'Fox'],
    ['🐻', 'Oso', 'Bear'], ['🐼', 'Panda', 'Panda'], ['🐨', 'Koala', 'Koala'],
    ['🐯', 'Tigre', 'Tiger'], ['🦁', 'León', 'Lion'], ['🐮', 'Vaca', 'Cow'],
    ['🐷', 'Cerdo', 'Pig'], ['🐸', 'Rana', 'Frog'], ['🐵', 'Mono', 'Monkey'],
    ['🐔', 'Gallina', 'Chicken'], ['🐧', 'Pingüino', 'Penguin'], ['🐦', 'Pájaro', 'Bird'],
    ['🦋', 'Mariposa', 'Butterfly'], ['🐝', 'Abeja', 'Bee'], ['🐢', 'Tortuga', 'Turtle'],
    ['🐬', 'Delfín', 'Dolphin'], ['🐳', 'Ballena', 'Whale'], ['🐙', 'Pulpo', 'Octopus'],
    ['🌻', 'Girasol', 'Sunflower'], ['🌹', 'Rosa', 'Rose'], ['🌸', 'Flor de cerezo', 'Cherry blossom'],
    ['🌵', 'Cactus', 'Cactus'], ['🌴', 'Palmera', 'Palm tree'], ['🌿', 'Hierba', 'Herb'],
    ['🍀', 'Trébol de suerte', 'Four leaf clover'], ['🌈', 'Arcoíris', 'Rainbow'],
    ['⭐', 'Estrella', 'Star'], ['🌙', 'Luna', 'Moon'], ['☀️', 'Sol', 'Sun'],
    ['🌧️', 'Lluvia', 'Rain'], ['❄️', 'Nieve', 'Snowflake'], ['🔥', 'Fuego', 'Fire'],
  ],
  food: [
    ['🍎', 'Manzana', 'Apple'], ['🍊', 'Naranja', 'Orange'], ['🍋', 'Limón', 'Lemon'],
    ['🍌', 'Banana', 'Banana'], ['🍉', 'Sandía', 'Watermelon'], ['🍇', 'Uvas', 'Grapes'],
    ['🍓', 'Fresa', 'Strawberry'], ['🍒', 'Cereza', 'Cherries'], ['🍍', 'Piña', 'Pineapple'],
    ['🥑', 'Aguacate', 'Avocado'], ['🥕', 'Zanahoria', 'Carrot'], ['🌽', 'Maíz', 'Corn'],
    ['🍞', 'Pan', 'Bread'], ['🥐', 'Croissant', 'Croissant'], ['🧀', 'Queso', 'Cheese'],
    ['🍳', 'Huevo', 'Egg'], ['🍔', 'Hamburguesa', 'Burger'], ['🍟', 'Papas fritas', 'French fries'],
    ['🍕', 'Pizza', 'Pizza'], ['🌮', 'Taco', 'Taco'], ['🌯', 'Burrito', 'Burrito'],
    ['🍝', 'Pasta', 'Spaghetti'], ['🍜', 'Fideos', 'Noodles'], ['🍣', 'Sushi', 'Sushi'],
    ['🍿', 'Palomitas', 'Popcorn'], ['🍩', 'Dona', 'Donut'], ['🍪', 'Galleta', 'Cookie'],
    ['🎂', 'Pastel de cumpleaños', 'Birthday cake'], ['🍰', 'Torta', 'Cake'], ['🍫', 'Chocolate', 'Chocolate'],
    ['🍦', 'Helado', 'Ice cream'], ['☕', 'Café', 'Coffee'], ['🍵', 'Té', 'Tea'],
    ['🧃', 'Jugo', 'Juice'], ['🥤', 'Bebida', 'Drink'], ['🧋', 'Té de burbujas', 'Bubble tea'],
    ['🍷', 'Vino', 'Wine'], ['🥂', 'Brindis', 'Cheers'],
  ],
  travel: [
    ['🚗', 'Auto', 'Car'], ['🚕', 'Taxi', 'Taxi'], ['🚌', 'Bus', 'Bus'],
    ['🚎', 'Trolebús', 'Trolleybus'], ['🚑', 'Ambulancia', 'Ambulance'], ['🚲', 'Bicicleta', 'Bicycle'],
    ['🛵', 'Moto', 'Scooter'], ['🚆', 'Tren', 'Train'], ['🚇', 'Metro', 'Subway'],
    ['✈️', 'Avión', 'Airplane'], ['🚀', 'Cohete', 'Rocket'], ['🛸', 'Platillo volador', 'Flying saucer'],
    ['🚢', 'Barco', 'Ship'], ['⛵', 'Velero', 'Sailboat'], ['🏠', 'Casa', 'House'],
    ['🏡', 'Casa con jardín', 'House with garden'], ['🏢', 'Oficina', 'Office building'], ['🏥', 'Hospital', 'Hospital'],
    ['🏖️', 'Playa', 'Beach'], ['🏝️', 'Isla', 'Island'], ['🏔️', 'Montaña', 'Mountain'],
    ['🏕️', 'Camping', 'Camping'], ['🗽', 'Estatua de la libertad', 'Statue of Liberty'], ['🗼', 'Torre', 'Tower'],
    ['🧳', 'Maleta', 'Suitcase'], ['🧭', 'Brújula', 'Compass'], ['🌍', 'Mundo', 'Earth'],
    ['🌅', 'Amanecer', 'Sunrise'], ['🌆', 'Ciudad al atardecer', 'City at dusk'], ['🎡', 'Rueda de la fortuna', 'Ferris wheel'],
  ],
  objects: [
    ['📱', 'Teléfono', 'Phone'], ['💻', 'Computadora', 'Laptop'], ['⌨️', 'Teclado', 'Keyboard'],
    ['📷', 'Cámara', 'Camera'], ['🎥', 'Cámara de cine', 'Movie camera'], ['🎧', 'Audífonos', 'Headphones'],
    ['🎤', 'Micrófono', 'Microphone'], ['🎵', 'Música', 'Music'], ['🎸', 'Guitarra', 'Guitar'],
    ['🥁', 'Tambor', 'Drum'], ['📚', 'Libros', 'Books'], ['✏️', 'Lápiz', 'Pencil'],
    ['📝', 'Nota', 'Memo'], ['📅', 'Calendario', 'Calendar'], ['⏰', 'Alarma', 'Alarm clock'],
    ['💡', 'Idea', 'Light bulb'], ['🔦', 'Linterna', 'Flashlight'], ['🔋', 'Batería', 'Battery'],
    ['🔑', 'Llave', 'Key'], ['🔒', 'Candado', 'Lock'], ['🛡️', 'Escudo', 'Shield'],
    ['🎁', 'Regalo', 'Gift'], ['🎈', 'Globo', 'Balloon'], ['🎉', 'Confeti', 'Party popper'],
    ['🎊', 'Celebrar', 'Confetti ball'], ['🏆', 'Trofeo', 'Trophy'], ['🥇', 'Medalla de oro', 'Gold medal'],
    ['⚽', 'Fútbol', 'Football soccer'], ['🏀', 'Baloncesto', 'Basketball'], ['🎮', 'Videojuegos', 'Video games'],
    ['🎲', 'Dado', 'Dice'], ['🧩', 'Rompecabezas', 'Puzzle'], ['✅', 'Listo', 'Check mark'],
    ['❌', 'Cancelar', 'Cross mark'], ['❓', 'Pregunta', 'Question mark'], ['💯', 'Cien puntos', 'Hundred points'],
    ['✨', 'Brillos', 'Sparkles'], ['⚡', 'Rayo', 'Lightning'], ['💬', 'Mensaje', 'Speech bubble'],
  ],
};

export const CHAT_EMOJIS: readonly ChatEmoji[] = EMOJI_CATEGORIES.flatMap(({ id }) => groups[id].map(([value, es, en, keywords = '']) => ({ value, es, en, keywords, category: id })));

export interface ChatSticker { id: string; es: string; en: string; keywords: string; svg: string; preview: string; }

function sticker(id: string, es: string, en: string, color: string, detail: string, keywords = ''): ChatSticker {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 384" width="384" height="384"><defs><linearGradient id="paint" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#ddfff2"/></linearGradient></defs><path d="M72 112C64 70 106 36 154 52C206 24 278 54 294 104C348 136 338 230 304 266C310 320 256 344 212 320C162 354 104 326 96 284C40 262 34 160 72 112Z" fill="#fff" stroke="#fff" stroke-width="19" stroke-linejoin="round"/><path d="M72 112C64 70 106 36 154 52C206 24 278 54 294 104C348 136 338 230 304 266C310 320 256 344 212 320C162 354 104 326 96 284C40 262 34 160 72 112Z" fill="url(#paint)" stroke="#153e3a" stroke-width="6" stroke-linejoin="round"/>${detail}</svg>`;
  return { id, es, en, keywords, svg, preview: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

const eye = (x: number, y = 159) => `<ellipse cx="${x}" cy="${y}" rx="12" ry="18" fill="#153e3a"/><circle cx="${x - 3}" cy="${y - 6}" r="4" fill="#fff"/>`;
const smile = '<path d="M139 214Q192 266 246 214" fill="none" stroke="#153e3a" stroke-width="11" stroke-linecap="round"/>';
const blush = '<ellipse cx="116" cy="207" rx="19" ry="11" fill="#ff8eae" opacity=".7"/><ellipse cx="270" cy="207" rx="19" ry="11" fill="#ff8eae" opacity=".7"/>';
const heart = (x: number, y: number, scale = 1) => `<path d="M0 12C-26-15-48 13-24 34L0 54L24 34C48 13 26-15 0 12Z" transform="translate(${x} ${y}) scale(${scale})" fill="#f6688d" stroke="#fff" stroke-width="3"/>`;

/** Original vector stickers, converted locally to transparent PNGs before E2EE sending. */
export const CHAT_STICKERS: readonly ChatSticker[] = [
  sticker('joy', 'Qué alegría', 'So happy', '#7de3c0', `${eye(149)}${eye(236)}${smile}${blush}<path d="M40 64L30 37M330 88L355 61M178 30L182 8" stroke="#edc75f" stroke-width="10" stroke-linecap="round"/>`, 'feliz happy sonrisa smile'),
  sticker('love', 'Te quiero', 'Love you', '#ffa9c5', `${heart(144, 145, .68)}${heart(241, 145, .68)}${smile}${blush}${heart(320, 46, .55)}${heart(54, 279, .55)}`, 'corazon heart amor'),
  sticker('laugh', 'Me muero de risa', 'Cannot stop laughing', '#ffd976', '<path d="M127 153Q149 123 171 153M217 153Q239 123 261 153" fill="none" stroke="#153e3a" stroke-width="11" stroke-linecap="round"/><path d="M134 204Q192 314 252 204Z" fill="#153e3a"/><path d="M159 255Q192 224 227 255Q192 290 159 255Z" fill="#f6688d"/><path d="M93 183Q116 211 96 226Q71 219 93 183ZM287 181Q309 215 289 226Q267 220 287 181Z" fill="#5ecce7"/>', 'jajaja lol funny gracioso'),
  sticker('cool', 'Todo bajo control', 'Keeping it cool', '#b6a3fa', '<path d="M111 142H176V175Q146 199 118 175ZM208 142H274L267 175Q238 199 208 175Z" fill="#153e3a"/><path d="M175 152H210M103 142H282" stroke="#153e3a" stroke-width="9" stroke-linecap="round"/><path d="M146 151L164 151M218 151L236 151" stroke="#d6fff3" stroke-width="7" stroke-linecap="round"/>'+smile, 'genial glasses gafas'),
  sticker('sleep', 'Buenas noches', 'Good night', '#91bfed', '<path d="M128 166Q149 188 171 166M216 166Q238 188 260 166" fill="none" stroke="#153e3a" stroke-width="10" stroke-linecap="round"/><ellipse cx="192" cy="228" rx="14" ry="19" fill="#153e3a"/><path d="M260 61H293L260 97H293M306 18H332L306 44H332" fill="none" stroke="#638cc5" stroke-width="8" stroke-linecap="round"/>'+blush, 'dormir sueño night sleepy'),
  sticker('think', 'Déjame pensar', 'Let me think', '#ead49b', `${eye(149)}${eye(236)}<path d="M133 121L167 129M219 131L253 116M165 227Q191 214 217 222" fill="none" stroke="#153e3a" stroke-width="9" stroke-linecap="round"/><path d="M207 278C184 281 170 267 175 252C180 244 190 249 196 248L205 214C209 200 226 204 224 218L222 242C246 238 257 246 252 262L241 282" fill="#edd5ae" stroke="#153e3a" stroke-width="6"/>`, 'pensando pregunta question thinking'),
  sticker('coffee', 'Un cafecito', 'Coffee time', '#dda97e', `${eye(149)}${eye(236)}${blush}<path d="M122 213H247V260Q246 290 185 290Q124 290 122 260Z" fill="#fff" stroke="#153e3a" stroke-width="6"/><path d="M247 222C295 214 294 267 248 266" fill="none" stroke="#153e3a" stroke-width="7"/><path d="M163 196Q151 182 164 173M191 195Q179 179 193 164" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>`, 'cafe break descanso'),
  sticker('celebrate', 'A celebrar', 'Celebrate', '#9ae1ef', '<path d="M128 157Q149 132 171 157M216 157Q238 132 260 157" fill="none" stroke="#153e3a" stroke-width="10" stroke-linecap="round"/>'+smile+'<path d="M148 64L204 12L237 76Z" fill="#b997e8" stroke="#fff" stroke-width="5"/><path d="M169 44L221 48" stroke="#f7d974" stroke-width="8"/><circle cx="27" cy="144" r="10" fill="#f7d974"/><circle cx="345" cy="272" r="11" fill="#b997e8"/><path d="M305 51L321 67M35 280L54 266" stroke="#f6688d" stroke-width="9" stroke-linecap="round"/>', 'fiesta party cumpleaños birthday'),
  sticker('done', 'Listo', 'All done', '#85dca6', `${eye(149)}${eye(236)}${smile}<circle cx="285" cy="279" r="49" fill="#1e8671" stroke="#fff" stroke-width="8"/><path d="M262 279L279 294L309 260" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`, 'ok yes bien si perfect'),
  sticker('hug', 'Un abrazo', 'A big hug', '#f4b5a0', `${eye(149)}${eye(236)}${smile}${blush}<path d="M57 237Q96 208 157 249M327 237Q285 208 227 249" fill="none" stroke="#153e3a" stroke-width="29" stroke-linecap="round"/><path d="M57 237Q96 208 157 249M327 237Q285 208 227 249" fill="none" stroke="#f4b5a0" stroke-width="19" stroke-linecap="round"/>${heart(192, 223, .85)}`, 'abrazo hug cariño warmth'),
  sticker('wow', 'Increíble', 'Wow', '#b5bdf0', `${eye(149)}${eye(236)}<ellipse cx="192" cy="228" rx="27" ry="35" fill="#153e3a"/><path d="M29 74L54 80L36 98M328 29L332 56L353 44M303 324L315 348L328 330" fill="none" stroke="#eccd55" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`, 'sorpresa amazing surprise'),
  sticker('hello', 'Hola de nuevo', 'Hello again', '#a5e9d3', `${eye(149)}<path d="M218 168Q237 142 256 168" fill="none" stroke="#153e3a" stroke-width="10" stroke-linecap="round"/>${smile}${blush}<path d="M300 206L325 169C339 153 350 166 340 182L334 195L347 190C367 182 372 197 357 208L332 226C316 237 297 230 300 206Z" fill="#a5e9d3" stroke="#153e3a" stroke-width="6"/><path d="M342 130L353 115M368 151L379 145" stroke="#edc75f" stroke-width="8" stroke-linecap="round"/>`, 'saludo hello hi bye adios'),
];

export function normalizeExpressionSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
}

export function matchesExpression(item: { es: string; en: string; keywords: string }, query: string): boolean {
  const words = normalizeExpressionSearch(query).split(/\s+/).filter(Boolean);
  const searchable = normalizeExpressionSearch(`${item.es} ${item.en} ${item.keywords}`);
  return words.every((word) => searchable.includes(word));
}
