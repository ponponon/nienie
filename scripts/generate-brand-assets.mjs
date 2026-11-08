import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(rootDir, 'assets/branding/nienie-logo-p6.png');

function resize(size, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', outputPath], {
    stdio: 'ignore',
  });
}

function makeIco(outputPath, frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(frames.length * 16);
  const payloads = [];
  let offset = header.length + directory.length;

  frames.forEach(({ size, path }, index) => {
    const png = readFileSync(path);
    const entryOffset = index * 16;
    directory[entryOffset] = size === 256 ? 0 : size;
    directory[entryOffset + 1] = size === 256 ? 0 : size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(png.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += png.length;
    payloads.push(png);
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.concat([header, directory, ...payloads]));
}

function makeIcns(outputPath) {
  const entries = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const chunks = entries.map(([type, size]) => {
    const path = size <= 256
      ? join(rootDir, `apps/desktop/assets/icon-${size}.png`)
      : size === 512
        ? join(rootDir, 'apps/desktop/assets/nienie-logo.png')
        : join(rootDir, 'assets/branding/nienie-logo-1024.png');
    const png = readFileSync(path);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + header.length, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + header.length, 4);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.concat([header, body]));
}

const brandDir = join(rootDir, 'assets/branding');
resize(1024, join(brandDir, 'nienie-logo-1024.png'));
resize(512, join(brandDir, 'nienie-logo-512.png'));

const websiteAssets = join(rootDir, 'website/assets');
const webSizes = [16, 32, 48, 64, 180, 192, 512];
for (const size of webSizes) {
  resize(size, join(websiteAssets, `nienie-icon-${size}.png`));
}
copyFileSync(
  join(websiteAssets, 'nienie-icon-180.png'),
  join(websiteAssets, 'apple-touch-icon.png'),
);
const faviconFrames = [16, 32, 48, 64, 128, 256].map((size) => {
  const path = join(rootDir, `apps/desktop/assets/icon-${size}.png`);
  resize(size, path);
  return { size, path };
});
makeIco(join(rootDir, 'website/favicon.ico'), faviconFrames);

const desktopAssets = join(rootDir, 'apps/desktop/assets');
resize(512, join(desktopAssets, 'nienie-logo.png'));
makeIco(join(desktopAssets, 'nienie.ico'), faviconFrames);
makeIcns(join(desktopAssets, 'nienie.icns'));

const mobileAssets = join(rootDir, 'apps/mobile/assets/brand');
resize(512, join(mobileAssets, 'nienie-logo.png'));

const androidRes = join(rootDir, 'apps/mobile/android/app/src/main/res');
for (const [density, size] of [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]) {
  resize(size, join(androidRes, density, 'ic_launcher.png'));
}
resize(432, join(androidRes, 'drawable-nodpi/ic_launcher_foreground.png'));
resize(256, join(androidRes, 'drawable-nodpi/nienie-launch-image.png'));

const iosIcons = join(
  rootDir,
  'apps/mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset',
);
for (const [filename, size] of [
  ['Icon-App-20x20@2x.png', 40],
  ['Icon-App-20x20@3x.png', 60],
  ['Icon-App-29x29@1x.png', 29],
  ['Icon-App-29x29@2x.png', 58],
  ['Icon-App-29x29@3x.png', 87],
  ['Icon-App-40x40@2x.png', 80],
  ['Icon-App-40x40@3x.png', 120],
  ['Icon-App-60x60@2x.png', 120],
  ['Icon-App-60x60@3x.png', 180],
  ['Icon-App-20x20@1x.png', 20],
  ['Icon-App-40x40@1x.png', 40],
  ['Icon-App-76x76@1x.png', 76],
  ['Icon-App-76x76@2x.png', 152],
  ['Icon-App-83.5x83.5@2x.png', 167],
  ['Icon-App-1024x1024@1x.png', 1024],
]) {
  resize(size, join(iosIcons, filename));
}

const launchImages = join(
  rootDir,
  'apps/mobile/ios/Runner/Assets.xcassets/LaunchImage.imageset',
);
for (const [filename, size] of [
  ['LaunchImage.png', 168],
  ['LaunchImage@2x.png', 336],
  ['LaunchImage@3x.png', 504],
]) {
  resize(size, join(launchImages, filename));
}

const manifest = {
  name: 'Nienie',
  short_name: 'Nienie',
  start_url: './',
  display: 'standalone',
  background_color: '#FCE7DD',
  theme_color: '#FCE7DD',
  icons: [
    {
      src: 'assets/nienie-icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: 'assets/nienie-icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
  ],
};
writeFileSync(
  join(rootDir, 'website/site.webmanifest'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

process.stdout.write('Generated Nienie P6 logo assets for web, iOS, Android, and desktop.\n');
