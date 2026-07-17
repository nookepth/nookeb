'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_SECONDS,
  VOICE_MIME_PRIORITY,
  formatVoiceDuration,
} from '@nookeb/shared';
import styles from './VoiceRecorder.module.css';

/**
 * เพิ่มเสียงพูด — in-browser voice recorder for the create flow's message step.
 *
 * Nothing is uploaded here. The finished Blob is handed to the parent and rides
 * the normal createLegacyBox multipart at submit (step 4), so an abandoned draft
 * leaves no orphaned R2 object behind and the API can charge the clip's real
 * bytes against the creator's quota.
 *
 * States: idle → countdown (3·2·1, so the sender isn't caught mid-breath) →
 * recording (auto-stops at MAX_VOICE_DURATION_SECONDS) → preview → saved.
 *
 * Duration is measured from our own tick counter rather than read off the
 * <audio> element: MediaRecorder's WebM output carries no duration in its
 * header, so `audio.duration` is Infinity there until the clip is seeked to the
 * end. The tick count is accurate enough for a 60s cap and always correct.
 */

type RecorderState = 'idle' | 'countdown' | 'recording' | 'preview' | 'saved';

const COUNTDOWN_FROM = 3;
const WAVEFORM_BARS = 5;

/** The first container this browser can actually encode (see VOICE_MIME_PRIORITY). */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  // isTypeSupported is missing on some older implementations that still expose
  // the constructor — treat that as "can't verify" and let the browser default.
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return VOICE_MIME_PRIORITY.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm';
}

export interface VoiceRecorderProps {
  /** the committed clip, owned by the parent (null = none saved) */
  value: Blob | null;
  onChange: (voice: Blob | null) => void;
}

