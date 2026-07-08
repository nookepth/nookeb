'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { ApiError, getSharePreview, getShareDownloadUrl, type SharePreview } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { DownloadIcon } from '@/components/icons';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: SharePreview }
  | { kind: 'expired' }
  | { kind: 'notfound' };

function isPdf(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { downloadUrl, fileName } = await getShareDownloadUrl(token);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setDownloadError('ลิงก์หมดอายุแล้ว กรุณาขอลิงก์ใหม่');
      } else {
        setDownloadError('เกิดข้อผิดพลาด กรุณาลองใหม่');
      }
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    let active = true;
    getSharePreview(token)
      .then((data) => {
        if (active) setState({ kind: 'ready', data });
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 410) setState({ kind: 'expired' });
        else setState({ kind: 'notfound' });
      });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <main className="share-page">
      <div className="share-card">
        {state.kind === 'loading' && <p className="share-page-status">กำลังโหลด...</p>}

        {state.kind === 'expired' && (
          <div className="share-page-message">
            <Image src="/logo.png" alt="หนูเก็บ" width={88} height={88} className="share-page-logo" />
            <h1>ลิงก์หมดอายุแล้ว</h1>
            <p>ลิงก์นี้หมดอายุหรือถูกลบไปแล้ว ลองขอลิงก์ใหม่จากผู้ที่แชร์ให้คุณนะ</p>
          </div>
        )}

        {state.kind === 'notfound' && (
          <div className="share-page-message">
            <Image src="/logo.png" alt="หนูเก็บ" width={88} height={88} className="share-page-logo" />
            <h1>ไม่พบไฟล์นี้</h1>
            <p>ลิงก์อาจไม่ถูกต้อง หรือไฟล์ถูกลบไปแล้ว</p>
          </div>
        )}

        {state.kind === 'ready' && (
          <>
            <div className="share-preview">
              {isImage(state.data.mimeType) ? (
                // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, not a static asset
                <img
                  className="share-preview-img"
                  src={state.data.previewUrl}
                  alt={state.data.fileName}
                />
              ) : isPdf(state.data.mimeType) ? (
                <object
                  className="share-preview-pdf"
                  data={state.data.previewUrl}
                  type="application/pdf"
                  aria-label={state.data.fileName}
                >
                  <p className="share-page-status">
                    เบราว์เซอร์นี้ดูตัวอย่าง PDF ไม่ได้ กดปุ่มดาวน์โหลดด้านล่างเพื่อเปิดไฟล์
                  </p>
                </object>
              ) : (
                <div className="share-preview-generic">
                  <p>ไฟล์นี้ดูตัวอย่างไม่ได้ กดดาวน์โหลดเพื่อเปิด</p>
                </div>
              )}
            </div>

            <div className="share-file-info">
              <h1 className="share-file-name">{state.data.fileName}</h1>
              <p className="share-file-meta">
                {formatBytes(state.data.fileSize)} · แชร์โดยผู้ใช้ หนูเก็บ
              </p>
            </div>

            <button
              type="button"
              className="btn share-download-btn"
              onClick={handleDownload}
              disabled={downloading}
            >
              <DownloadIcon /> {downloading ? 'กำลังเตรียมไฟล์...' : 'ดาวน์โหลด'}
            </button>
            {downloadError && <p className="share-page-status">{downloadError}</p>}
          </>
        )}

        <footer className="share-footer">
          powered by{' '}
          <a href="/" className="share-footer-link">
            หนูเก็บ
          </a>
        </footer>
      </div>
    </main>
  );
}
