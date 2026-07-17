'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import type { LegacyBoxOccasionId, LegacyBoxThemeId } from '@nookeb/shared';
import {
  ALL_TAGLINES,
  MAX_TAGLINE_LENGTH,
  OCCASIONS,
  OCCASION_IDS,
  THEMES,
  THEME_IDS,
  defaultTaglineFor,
  isOccasionId,
} from '@nookeb/shared';
import { ApiError, createLegacyBox, hasSession, postProInterest } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { AudioIcon, CheckBadgeIcon, LockIcon, OCCASION_ICONS, VideoIcon } from './OccasionIcons';
import { ShareActions } from './ShareActions';
import { VoiceRecorder } from './VoiceRecorder';
import styles from './page.module.css';

/**
 * สร้างกล่องของขวัญ — 4-step create flow:
 * 1) โอกาส → 2) รูป (1–10, drag/arrow reorder) → 3) ข้อความ + ประโยคส่งท้าย →
 * 4) ธีมสี + preview → submit.
 *
 * The occasion (step 1) is authoring metadata that seeds the rest: it
 * pre-selects the theme and the tagline, both of which the creator can still
 * override in their own step. Seeding happens ONLY in pickOccasion / the
 * localStorage restore — never in a render-time effect, which would stomp a
 * manual theme choice every time the creator stepped backwards.
 *
 * The page background bleeds to the chosen theme (400ms transition) so the
 * creator sees the recipient's mood while building. Upload goes through
 * createLegacyBox (XHR progress — same pattern as the vault).
 */

const MAX_PHOTOS = 10;
const MAX_SOURCE_MB = 20;
const MAX_TITLE = 60;
const MAX_MESSAGE = 500;

/** Only the occasion survives a refresh (per spec) — the rest of the draft is in-memory. */
const OCCASION_STORAGE_KEY = 'nookeb.legacy-box.occasion';

interface PickedPhoto {
  /** stable key for reorder animations */
  key: string;
  file: File;
  previewUrl: string;
}

type Step = 1 | 2 | 3 | 4;

type ProFeature = 'audio' | 'video';

const PRO_FEATURES: { id: ProFeature; label: string; Icon: () => JSX.Element }[] = [
  { id: 'audio', label: 'เพิ่มเสียง / เพลง', Icon: AudioIcon },
  { id: 'video', label: 'แนบวิดีโอสั้น', Icon: VideoIcon },
];

let nextKey = 0;

