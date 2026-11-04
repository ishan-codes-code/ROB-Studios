const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// ROB application icons (waveform mark on a white rounded square).
// Paths resolve from this config file so packaging never depends on
// the shell working directory. The packager picks the platform asset
// from the extension-less base: icon.ico on Windows, icon.icns on
// macOS, icon.png on Linux.
const APP_ICON = path.resolve(__dirname, 'src/assets/icons/icon');
const APP_ICON_PNG = `${APP_ICON}.png`;
const PYTHON_ENGINE = path.resolve(__dirname, '../python/dist/ROBEngine');
const FFMPEG_BINARY = path.resolve(
  __dirname,
  'node_modules/ffmpeg-static',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);

module.exports = {
  packagerConfig: {
    asar: true,
    icon: APP_ICON,
    executableName: 'ROB Studios',
    win32metadata: {
      CompanyName: 'ROB Studios',
      FileDescription: 'ROB Studios',
      InternalName: 'ROB Studios',
      OriginalFilename: 'ROB Studios.exe',
      ProductName: 'ROB Studios',
    },
    // The ffmpeg binary ships beside the asar (it cannot execute from
    // inside the archive). The vite plugin prunes node_modules, so the
    // binary rides as an extra resource instead of a require() target.
    // icon.png rides along so the packaged BrowserWindow can use it
    // (src/assets is not part of the vite main bundle).
    extraResource: [
      FFMPEG_BINARY,
      path.resolve(__dirname, 'node_modules/ffmpeg-static/ffmpeg.LICENSE'),
      path.resolve(__dirname, 'node_modules/ffmpeg-static/ffmpeg.README'),
      APP_ICON_PNG,
      ...(require('node:fs').existsSync(PYTHON_ENGINE) ? [PYTHON_ENGINE] : []),
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        setupIcon: `${APP_ICON}.ico`,
        setupExe: 'ROB-Studios-Setup.exe',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          icon: APP_ICON_PNG,
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: APP_ICON_PNG,
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
