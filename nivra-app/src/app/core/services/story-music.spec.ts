import { encodeStoryMusicFragment, STORY_MUSIC_SAMPLE_RATE, validateStoryMusicDraft, validMusicWindow } from './story-music';

describe('real story music fragments', () => {
  const buffer = (seconds = 30) => {
    const samples = new Float32Array(seconds * 44100);
    // The selected second differs from the intro: prove we cut actual samples.
    samples.fill(-.5, 0, 44100); samples.fill(.5, 44100);
    return { duration: seconds, sampleRate: 44100, numberOfChannels: 2, length: samples.length,
      getChannelData: () => samples } as unknown as AudioBuffer;
  };
  it('encodes only the selected samples as bounded mono PCM, with a correct WAV header', async () => {
    const file = encodeStoryMusicFragment(buffer(), 1, 15);
    expect(file.size).toBe(44 + 15 * STORY_MUSIC_SAMPLE_RATE * 2);
    expect(file.type).toBe('audio/wav');
    const data = new DataView(await file.arrayBuffer());
    expect(data.getUint16(22, true)).toBe(1);
    expect(data.getUint32(24, true)).toBe(STORY_MUSIC_SAMPLE_RATE);
    expect(data.getInt16(44 + 1000 * 2, true)).toBeGreaterThan(0);
    expect(data.getInt16(44, true)).toBe(0); // fade avoids hard-cut clicks
    await expectAsync(validateStoryMusicDraft({ file, title: 'Mi fragmento', durationSeconds: 15, sourceStartSeconds: 1 })).toBeResolved();
  });
  it('rejects empty, oversized and out-of-source windows without encoding the original song', () => {
    for (const [start, length] of [[0, 0], [0, 15.1], [-1, 1], [29, 2], [NaN, 2], [0, Infinity]]) {
      expect(() => encodeStoryMusicFragment(buffer(), start, length)).toThrow();
    }
    expect(validMusicWindow(601, 0, 1)).toBeFalse();
  });
  it('rejects forged WAV duration and arbitrary audio disguised as a trimmed file', async () => {
    const file = encodeStoryMusicFragment(buffer(), 0, 2);
    await expectAsync(validateStoryMusicDraft({ file, title: '', durationSeconds: 15, sourceStartSeconds: 0 })).toBeRejected();
    await expectAsync(validateStoryMusicDraft({ file: new File(['fake'], 'fake.wav', { type: 'audio/wav' }), title: '', durationSeconds: 1, sourceStartSeconds: 0 })).toBeRejected();
  });
});
