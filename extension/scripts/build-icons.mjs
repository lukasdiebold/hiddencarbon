import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(root, 'public/icon/hidden-carbon-dark.svg');
const OUT_DIR = join(root, 'public/icon');
const SIZES = [16, 32, 48, 96, 128];

for (const size of SIZES) {
  const out = join(OUT_DIR, `${size}.png`);
  await sharp(SRC, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}
