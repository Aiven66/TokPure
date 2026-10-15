/**
 * `<Dropzone />` —— 通用「拖拽 / 点击选择文件」区域。
 *
 * 用法：
 *   import { Dropzone } from 'public-pkg/ui/dropzone';
 *   <Dropzone title="拖拽图片到此处" hint="或点击选择图片" accept="image/*" multiple
 *             onFiles={(files) => ...} />
 *
 * 说明：
 * - 只负责「取文件」，不关心后续上传逻辑；文案由调用方传入（便于 i18n）；
 * - `disabled` / `loading` 时整块不可交互并降透明度；
 * - 面板化展示：`icon` 可换成业务图标（默认上传图标）。
 */

'use client';

import * as React from 'react';
import { Loader2, UploadCloud } from 'lucide-react';

import { cn } from '../lib/utils';

export interface DropzoneProps {
  /** 主文案。 */
  title: string;
  /** 次要提示（如「或点击选择图片」）。 */
  hint?: string;
  /** 原生 accept 属性，如 `image/*` 或 `.html,.htm,.txt`。 */
  accept?: string;
  /** 是否允许多选。 */
  multiple?: boolean;
  /** 不可交互。 */
  disabled?: boolean;
  /** 上传中：显示旋转图标。 */
  loading?: boolean;
  /** 自定义图标（默认 `UploadCloud`）。 */
  icon?: React.ReactNode;
  /** 选中文件回调。 */
  onFiles?: (files: File[]) => void;
  className?: string;
}

export function Dropzone({
  title,
  hint,
  accept,
  multiple,
  disabled,
  loading,
  icon,
  onFiles,
  className,
}: DropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const inactive = Boolean(disabled || loading);

  const emit = React.useCallback(
    (list: FileList | null | undefined) => {
      if (!list || list.length === 0) return;
      onFiles?.(Array.from(list));
    },
    [onFiles],
  );

  const openPicker = React.useCallback(() => {
    if (inactive) return;
    inputRef.current?.click();
  }, [inactive]);

  return (
    <div
      role="button"
      tabIndex={inactive ? -1 : 0}
      aria-disabled={inactive || undefined}
      onClick={openPicker}
      onKeyDown={(event) => {
        if (inactive) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPicker();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!inactive) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (inactive) return;
        emit(event.dataTransfer?.files);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center transition-colors outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        dragging && 'border-primary bg-primary/5',
        inactive && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <span className="text-muted-foreground [&_svg]:size-7">
        {loading ? <Loader2 className="animate-spin" /> : icon ?? <UploadCloud />}
      </span>
      <span className="text-sm font-medium text-foreground">{title}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        disabled={inactive}
        onChange={(event) => {
          emit(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}
