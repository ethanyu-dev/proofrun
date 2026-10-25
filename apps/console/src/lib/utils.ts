import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并组件样式，并让调用方提供的工具类覆盖组件默认值。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
