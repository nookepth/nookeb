'use client';

import { useEffect, useState } from 'react';
import type { DiaryNotificationSettingsDto } from '@nookeb/shared';
import { ApiError, updateDiaryNotification } from '@/lib/api';

/**
 * เตือนให้เขียนไดอารี่ — ONE card for the whole reminder setting.
 *
 * REPLACES TWO CARDS on /dashboard/diary: "ให้หนูเก็บทักเตือนใน LINE" (the push
 * opt-in, saved instantly by its own PATCH) and "แจ้งเตือนบันทึกไดอารี่" (the
 * banner toggle + time, saved by a button). That split was never two settings —
 * it was one setting cut in the wrong place:
 *
 *   - `notificationEnabled` (migration 053) = deliver via LINE push
 *   - `isEnabled` (migration 028)          = deliver via the in-app banner
 *   - `notifyTime`                         = WHEN, and it drives BOTH
 *     (jobs/diaryReminder.job.ts `isDueThisHour` and DiaryReminderBanner)
 *
 * So the card that owned the clock did not own the LINE switch, and a user had
 * to keep that relationship in their head across two cards and two save models
 * — with a live way to end up half-configured (push on, banner time never set,
 * or a time saved while the channel it belonged to was off).
 *
 * All three fields survive; only the shape changed. PUT /diary/notification has
 * always carried all three, so nothing on the API side moved.
 *
 * Its own component (rather than more JSX in the 400-line diary page) because
 * it owns a form's worth of state and one save, and because it can then be
 * rendered on its own.
 */
