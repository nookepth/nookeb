import type { FileDto, FolderDto, TagDto } from '@nookeb/shared';
import { FileCard } from './FileCard';

export interface FileGridProps {
  files: FileDto[];
  folders: FolderDto[];
  tags: TagDto[];
  driveConnected?: boolean;
  onChanged: () => void;
}

export function FileGrid({ files, folders, tags, driveConnected, onChanged }: FileGridProps) {
  if (files.length === 0) {
    return (
      <div className="empty-state">
        <p>ยังไม่มีไฟล์เลย 🐭</p>
        <p>ส่งรูปหรือไฟล์หา LINE OA แล้วหนูจะเก็บให้เอง</p>
      </div>
    );
  }

  return (
    <div className="file-grid">
      {files.map((file) => (
        <FileCard
          key={file.id}
          file={file}
          folders={folders}
          tags={tags}
          driveConnected={driveConnected}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