export default function NewLegacyBoxPage() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [occasion, setOccasion] = useState<LegacyBoxOccasionId | null>(null);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  /** the chosen chip; '' means "none selected" (the creator is typing a custom one) */
  const [tagline, setTagline] = useState('');
  const [customTagline, setCustomTagline] = useState('');
  const [showAllTaglines, setShowAllTaglines] = useState(false);
  /**
   * The committed voice clip, held in memory until submit — nothing is uploaded
   * while recording or previewing, so abandoning the draft leaves no orphan in R2.
   */
  const [voice, setVoice] = useState<Blob | null>(null);
  const [proModal, setProModal] = useState<ProFeature | null>(null);
  const [proNotified, setProNotified] = useState<ProFeature[]>([]);
  const [themeId, setThemeId] = useState<LegacyBoxThemeId>('rose');
  const [dragOverZone, setDragOverZone] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ shareUrl: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);
  const photosRef = useRef<PickedPhoto[]>([]);
  photosRef.current = photos;

  useEffect(() => {
    if (!hasSession()) setNeedsLogin(true);
  }, []);

  // Restore the occasion (and re-seed what it implies) after a refresh. Reading
  // localStorage in an effect rather than a useState initializer keeps the first
  // client render identical to the server's — otherwise this hydration-mismatches.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(OCCASION_STORAGE_KEY);
    } catch {
      // private-mode / blocked storage — the flow works fine without persistence
    }
    if (!saved || !isOccasionId(saved)) return;
    setOccasion(saved);
    setThemeId(OCCASIONS[saved].theme);
    setTagline(defaultTaglineFor(saved));
  }, []);

  // Revoke every preview object URL on unmount (not on each photos change —
  // reorders keep the same URLs alive).
  useEffect(
    () => () => {
      photosRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const theme = THEMES[themeId];

  /**
   * Picking an occasion seeds the theme + tagline. Both are only *defaults*: the
   * creator can still change either in its own step, and re-picking the same
   * occasion deliberately resets them (it reads as "start this mood over").
   */
  const pickOccasion = useCallback((id: LegacyBoxOccasionId) => {
    setOccasion(id);
    setThemeId(OCCASIONS[id].theme);
    setTagline(defaultTaglineFor(id));
    setCustomTagline('');
    setShowAllTaglines(false);
    try {
      window.localStorage.setItem(OCCASION_STORAGE_KEY, id);
    } catch {
      // non-fatal: persistence is a convenience, not part of the draft
    }
  }, []);

  /** Chips and the custom input are one control: choosing either clears the other. */
  const pickTaglineChip = useCallback((value: string) => {
    setTagline(value);
    setCustomTagline('');
  }, []);

  const onCustomTaglineChange = useCallback((value: string) => {
    setCustomTagline(value);
    if (value.trim()) setTagline('');
  }, []);

  /**
   * What actually gets sent. A custom line wins; otherwise the selected chip.
   * Never empty — if the creator clears a half-typed custom line without picking
   * a chip, this falls back to the occasion's default rather than sending null
   * and silently landing on a generic tagline they never saw.
   */
  const effectiveTagline = customTagline.trim() || tagline || defaultTaglineFor(occasion);

  const visibleTaglines = useMemo(() => {
    if (showAllTaglines) return ALL_TAGLINES;
    return occasion ? OCCASIONS[occasion].taglines : OCCASIONS.special.taglines;
  }, [occasion, showAllTaglines]);

  const notifyPro = useCallback(async (feature: ProFeature) => {
    // Demand-test tap: the count is the whole point, so a failed POST still
    // closes the modal happily rather than surfacing an error for a button whose
    // only promise is "we'll tell you later".
    try {
      await postProInterest(feature);
    } catch {
      // swallowed on purpose — see above
    }
    setProNotified((prev) => (prev.includes(feature) ? prev : [...prev, feature]));
    setProModal(null);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setError(null);
      const incoming = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (incoming.length === 0) return;
      setPhotos((prev) => {
        const room = MAX_PHOTOS - prev.length;
        const accepted: PickedPhoto[] = [];
        for (const file of incoming.slice(0, Math.max(0, room))) {
          if (file.size > MAX_SOURCE_MB * 1024 * 1024) {
            setError(`รูป "${file.name}" ใหญ่เกิน ${MAX_SOURCE_MB} MB น้า`);
            continue;
          }
          accepted.push({
            key: `p${nextKey++}`,
            file,
            previewUrl: URL.createObjectURL(file),
          });
        }
        if (incoming.length > room) setError(`ใส่ได้สูงสุด ${MAX_PHOTOS} รูปน้า`);
        return [...prev, ...accepted];
      });
    },
    [],
  );

  const removePhoto = useCallback((key: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }, []);

  const movePhoto = useCallback((from: number, to: number) => {
    setPhotos((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }, []);

  async function submit(): Promise<void> {
    if (photos.length === 0 || submitting) return;
    setSubmitting(true);
    setProgress(0);
    setError(null);
    try {
      const res = await createLegacyBox(
        {
          title: title.trim() || 'กล่องของขวัญ',
          message,
          theme: themeId,
          occasion,
          tagline: effectiveTagline,
          photos: photos.map((p) => p.file),
          voice,
        },
        setProgress,
      );
      setCreated({ shareUrl: res.shareUrl });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
        setError('พื้นที่ไม่เพียงพอ — ลบไฟล์เก่าหรือชวนเพื่อนเพิ่มพื้นที่ก่อนน้า');
      } else if (err instanceof ApiError && err.code === 'BOX_LIMIT_REACHED') {
        setError('คุณมีกล่องของขวัญครบ 10 กล่องแล้ว ลบกล่องเก่าก่อนน้า');
      } else if (err instanceof ApiError && err.message && err.message !== `API error ${err.status}`) {
        setError(err.message);
      } else {
        setError('สร้างกล่องไม่สำเร็จ ลองใหม่อีกทีน้า');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // seeded-ish gentle tilts for the preview polaroids (visual only)
  const tilts = useMemo(() => photos.map((_, i) => ((i * 137) % 7) - 3), [photos]);

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อสร้างกล่องของขวัญ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  const themeVars = {
    '--bx-page-bg': theme.gradient,
    '--bx-gradient': theme.gradient,
    '--bx-accent': theme.accent,
    '--bx-text': theme.text,
    '--bx-glow': theme.glow,
    '--bx-ribbon': theme.ribbon,
    '--bx-box': theme.boxColor,
    '--bx-box-accent': theme.boxAccent,
  } as React.CSSProperties;

  // ---------- success state ----------
  if (created) {
    return (
      <main className={styles.page} style={themeVars}>
        <div className={styles.container}>
          <div className={`${styles.card} ${styles.success}`}>
            <span className={styles.successEmoji} aria-hidden>
              🎁
            </span>
            <h1 className={styles.successTitle}>กล่องของขวัญพร้อมแล้ว!</h1>
            <p className={styles.successText}>
              ส่งลิงก์นี้ให้คนพิเศษของคุณ แล้วรอเขาแตะเปิดกล่องได้เลย
            </p>
            <ShareActions shareUrl={created.shareUrl} />
          </div>
        </div>
        {toast && <div className={styles.toast}>{toast}</div>}
      </main>
    );
  }

  const stepLabels: Record<Step, string> = {
    1: 'เลือกโอกาส',
    2: 'อัพโหลดรูป',
    3: 'เขียนข้อความ',
    4: 'เลือกธีมสี',
  };

  return (
    <main className={styles.page} style={themeVars}>
      <div className={styles.container}>
        <header className={styles.header}>
          <a className={styles.back} href="/dashboard/legacy-box">
            ← กลับหน้ากล่อง
          </a>
          <h1 className={styles.title}>สร้างกล่องของขวัญ 🎁</h1>
        </header>

        {/* step indicator */}
        <div className={styles.steps} aria-label={`ขั้นตอนที่ ${step} จาก 4`}>
          {([1, 2, 3, 4] as const).map((s, i) => (
            <div key={s} style={{ display: 'contents' }}>
              {i > 0 && <span className={styles.stepLine} aria-hidden />}
              <div
                className={`${styles.step} ${s === step ? styles.stepActive : ''} ${s < step ? styles.stepDone : ''}`}
              >
                <span className={styles.stepDot}>{s < step ? '✓' : s}</span>
                <span className={styles.stepLabel}>{stepLabels[s]}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ---------- step 1: occasion ---------- */}
        {step === 1 && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>กล่องนี้ส่งในโอกาสไหน</h2>
            <p className={styles.cardHint}>เลือกโอกาสแล้วเราจะจัดธีมสีและประโยคส่งท้ายให้ก่อน เปลี่ยนเองได้ทีหลัง</p>

            <div className={styles.occasionGrid} role="radiogroup" aria-label="โอกาส">
              {OCCASION_IDS.map((id) => {
                const item = OCCASIONS[id];
                const Icon = OCCASION_ICONS[id];
                const selected = id === occasion;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`${styles.occasionCard} ${selected ? styles.occasionCardActive : ''}`}
                    onClick={() => pickOccasion(id)}
                  >
                    <span className={styles.occasionIcon} aria-hidden>
                      <Icon />
                    </span>
                    <span className={styles.occasionName}>{item.name}</span>
                    <span className={styles.occasionSub}>{item.subtitle}</span>
                    {selected && (
                      <span className={styles.occasionCheck} aria-hidden>
                        <CheckBadgeIcon />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className={styles.navRow}>
              <span />
              <button
                type="button"
                className={`${styles.navBtn} ${styles.nextBtn}`}
                onClick={() => setStep(2)}
                disabled={!occasion}
              >
                ถัดไป →
              </button>
            </div>
          </section>
        )}

        {/* ---------- step 2: photos ---------- */}
        {step === 2 && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>เลือกรูปความทรงจำ</h2>
            <p className={styles.cardHint}>ใส่ได้ 1–10 รูป ลากสลับตำแหน่งเพื่อจัดลำดับได้เลย</p>

            <div
              className={`${styles.dropZone} ${dragOverZone ? styles.dropZoneOver : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverZone(true);
              }}
              onDragLeave={() => setDragOverZone(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverZone(false);
                if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
              }}
              aria-label="เพิ่มรูปภาพ"
            >
              <span className={styles.dropEmoji} aria-hidden>
                📷
              </span>
              <p className={styles.dropText}>แตะเพื่อเลือกรูป หรือลากมาวางตรงนี้</p>
              <p className={styles.dropSub}>JPG · PNG · WebP · GIF สูงสุด {MAX_SOURCE_MB} MB ต่อรูป</p>
            </div>
            <input
              ref={fileInputRef}
              className={styles.hiddenInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />

            {photos.length > 0 && (
              <>
                <p className={styles.photoCounter}>
                  {photos.length}/{MAX_PHOTOS} รูป
                </p>
                <div className={styles.photoGrid}>
                  {photos.map((photo, i) => (
                    <div
                      key={photo.key}
                      className={[
                        styles.polaroidThumb,
                        dragIndex === i ? styles.polaroidDragging : '',
                        dropIndex === i && dragIndex !== null && dragIndex !== i
                          ? styles.polaroidDropTarget
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ '--tilt': `${tilts[i]}deg` } as React.CSSProperties}
                      draggable
                      onDragStart={() => setDragIndex(i)}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setDropIndex(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDropIndex(i);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragIndex !== null) movePhoto(dragIndex, i);
                        setDragIndex(null);
                        setDropIndex(null);
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                      <img className={styles.polaroidThumbImg} src={photo.previewUrl} alt={`รูปที่ ${i + 1}`} />
                      <span className={styles.polaroidIndex}>{String(i + 1).padStart(2, '0')}</span>
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => removePhoto(photo.key)}
                        aria-label={`ลบรูปที่ ${i + 1}`}
                      >
                        ×
                      </button>
                      {/* arrow reorder — the touch-friendly path (LINE browser has no drag) */}
                      <span className={styles.moveBtns}>
                        <button
                          type="button"
                          className={styles.moveBtn}
                          onClick={() => movePhoto(i, i - 1)}
                          disabled={i === 0}
                          aria-label="เลื่อนไปทางซ้าย"
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          className={styles.moveBtn}
                          onClick={() => movePhoto(i, i + 1)}
                          disabled={i === photos.length - 1}
                          aria-label="เลื่อนไปทางขวา"
                        >
                          ›
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.navRow}>
              <button type="button" className={`${styles.navBtn} ${styles.backBtn}`} onClick={() => setStep(1)}>
                ← ย้อนกลับ
              </button>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.nextBtn}`}
                onClick={() => setStep(3)}
                disabled={photos.length === 0}
              >
                ถัดไป →
              </button>
            </div>
          </section>
        )}

        {/* ---------- step 3: message + tagline + pro placeholder ---------- */}
        {step === 3 && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>เขียนถึงคนพิเศษ</h2>
            <p className={styles.cardHint}>ข้อความจะโชว์หลังเขาเปิดกล่อง (เว้นว่างได้)</p>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="box-title">
                ชื่อกล่อง
              </label>
              <input
                id="box-title"
                className={styles.titleInput}
                type="text"
                value={title}
                maxLength={MAX_TITLE}
                placeholder="ชื่อกล่องของขวัญ..."
                onChange={(e) => setTitle(e.target.value)}
              />
              <span className={styles.charCount}>
                {title.length}/{MAX_TITLE}
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="box-message">
                ข้อความ
              </label>
              <textarea
                id="box-message"
                className={styles.messageInput}
                value={message}
                maxLength={MAX_MESSAGE}
                placeholder="เขียนข้อความถึงคนที่คุณรัก..."
                onChange={(e) => setMessage(e.target.value)}
              />
              <span
                className={`${styles.charCount} ${message.length >= MAX_MESSAGE ? styles.charCountOver : ''}`}
              >
                {message.length}/{MAX_MESSAGE}
              </span>
            </div>

            {/* ---- tagline picker ---- */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>เลือกประโยคส่งท้าย</span>
              <div className={styles.taglineChips} role="radiogroup" aria-label="ประโยคส่งท้าย">
                {visibleTaglines.map((line) => {
                  const selected = !customTagline.trim() && line === tagline;
                  return (
                    <button
                      key={line}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`${styles.taglineChip} ${selected ? styles.taglineChipActive : ''}`}
                      onClick={() => pickTaglineChip(line)}
                    >
                      {line}
                    </button>
                  );
                })}
              </div>
              {!showAllTaglines && (
                <button
                  type="button"
                  className={styles.taglineMore}
                  onClick={() => setShowAllTaglines(true)}
                >
                  ดูเพิ่มเติม
                </button>
              )}

              <label className={styles.customTaglineLabel} htmlFor="box-tagline">
                หรือพิมพ์เอง...
              </label>
              <input
                id="box-tagline"
                className={styles.titleInput}
                type="text"
                value={customTagline}
                maxLength={MAX_TAGLINE_LENGTH}
                placeholder="เขียนประโยคส่งท้ายของคุณเอง..."
                onChange={(e) => onCustomTaglineChange(e.target.value)}
              />
              <span
                className={`${styles.charCount} ${customTagline.length >= MAX_TAGLINE_LENGTH ? styles.charCountOver : ''}`}
              >
                {customTagline.length}/{MAX_TAGLINE_LENGTH}
              </span>
              <p className={styles.taglinePreview}>
                จะขึ้นบนกล่องว่า “<strong>{effectiveTagline}</strong>”
              </p>
            </div>

            {/* ---- voice message (optional) ---- */}
            <VoiceRecorder value={voice} onChange={setVoice} />

            {/* ---- Pro placeholder (demand test — no upload exists) ---- */}
            <div className={styles.proSection}>
              <span className={styles.fieldLabel}>ฟีเจอร์พิเศษ (Pro)</span>
              <div className={styles.proRows}>
                {PRO_FEATURES.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className={styles.proRow}
                    onClick={() => setProModal(id)}
                  >
                    <span className={styles.proRowIcon} aria-hidden>
                      <Icon />
                    </span>
                    <span className={styles.proRowLabel}>{label}</span>
                    {proNotified.includes(id) && <span className={styles.proDone}>จะแจ้งเตือนน้า</span>}
                    <span className={styles.proBadge}>
                      <span className={styles.proLock} aria-hidden>
                        <LockIcon />
                      </span>
                      Pro
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.navRow}>
              <button type="button" className={`${styles.navBtn} ${styles.backBtn}`} onClick={() => setStep(2)}>
                ← ย้อนกลับ
              </button>
              <button type="button" className={`${styles.navBtn} ${styles.nextBtn}`} onClick={() => setStep(4)}>
                ถัดไป →
              </button>
            </div>
          </section>
        )}

        {/* ---------- step 4: theme ---------- */}
        {step === 4 && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>เลือกธีมสี</h2>
            <p className={styles.cardHint}>ทั้งหน้าจะเปลี่ยนตามสีที่เลือก ลองกดดูได้เลย</p>

            <div className={styles.themeLayout}>
              <div className={styles.themePickerCol}>
                <div className={styles.themeRow} role="radiogroup" aria-label="ธีมสี">
                  {THEME_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={id === themeId}
                      aria-label={THEMES[id].name}
                      className={`${styles.themeCircle} ${id === themeId ? styles.themeCircleActive : ''}`}
                      style={
                        {
                          '--swatch': THEMES[id].boxColor,
                          '--swatch-ring': THEMES[id].accent,
                        } as React.CSSProperties
                      }
                      onClick={() => setThemeId(id)}
                    />
                  ))}
                </div>
                <p className={styles.themeName}>{theme.name}</p>
              </div>

              <div className={styles.previewCol}>
                <span className={styles.previewLabel}>ตัวอย่างกล่อง</span>
                <div className={styles.previewStage}>
                  <span className={styles.previewGift} aria-hidden>
                    <span className={styles.previewLid} />
                    <span className={styles.previewBody} />
                  </span>
                  <p className={styles.previewTitle}>{title.trim() || 'กล่องของขวัญ'}</p>
                </div>
              </div>
            </div>

            {submitting && (
              <div className={styles.progressWrap}>
                <p className={styles.progressLabel}>กำลังอัพโหลด… {progress}%</p>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.navRow}>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.backBtn}`}
                onClick={() => setStep(3)}
                disabled={submitting}
              >
                ← ย้อนกลับ
              </button>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.submitBtn}`}
                onClick={() => void submit()}
                disabled={submitting || photos.length === 0}
              >
                {submitting && <span className={styles.spinner} aria-hidden />}
                {submitting ? 'กำลังสร้าง…' : 'สร้างกล่องของขวัญ 🎁'}
              </button>
            </div>
          </section>
        )}
      </div>

      {proModal && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pro-modal-title"
          onClick={() => setProModal(null)}
        >
          {/* stop the backdrop's dismiss from firing on clicks inside the panel */}
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <span className={styles.modalIcon} aria-hidden>
              <LockIcon />
            </span>
            <h2 className={styles.modalTitle} id="pro-modal-title">
              ฟีเจอร์นี้อยู่ในแผน Pro
            </h2>
            <p className={styles.modalText}>เร็วๆ นี้ — กดแจ้งเตือนเพื่อรับข่าวสาร</p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.nextBtn}`}
                onClick={() => void notifyPro(proModal)}
              >
                แจ้งเตือนฉัน
              </button>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.backBtn}`}
                onClick={() => setProModal(null)}
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </main>
  );
}
