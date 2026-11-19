import { useRef, useState } from 'react';
import Icon from './Icon';

export const AUDIO_ACCEPT = 'audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.webm';

export default function DropZone(props: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  compact?: boolean;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={`dropzone ${over ? 'is-over' : ''} ${props.compact ? 'is-compact' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) props.onFiles(props.multiple ? files : files.slice(0, 1));
      }}
    >
      <span className="dropzone-icon">
        <Icon name="upload" size={props.compact ? 18 : 22} />
      </span>
      <div>
        <p className="dropzone-title">
          {props.title ?? (props.multiple ? 'Drop audio files here' : 'Drop an audio file here')}
        </p>
        <p className="dropzone-sub">
          or <span className="link">browse</span> · MP3, WAV, M4A, OGG, FLAC
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple={props.multiple}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) props.onFiles(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
