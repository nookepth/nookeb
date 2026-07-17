'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatVoiceDuration } from '@nookeb/shared';
import styles from './VoicePlayer.module.css';

/**
 * เสียงจากผู้ส่ง — the recipient's voice-message player on the reveal page.
 *
 * Deliberately does NOT autoplay: mobile browsers block it anyway, and a gift
 * box that starts talking the instant it opens spoils the beat the reveal is
 * built around. The recipient chooses when to listen.
 *
 * There is no sender name here, and there is no prop for one. GET
 * /legacy-box/open/:slug never returns the creator's identity — the slug is a
 * link anyone can forward, so the payload carries no PII by design. The label is
 * therefore always the generic "เสียงจากผู้ส่ง".
 */

type PlayerState = 'loading' | 'ready' | 'error';

export function VoicePlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<PlayerState>('loading');
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  /** bumped by the retry button to force the <audio> to re-request the URL */
  const [reloadKey, setReloadKey] = useState(0);
  const durationFixRef = useRef(false);

  // A new URL (or a retry) starts over from the loading state.
  useEffect(() => {
    setState('loading');
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    durationFixRef.current = false;
  }, [src, reloadKey]);

  /**
   * MediaRecorder's WebM output has no duration in its header, so a clip
   * recorded in Chrome/Firefox reports `Infinity` here. Seeking far past the end
   * forces the browser to scan for the real end, after which `durationchange`
   * fires with a finite value and we rewind. Safari's MP4 reports correctly and
   * skips this entirely. Without it the scrub bar has no range and the total
   * time renders as "0:00".
   */
  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.duration === Infinity || Number.isNaN(audio.duration)) {
      durationFixRef.current = true;
      audio.currentTime = 1e101;
      return;
    }
    setDuration(audio.duration);
    setState('ready');
  }, []);

  const onDurationChange = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !durationFixRef.current) return;
    if (Number.isFinite(audio.duration)) {
      durationFixRef.current = false;
      audio.currentTime = 0;
      setDuration(audio.duration);
      setState('ready');
    }
  }, []);

  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    // While the duration probe is seeking, currentTime is garbage (1e101) —
    // and while the user drags, the bar belongs to them, not to playback.
    if (!audio || scrubbing || durationFixRef.current) return;
    setCurrent(audio.currentTime);
  }, [scrubbing]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || state !== 'ready') return;
    if (audio.paused) {
      // play() rejects if the browser blocks it or the media is gone — surface
      // it as an error state rather than an unhandled rejection.
      void audio.play().catch(() => setState('error'));
    } else {
      audio.pause();
    }
  }, [state]);

  const seek = useCallback((value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrent(value);
  }, []);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const progress = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <section className={styles.card} data-safe-margin="16" aria-label="เสียงจากผู้ส่ง">
      <audio
        // Remounting on retry is what makes the browser re-fetch a URL it has
        // already failed on; audio.load() alone can serve the cached failure.
        key={reloadKey}
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={onDurationChange}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onError={() => setState('error')}
      />

      <div className={styles.head}>
        <span className={styles.micIcon} aria-hidden>
          <MicIcon />
        </span>
        <span className={styles.headText}>เสียงจากผู้ส่ง</span>
      </div>

      {state === 'error' ? (
        <div className={styles.errorRow}>
          <span className={styles.errorText}>ไม่สามารถโหลดเสียงได้</span>
          <button type="button" className={styles.retryBtn} onClick={retry}>
            ลองใหม่
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.playBtn}
            onClick={toggle}
            disabled={state !== 'ready'}
            aria-label={playing ? 'หยุดเสียงชั่วคราว' : 'เล่นเสียง'}
          >
            {state === 'loading' ? (
              <span className={styles.spinner} aria-hidden />
            ) : playing ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </button>

          <input
            className={styles.scrub}
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={current}
            disabled={state !== 'ready' || duration === 0}
            style={{ '--progress': `${progress}%` } as React.CSSProperties}
            onChange={(e) => seek(Number(e.target.value))}
            onPointerDown={() => setScrubbing(true)}
            onPointerUp={() => setScrubbing(false)}
            onKeyDown={() => setScrubbing(true)}
            onKeyUp={() => setScrubbing(false)}
            aria-label="เลื่อนตำแหน่งเสียง"
          />

          <span className={styles.time}>
            {formatVoiceDuration(current)} / {formatVoiceDuration(duration)}
          </span>
        </div>
      )}
    </section>
  );
}

/* ---- icons (SVG only — no emoji) ---- */

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.5-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </svg>
  );
}