export function VoiceRecorder({ value, onChange }: VoiceRecorderProps) {
  /**
   * Feature detection runs in an effect, not during render: the server has no
   * MediaRecorder, so testing for it inline would make the first client render
   * disagree with the server's and hydration would tear. `null` = "not checked
   * yet", which renders nothing — the same as the server.
   */
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<RecorderState>('idle');
  const [countdown, setCountdown] = useState(COUNTDOWN_FROM);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timersRef = useRef<number[]>([]);
  /**
   * The recorded clip itself. Held here rather than re-read from `previewUrl`
   * at commit time: fetching a blob: URL is subject to the page's CSP
   * connect-src (it fails outright under ours), and the object URL is only ever
   * a handle to this same Blob anyway.
   */
  const recordedBlobRef = useRef<Blob | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = previewUrl;
  /**
   * The counters live in refs and the state setters only ever receive a plain
   * value. Deriving them inside a setState *updater* instead would put a side
   * effect in what React requires to be a pure function — and React double-
   * invokes updaters under StrictMode, which ran the whole start-recording path
   * twice and made the timer tick at 2x (so the 60s cap fired at 30 real
   * seconds). Keep these assignments out of the updaters.
   */
  const elapsedRef = useRef(0);
  const countdownRef = useRef(COUNTDOWN_FROM);

  useEffect(() => {
    setSupported(
      typeof MediaRecorder !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia,
    );
  }, []);

  /** Release the mic — without this the browser keeps showing "recording". */
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => window.clearInterval(t));
    timersRef.current = [];
  }, []);

  // Teardown on unmount: mic off, timers dead, object URL revoked. Reading the
  // URL through a ref keeps this a mount-once effect while still revoking the
  // latest one (re-recording replaces it).
  useEffect(
    () => () => {
      clearTimers();
      stopStream();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [clearTimers, stopStream],
  );

  const beginRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    // Idempotent: a second entry here would open a second MediaRecorder on the
    // same stream and double the tick rate.
    if (recorderRef.current?.state === 'recording') return;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      // A browser can pass isTypeSupported and still refuse the constructor
      // (codec present, encoder unavailable). Fall back to its own default.
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        stopStream();
        setState('idle');
        setError('เบราว์เซอร์นี้อัดเสียงไม่ได้น้า');
        return;
      }
    }

    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      clearTimers();
      stopStream();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      chunksRef.current = [];
      if (blob.size === 0) {
        setState('idle');
        setError('ไม่ได้ยินเสียงเลย ลองอัดใหม่อีกทีน้า');
        return;
      }
      recordedBlobRef.current = blob;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      setPreviewUrl(URL.createObjectURL(blob));
      setState('preview');
    };
    // A recorder that dies mid-take must not strand the UI in 'recording'.
    recorder.onerror = () => {
      clearTimers();
      stopStream();
      setState('idle');
      setError('อัดเสียงไม่สำเร็จ ลองใหม่อีกทีน้า');
    };

    recorderRef.current = recorder;
    recorder.start();
    elapsedRef.current = 0;
    setElapsed(0);
    setState('recording');

    const tick = window.setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
      setDuration(elapsedRef.current);
      if (elapsedRef.current >= MAX_VOICE_DURATION_SECONDS) {
        // Hard cap: stop ourselves rather than let the clip outgrow the limit
        // the API enforces. onstop does the teardown.
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      }
    }, 1000);
    timersRef.current.push(tick);
  }, [clearTimers, stopStream]);

  const startCountdown = useCallback(async () => {
    setError(null);
    // Permission is requested on the tap, per spec — never on mount.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // NotAllowedError = user (or policy) said no; NotFoundError = no mic at
      // all. Anything else is still a failure to record, not a crash.
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('ไม่พบไมโครโฟนในเครื่องน้า');
      } else {
        setError('กรุณาอนุญาตการใช้ไมโครโฟนในการตั้งค่า browser');
      }
      setState('idle');
      return;
    }
    streamRef.current = stream;

    countdownRef.current = COUNTDOWN_FROM;
    setCountdown(COUNTDOWN_FROM);
    setState('countdown');
    const iv = window.setInterval(() => {
      countdownRef.current -= 1;
      if (countdownRef.current <= 0) {
        window.clearInterval(iv);
        setCountdown(0);
        beginRecording();
        return;
      }
      setCountdown(countdownRef.current);
    }, 1000);
    timersRef.current.push(iv);
  }, [beginRecording]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const discard = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    setPreviewUrl(null);
    recordedBlobRef.current = null;
    setDuration(0);
    setElapsed(0);
    elapsedRef.current = 0;
    onChange(null);
    setState('idle');
  }, [onChange]);

  const commit = useCallback(() => {
    const blob = recordedBlobRef.current;
    if (!blob) {
      setError('บันทึกเสียงไม่สำเร็จ ลองอัดใหม่อีกทีน้า');
      return;
    }
    // The server enforces this too (and is the real check) — catching it here
    // just means a 60s clip from an unusually high-bitrate encoder fails now,
    // rather than after the creator uploads every photo at step 4.
    if (blob.size > MAX_VOICE_BYTES) {
      setError(`ไฟล์เสียงใหญ่เกิน ${Math.floor(MAX_VOICE_BYTES / (1024 * 1024))} MB ลองอัดสั้นลงน้า`);
      return;
    }
    onChange(blob);
    setState('saved');
  }, [onChange]);

  // Not checked yet, or a browser with no MediaRecorder: render nothing rather
  // than a control that can't work (per spec).
  if (supported !== true) return null;

  return (
    <div className={styles.section}>
      <span className={styles.label}>เพิ่มเสียงพูด (ไม่บังคับ)</span>

      {state === 'idle' && (
        <div className={styles.idleRow}>
          <button type="button" className={styles.recordBtn} onClick={() => void startCountdown()}>
            <span className={styles.micIcon} aria-hidden>
              <MicIcon />
            </span>
            เริ่มอัด
          </button>
          <p className={styles.hint}>อัดได้สูงสุด {MAX_VOICE_DURATION_SECONDS} วินาที</p>
        </div>
      )}

      {state === 'countdown' && (
        <div className={styles.countdownBox} role="status" aria-live="assertive">
          <span className={styles.countdownNum} key={countdown}>
            {countdown}
          </span>
          <p className={styles.hint}>เตรียมตัวให้พร้อม…</p>
        </div>
      )}

      {state === 'recording' && (
        <div className={styles.recordingBox}>
          <div className={styles.recordingHead}>
            <span className={styles.redDot} aria-hidden />
            <span className={styles.timer} role="timer" aria-live="off">
              {formatVoiceDuration(elapsed)}
            </span>
            <span className={styles.limitHint}>
              / {formatVoiceDuration(MAX_VOICE_DURATION_SECONDS)}
            </span>
          </div>
          <div className={styles.waveform} aria-hidden>
            {Array.from({ length: WAVEFORM_BARS }, (_, i) => (
              <span key={i} className={styles.waveBar} style={{ '--bar': i } as React.CSSProperties} />
            ))}
          </div>
          <button type="button" className={styles.stopBtn} onClick={stopRecording}>
            <span className={styles.stopIcon} aria-hidden>
              <StopIcon />
            </span>
            หยุด
          </button>
        </div>
      )}

      {state === 'preview' && previewUrl && (
        <div className={styles.previewBox}>
          <div className={styles.previewHead}>
            <span className={styles.previewDuration}>{formatVoiceDuration(duration)}</span>
            <span className={styles.hint}>ฟังก่อนได้น้า</span>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a personal voice message has no transcript */}
          <audio className={styles.audio} src={previewUrl} controls preload="metadata" />
          <div className={styles.previewActions}>
            <button type="button" className={styles.useBtn} onClick={commit}>
              ใช้เสียงนี้
            </button>
            <button type="button" className={styles.redoBtn} onClick={discard}>
              อัดใหม่
            </button>
          </div>
        </div>
      )}

      {state === 'saved' && (
        <div className={styles.savedBox}>
          <span className={styles.savedIcon} aria-hidden>
            <CheckIcon />
          </span>
          <span className={styles.savedText}>
            บันทึกแล้ว
            {duration > 0 && <span className={styles.savedDuration}>{formatVoiceDuration(duration)}</span>}
          </span>
          <button type="button" className={styles.redoBtn} onClick={discard}>
            ลบ / อัดใหม่
          </button>
        </div>
      )}

      {/* Kept out of the state blocks so a permission refusal is still on screen
          after we drop back to idle. */}
      {error && <p className={styles.error}>{error}</p>}
      {/* Defensive: the parent is the source of truth for what will be sent, so
          surface a desync rather than silently submitting nothing. */}
      {state === 'saved' && !value && (
        <p className={styles.error}>เสียงหลุดไป ลองอัดใหม่อีกทีน้า</p>
      )}
    </div>
  );
}

/* ---- icons (SVG only — no emoji anywhere in this flow) ---- */

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
