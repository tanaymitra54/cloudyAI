// electron-builder afterPack hook (macOS only).
//
// electron-builder does not sign loose binaries in Contents/Resources, and it
// signs nothing at all on a machine without a Developer ID. That leaves the
// app bundle unsigned, which makes macOS record the Swift helpers' screen
// capture request as a separate "CloudyAI" row (generic exec icon) in
// System Settings → Privacy & Security → Screen & System Audio Recording.
//
// scripts/sign-app.sh signs the helpers and then the bundle as one identity.
// Signing must happen here: after the files are packed, before the DMG is
// built, and before anything else touches the bundle.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { appOutDir, packager } = context;
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const script = path.join(__dirname, 'sign-app.sh');

  execFileSync('bash', [script, appPath], { stdio: 'inherit' });
};
