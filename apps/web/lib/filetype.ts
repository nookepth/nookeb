/** MIME grouping + colored badge metadata for non-image files. */

export type FileGroup = 'image' | 'doc' | 'video' | 'other';

export function fileGroup(mimeType: string): FileGroup {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    mimeType.includes('word') ||
    mimeType.includes('officedocument') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('presentation') ||
    mimeType.includes('ms-excel') ||
    mimeType.includes('ms-powerpoint')
  ) {
    return 'doc';
  }
  return 'other';
}

export const GROUP_LABEL: Record<FileGroup, string> = {
  image: 'รูปภาพ',
  doc: 'เอกสาร',
  video: 'วิดีโอ',
  other: 'อื่นๆ',
};

export interface TypeBadge {
  label: string;
  color: string;
}

/** Short uppercase label + brand-ish color for the file-type badge. */
export function typeBadge(file: { mimeType: string; extension: string | null; name: string }): TypeBadge {
  const ext = (file.extension ?? file.name.split('.').pop() ?? '').toLowerCase();
  const m = file.mimeType;

  if (m === 'application/pdf' || ext === 'pdf') return { label: 'PDF', color: '#c0392b' };
  if (m.includes('word') || ext === 'doc' || ext === 'docx') return { label: 'DOC', color: '#2b579a' };
  if (m.includes('spreadsheet') || m.includes('ms-excel') || ext === 'xls' || ext === 'xlsx' || ext === 'csv')
    return { label: 'XLS', color: '#217346' };
  if (m.includes('presentation') || m.includes('ms-powerpoint') || ext === 'ppt' || ext === 'pptx')
    return { label: 'PPT', color: '#d24726' };
  if (m.startsWith('video/')) return { label: 'VDO', color: '#8e44ad' };
  if (m.startsWith('audio/')) return { label: 'AUD', color: '#e67e22' };
  if (m.startsWith('text/') || ext === 'txt' || ext === 'md') return { label: 'TXT', color: '#34495e' };
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return { label: 'ZIP', color: '#7f8c8d' };
  if (m.startsWith('image/')) return { label: 'IMG', color: '#16a085' };
  const label = ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
  return { label, color: '#95a5a6' };
}
