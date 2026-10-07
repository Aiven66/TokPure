/**
 * shadcn/ui 语义色 token 注入。
 *
 * 官网既有 Tailwind 配置（每个页面内联的 tailwind.config）只定义了品牌色
 * （primary / surface-* / on-surface …），而 public-pkg 的组件使用 shadcn 语义
 * 类名（bg-background、text-muted-foreground、border-border、bg-card …）。
 *
 * 本文件把这些 token 合并进全局 tailwind.config，值全部取自官网既有深色调色板，
 * 保证公共组件与官网视觉一致。必须在「内联 tailwind.config」之后、页面渲染之前同步执行。
 */
(function () {
  var tw = window.tailwind;
  if (!tw || !tw.config || !tw.config.theme) return;

  var extend = tw.config.theme.extend || (tw.config.theme.extend = {});
  var colors = extend.colors || (extend.colors = {});

  var tokens = {
    foreground: '#e2e2e8',
    background: '#111317',
    card: '#1e2024',
    'card-foreground': '#e2e2e8',
    popover: '#1e2024',
    'popover-foreground': '#e2e2e8',
    'primary-foreground': '#680019',
    'secondary-foreground': '#003735',
    muted: '#282a2e',
    'muted-foreground': '#ad8889',
    accent: '#282a2e',
    'accent-foreground': '#e2e2e8',
    destructive: '#ffb4ab',
    'destructive-foreground': '#690005',
    border: '#5d3f40',
    input: '#5d3f40',
    ring: '#ffb3b6'
  };

  for (var key in tokens) {
    if (Object.prototype.hasOwnProperty.call(tokens, key) && !(key in colors)) {
      colors[key] = tokens[key];
    }
  }

  // 圆角 token（shadcn 组件使用 rounded-lg / rounded-xl，已在既有配置中定义，这里仅兜底）
  if (!extend.borderRadius) extend.borderRadius = {};
  if (!extend.borderRadius.lg) extend.borderRadius.lg = '0.5rem';
  if (!extend.borderRadius.xl) extend.borderRadius.xl = '0.75rem';
})();