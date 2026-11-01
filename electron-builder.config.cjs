/** @type {import('electron-builder').Configuration} */
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)

module.exports = {
  appId: 'xyz.proxnode.retronet',
  productName: 'RetroNet',
  copyright: 'RetroNet',
  asar: true,
  directories: { output: 'dist', buildResources: 'build' },
  files: [
    'out/**',
    'package.json',
    '!**/*.map',
    '!node_modules/**/{src,test,tests,__tests__,benchmarks}/**',
    '!node_modules/**/*.{md,ts.map}'
  ],
  protocols: [{ name: 'Web site URL', schemes: ['http', 'https'], role: 'Viewer' }], // CFBundleURLTypes
  publish: null, // no auto-update, no telemetry (AC40)
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false
  },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    identity: '-', // ad-hoc signature; no Apple Developer account
    hardenedRuntime: notarize,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    minimumSystemVersion: '13.0',
    extendInfo: {
      // Lets macOS list RetroNet as a browser. Rank Alternate: never takes .html away from the user's editor.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'HTML document',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.html', 'public.xhtml']
        }
      ],
      // Shown by macOS the first time a site you allowed asks for the device (T13 permission prompt comes first).
      NSCameraUsageDescription: 'RetroNet needs camera access so websites you allow can use your camera.',
      NSMicrophoneUsageDescription: 'RetroNet needs microphone access so websites you allow can use your microphone.',
      NSLocationUsageDescription: 'RetroNet needs location access so websites you allow can see where you are.',
      NSLocationWhenInUseUsageDescription: 'RetroNet needs location access so websites you allow can see where you are.'
    }
  },
  dmg: {
    title: 'RetroNet',
    background: 'build/dmg-background.png', // @2x sibling is picked up automatically
    window: { width: 660, height: 400 },
    contents: [
      { x: 180, y: 200 },
      { x: 480, y: 200, type: 'link', path: '/Applications' }
    ]
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico'
  },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true }
}
