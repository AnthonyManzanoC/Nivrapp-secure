/** Only this selected fragment is uploaded; the original song stays on device. */
export const STORY_MUSIC_MAX_SECONDS = 15;
export const STORY_MUSIC_SOURCE_MAX_BYTES = 12 * 1024 * 1024;
export const STORY_MUSIC_SOURCE_MAX_SECONDS = 5 * 60;
export const STORY_MUSIC_SAMPLE_RATE = 22050;
export interface StoryMusicDraft {
  file: File;
  title: string;
  durationSeconds: number;
  sourceStartSeconds: number;
}

export function validMusicWindow(total: number, start: number, duration: number): boolean {
  return Number.isFinite(total) && total > 0 && total <= STORY_MUSIC_SOURCE_MAX_SECONDS
    && Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration > 0
    && duration <= STORY_MUSIC_MAX_SECONDS && start + duration <= total + .01;
}

/** PCM encoding bounds CPU/memory to 330750 mono samples, independent of song length. */
export function encodeStoryMusicFragment(buffer: AudioBuffer, start: number, duration: number): File {
  if (!validMusicWindow(buffer.duration, start, duration) || !buffer.numberOfChannels || buffer.numberOfChannels > 2) {
    throw new Error('Elige un fragmento de hasta 15 segundos.');
  }
  const frames = Math.floor(duration * STORY_MUSIC_SAMPLE_RATE);
  if (!frames) throw new Error('El fragmento de música está vacío.');
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, STORY_MUSIC_SAMPLE_RATE, true); view.setUint32(28, STORY_MUSIC_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, frames * 2, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const fadeFrames = Math.min(Math.floor(STORY_MUSIC_SAMPLE_RATE * .005), Math.floor(frames / 2));
  for (let index = 0; index < frames; index++) {
    const position = (start + index / STORY_MUSIC_SAMPLE_RATE) * buffer.sampleRate;
    const lower = Math.min(buffer.length - 1, Math.floor(position));
    const upper = Math.min(buffer.length - 1, lower + 1);
    const fraction = position - lower;
    let sample = channels.reduce((sum, channel) => sum + channel[lower] * (1 - fraction) + channel[upper] * fraction, 0) / channels.length;
    if (fadeFrames) sample *= Math.min(1, index / fadeFrames, (frames - 1 - index) / fadeFrames);
    sample = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new File([bytes], 'nivra-story-fragment.wav', { type: 'audio/wav' });
}

export async function validateStoryMusicDraft(music: StoryMusicDraft): Promise<void> {
  if (!music || !music.file || music.file.type !== 'audio/wav' || !music.file.size || music.file.size > 44 + STORY_MUSIC_MAX_SECONDS * STORY_MUSIC_SAMPLE_RATE * 2
    || typeof music.title !== 'string' || music.title.length > 80 || !Number.isFinite(music.sourceStartSeconds) || music.sourceStartSeconds < 0
    || !Number.isFinite(music.durationSeconds) || music.durationSeconds <= 0 || music.durationSeconds > STORY_MUSIC_MAX_SECONDS) {
    throw new Error('El fragmento de música no es válido.');
  }
  const bytes = await music.file.arrayBuffer();
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => [...value].every((char, index) => view.getUint8(offset + index) === char.charCodeAt(0));
  if (bytes.byteLength < 46 || !tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== STORY_MUSIC_SAMPLE_RATE || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.byteLength - 44 || (bytes.byteLength - 44) % 2 !== 0
    || Math.abs((bytes.byteLength - 44) / (STORY_MUSIC_SAMPLE_RATE * 2) - music.durationSeconds) > .01) {
    throw new Error('El fragmento de música no es válido.');
  }
}
