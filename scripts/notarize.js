const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] Submitting ${appPath} to Apple...`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleApiKey: path.join(process.env.HOME, 'Developer/Certs/AuthKey_6QRBAGLX8R.p8'),
    appleApiKeyId: '6QRBAGLX8R',
    appleApiIssuer: '4d48474b-0199-4de5-86d6-f2cda26935a5',
  });

  console.log('[notarize] Done!');
};