export default function DiaryReminderSettings({
  settings,
  onUnauthorized,
}: {
  /** Loaded settings, or null while the page is still fetching. */
  settings: DiaryNotificationSettingsDto | null;
  onUnauthorized: () => void;
}) {
  const [notifyTime, setNotifyTime] = useState(settings?.notifyTime ?? '20:00');
  /** isEnabled — the in-app banner channel. */
  const [bannerEnabled, setBannerEnabled] = useState(settings?.isEnabled ?? true);
  /** notificationEnabled — the LINE push channel. DEFAULT OFF, always opt-in. */
  const [pushEnabled, setPushEnabled] = useState(settings?.notificationEnabled ?? false);
  /** What the server currently holds — the baseline `dirty` is measured against. */
  const [saved, setSaved] = useState<DiaryNotificationSettingsDto | null>(settings);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Adopt the settings when they arrive (or when the page reloads them). Keyed
  // on the values rather than the object so a re-fetch that returned the same
  // settings does not stomp on edits the user has made since.
  useEffect(() => {
    if (!settings) return;
    setNotifyTime(settings.notifyTime);
    setBannerEnabled(settings.isEnabled);
    setPushEnabled(settings.notificationEnabled);
    setSaved(settings);
    setSaveState('idle');
  }, [settings?.notifyTime, settings?.isEnabled, settings?.notificationEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The master switch. ON when either channel is on — there is no fourth stored
   * field behind it, which is what keeps the card honest: "เปิดอยู่" can never
   * mean something different from what the two channel boxes say.
   */
  const reminderOn = pushEnabled || bannerEnabled;

  /**
   * Turning the master ON pre-ticks BOTH channels rather than leaving the user
   * with a switched-on reminder that reaches them nowhere. Not a silent push
   * opt-in: nothing is written until บันทึก, and the LINE box is right there,
   * ticked and visible, to be un-ticked first.
   */
  function toggleMaster(next: boolean): void {
    setPushEnabled(next);
    setBannerEnabled(next);
    if (saveState !== 'saving') setSaveState('idle');
  }

  const dirty =
    saved !== null &&
    (notifyTime !== saved.notifyTime ||
      bannerEnabled !== saved.isEnabled ||
      pushEnabled !== saved.notificationEnabled);

  /**
   * ONE save for the whole card. PUT /diary/notification writes all three
   * fields together, so the push opt-in can no longer end up disagreeing with
   * the time and channel it was configured next to — which is exactly what two
   * cards with two save models allowed.
   */
  async function save(): Promise<void> {
    if (saveState === 'saving' || !saved) return;
    setSaveState('saving');
    const next: DiaryNotificationSettingsDto = {
      notifyTime,
      isEnabled: bannerEnabled,
      timezone: saved.timezone,
      notificationEnabled: pushEnabled,
    };
    try {
      await updateDiaryNotification(next);
      // Re-anchor the baseline so the button settles instead of staying armed
      // over values the server now agrees with.
      setSaved(next);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      setSaveState('error');
    }
  }

  /**
   * What the settings actually do, in one sentence built from the live state —
   * so the card never needs a static caption that could drift from the switches
   * above it. The wording matches each channel's real behaviour: the push is a
   * message in the LINE chat at that time; the banner appears on the web page
   * any time it is opened after that time (see DiaryReminderBanner.isDue).
   */
  function summary(): string {
    if (!reminderOn) return 'ตอนนี้ปิดอยู่ หนูจะไม่เตือนเรื่องไดอารี่เลยน้า';
    if (pushEnabled && bannerEnabled) {
      return `ถ้าวันไหนยังไม่ได้บันทึก หนูจะทักในแชท LINE ตอน ${notifyTime} และขึ้นแถบเตือนบนหน้าเว็บให้ด้วยน้า`;
    }
    if (pushEnabled) {
      return `ถ้าวันไหนยังไม่ได้บันทึก หนูจะทักไปในแชท LINE ตอน ${notifyTime} น้า`;
    }
    return `ถ้าวันไหนยังไม่ได้บันทึก หนูจะขึ้นแถบเตือนบนหน้าเว็บ เมื่อเปิดเว็บหลัง ${notifyTime} น้า`;
  }

  return (
    <section className="diary-settings diary-reminder">
      <div className="diary-reminder-head">
        <div className="diary-reminder-heading">
          <h2>เตือนให้เขียนไดอารี่</h2>
          <p className="diary-settings-hint">
            วันไหนยังไม่ได้บันทึก หนูเก็บจะเตือนให้ตามเวลาที่ตั้งไว้น้า
          </p>
        </div>
        {/* The master switch. Its label states the state in words — a bare tick
            mark makes "am I being reminded or not?" a question about a checkbox
            rather than an answer. */}
        <label className="diary-switch">
          <input
            type="checkbox"
            role="switch"
            checked={reminderOn}
            aria-label="เปิดการเตือนให้เขียนไดอารี่"
            onChange={(e) => toggleMaster(e.target.checked)}
          />
          <span className="diary-switch-track" aria-hidden>
            <span className="diary-switch-knob" />
          </span>
          <span className="diary-switch-text">{reminderOn ? 'เปิดอยู่' : 'ปิดอยู่'}</span>
        </label>
      </div>

      {/* Progressive disclosure: when/where only exist once there is something
          to deliver. Off → the card is one switch and nothing to decide. */}
      {reminderOn && (
        <div className="diary-reminder-body">
          <div className="diary-reminder-field">
            <span className="diary-reminder-label">เตือนตอน</span>
            <input
              className="diary-reminder-time"
              type="time"
              value={notifyTime}
              aria-label="เวลาที่ให้หนูเก็บเตือน"
              onChange={(e) => setNotifyTime(e.target.value)}
            />
          </div>

          <div className="diary-reminder-field">
            <span className="diary-reminder-label">เตือนทางไหน</span>
            <div className="diary-channels" role="group" aria-label="ช่องทางการเตือน">
              {/* The selected tint rides on `diary-channel-on` rather than a CSS
                  `:has(input:checked)` — see the note on that rule in globals.css. */}
              <label className={`diary-channel${pushEnabled ? ' diary-channel-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={pushEnabled}
                  onChange={(e) => setPushEnabled(e.target.checked)}
                />
                <span className="diary-channel-text">
                  <strong>ทักในแชท LINE</strong>
                  <span>หนูเก็บส่งข้อความหาในแชท</span>
                </span>
              </label>
              <label className={`diary-channel${bannerEnabled ? ' diary-channel-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={bannerEnabled}
                  onChange={(e) => setBannerEnabled(e.target.checked)}
                />
                <span className="diary-channel-text">
                  <strong>แถบเตือนบนหน้าเว็บ</strong>
                  <span>ขึ้นแถบเตือนตอนเปิดเว็บ</span>
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      <p className="diary-reminder-summary" role="status" aria-live="polite">
        {summary()}
      </p>

      <div className="diary-reminder-actions">
        {dirty && <span className="diary-reminder-dirty">ยังไม่ได้บันทึก</span>}
        <button
          className="btn diary-save-btn"
          onClick={() => void save()}
          disabled={saveState === 'saving' || !dirty}
        >
          {saveState === 'saving'
            ? 'กำลังบันทึก…'
            : saveState === 'saved'
              ? 'บันทึกแล้ว ✓'
              : 'บันทึกการตั้งค่า'}
        </button>
      </div>
      {saveState === 'error' && (
        <p className="diary-error">บันทึกการตั้งค่าไม่สำเร็จ ลองใหม่อีกทีน้า</p>
      )}
    </section>
  );
}
