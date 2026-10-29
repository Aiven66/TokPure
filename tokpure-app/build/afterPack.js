'use strict';

/* electron-builder afterPack 钩子
   目的：在没有 Apple 开发者证书的情况下，给 .app 做一次完整的 ad-hoc 签名，
   并清除构建产物上的隔离属性。未做完整签名的 arm64 应用一旦带上
   com.apple.quarantine（例如经微信/浏览器传输），macOS 会直接报
   「已损坏，无法打开」，这与代码本身无关。 */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  const run = (bin, args) => {
    try {
      execFileSync(bin, args, { stdio: 'pipe' });
    } catch (e) {
      const msg = (e.stderr || e.stdout || '').toString().trim();
      throw new Error(`${bin} ${args.join(' ')} 失败：${msg || e.message}`);
    }
  };

  run('xattr', ['-cr', appPath]);
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
  // 校验不做 --strict：构建目录里可能残留 Finder 信息，不影响签名有效性
  run('codesign', ['--verify', '--deep', appPath]);
  console.log('  • ad-hoc 签名完成  ' + path.basename(appPath));
};
