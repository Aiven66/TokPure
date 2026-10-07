'use client';

/**
 * `next/link` 兼容 shim。
 *
 * public-pkg 使用 `import Link from 'next/link'`，并常配合 `<Button asChild>`（Radix Slot）
 * 传入 className 等 props，因此这里必须：渲染 <a>、透传全部 props 与 ref。
 * 站点为多页（.html），点击默认整页跳转；hash / 外链 / 新窗口行为不受影响。
 */

import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  replace?: boolean;
  prefetch?: boolean;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, replace, prefetch, onClick, target, ...rest },
  ref,
) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // 新窗口 / 修饰键 / 外链 / hash 锚点：交给浏览器默认行为
    if (target && target !== '_self') return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (/^(https?:)?\/\//.test(href) || href.startsWith('mailto:') || href.startsWith('#')) return;

    event.preventDefault();
    if (replace) window.location.replace(href);
    else window.location.assign(href);
  };

  return <a ref={ref} href={href} target={target} onClick={handleClick} {...rest} />;
});

export default Link;