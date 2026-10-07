import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind 类名合并（与 shadcn/ui 约定一致）。
 * 依赖：clsx + tailwind-merge（宿主项目需已安装，本项目已安装）。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}