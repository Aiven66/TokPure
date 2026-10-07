/**
 * 极简 toast 提示（零依赖，跟随官网深色视觉）。
 * 仅用于未配置收银台、后台门控失败等轻量反馈，不引入第三方 UI 库。
 */

let hostEl: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (hostEl && document.body.contains(hostEl)) return hostEl;
  hostEl = document.createElement('div');
  hostEl.id = 'tokpure-toast-host';
  hostEl.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:32px',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'align-items:center',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(hostEl);
  return hostEl;
}

export function showToast(message: string, duration = 3200): void {
  if (typeof document === 'undefined' || !message) return;
  const item = document.createElement('div');
  item.textContent = message;
  item.style.cssText = [
    'max-width:min(90vw,420px)',
    'padding:10px 16px',
    'border-radius:12px',
    'background:#282a2e',
    'color:#e2e2e8',
    'font-size:13px',
    'line-height:18px',
    'box-shadow:0 10px 30px rgba(0,0,0,.45)',
    'border:1px solid #5d3f40',
    'opacity:0',
    'transform:translateY(8px)',
    'transition:opacity .18s ease,transform .18s ease',
  ].join(';');
  ensureHost().appendChild(item);
  requestAnimationFrame(() => {
    item.style.opacity = '1';
    item.style.transform = 'translateY(0)';
  });
  window.setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(8px)';
    window.setTimeout(() => item.remove(), 220);
  }, duration);
}