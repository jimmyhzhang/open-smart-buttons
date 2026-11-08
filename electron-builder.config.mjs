// electron-builder configuration for Open Smart Buttons for Mac. scripts/build-electron.mjs adds the signing
// identity, notarization and update channel from the environment; see docs/RELEASE.md.

import { APP_NAME, APP_ID, PACKAGE_NAME } from './src/shared/brand.ts';

/** @type {import('electron-builder').Configuration} */
export default {
  appId: APP_ID,
  productName: APP_NAME,
  copyright: 'Copyright © 2026 Reading Plus AI LLC',
  directories: { output: 'dist-app', buildResources: 'build' },

  // The service runs from its TypeScript sources: Electron 44's Node strips types, so nothing is bundled.
  files: [
    'package.json',
    'electron/**/*',
    'src/**/*.ts',
    '!src/tools/**',
    'ui/dist/**/*',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    '!**/node_modules/node-hid/prebuilds/HID{,_hidraw}-{linux,win32}*/**',
    '!**/node_modules/node-hid/{src,hidapi,binding.gyp}/**',
    '!**/node_modules/node-hid/binding.gyp',
    '!**/node_modules/lucide-static/{dist,font,sprite.svg,icon-nodes.json,rollup.config.mjs,tsconfig.json}',
  ],
  // Readable outside the ASAR, so Settings ▸ About ▸ Licenses can open them.
  extraResources: [
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'LICENSE', to: 'LICENSE.txt' },
    { from: 'build/NATIVE_NOTICES.txt', to: 'NATIVE_NOTICES.txt' }, // scripts/native-notices.mjs
  ],
  asar: true,
  asarUnpack: ['**/*.node'],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,

  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    target: [{ target: 'dmg' }, { target: 'zip' }], // electron-updater installs from the zip
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    minimumSystemVersion: '13.0',
    darkModeSupport: true,
    artifactName: `${PACKAGE_NAME}-\${version}-\${arch}.\${ext}`,
    notarize: false,
    extendInfo: {
      NSAppleEventsUsageDescription: 'Open Smart Buttons uses System Events to press the keys and shortcuts you assign.',
    },
  },
  dmg: {
    title: 'Open Smart Buttons ${version}',
    contents: [{ x: 150, y: 190, type: 'file' }, { x: 390, y: 190, type: 'link', path: '/Applications' }],
    window: { width: 540, height: 380 },
  },

  // Security fuses, checked after packaging by scripts/check-app.mjs.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },

  // No update channel unless the build names one (scripts/build-electron.mjs).
  publish: null,
};
