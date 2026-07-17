/**
 * กล่องของขวัญ (Legacy Box) — voice message constants, shared by the recorder
 * (apps/web) and the create endpoint (apps/api) so the two can't drift on what
 * "too long" or "too big" means.
 *
 * Only the byte cap is truly enforceable server-side: the API stores the clip
 * as an opaque blob and has no audio decoder, so MAX_VOICE_DURATION_SECONDS is
 * enforced by the recorder's auto-stop and is advisory on the server.
 * MAX_VOICE_BYTES is the real backstop — a 60s Opus clip is ~120 KB at typical
 * MediaRecorder bitrates, so 5 MB leaves room for Safari's fatter AAC without
 * being a meaningful storage hole.
 */

export const MAX_VOICE_DURATION_SECONDS = 60;
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

/**
 * Container preference order for MediaRecorder. Opus-in-WebM everywhere it
 * exists (Chrome/Firefox/Edge); audio/mp4 (AAC) is Safari 14.5+, which has no
 * WebM encoder; Ogg/Opus is the old-Firefox tail.
 */
export const VOICE_MIME_PRIORITY = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** Container types the API will store, keyed to the file extension it uses. */
const VOICE_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
};

/**
 * Drop the codecs parameter: MediaRecorder reports back the full
 * 'audio/webm;codecs=opus' it was given, but the container (and therefore the
 * extension and what we accept) is decided by the base type alone.
 */
export function baseAudioMime(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

export function isSupportedVoiceMime(mimeType: string): boolean {
  return baseAudioMime(mimeType) in VOICE_EXTENSIONS;
}

/** File extension for a supported container, or null if it isn't one. */
export function voiceExtensionFor(mimeType: string): string | null {
  return VOICE_EXTENSIONS[baseAudioMime(mimeType)] ?? null;
}

/** '0:23' — the recorder's timer and the player's readout share this. */
export function formatVoiceDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
