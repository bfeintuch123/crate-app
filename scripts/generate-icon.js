const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

async function generateIconFromSource() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const sourcePath = path.join(assetsDir, 'jenna-icon-source.jpg');
  const outputPath = path.join(assetsDir, 'icon.png');
  const trayOutputPath = path.join(assetsDir, 'tray-icon.png');

  const size = 1024;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Fill entire canvas with gradient matching Jenna's icon edges
  // Deep purple top-left to dark blue-black bottom-right
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#3D0B3F');   // deep purple
  gradient.addColorStop(0.5, '#0F0F1A'); // near black with blue tint
  gradient.addColorStop(1, '#0A1628');   // dark blue-black
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Load Jenna's icon source and draw centered on top
  const img = await loadImage(sourcePath);
  // The source is 786x800, not square — scale to fit 1024x1024 and center
  const scale = Math.max(size / img.width, size / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const drawX = (size - drawW) / 2;
  const drawY = (size - drawH) / 2;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated app icon: ${outputPath} (${size}x${size})`);

  // Generate tray icon — small colored version of app icon (36x36)
  const traySize = 36;
  const trayCanvas = createCanvas(traySize, traySize);
  const trayCtx = trayCanvas.getContext('2d');
  trayCtx.drawImage(canvas, 0, 0, traySize, traySize);
  const trayBuffer = trayCanvas.toBuffer('image/png');
  fs.writeFileSync(trayOutputPath, trayBuffer);
  console.log(`Generated tray icon: ${trayOutputPath} (${traySize}x${traySize})`);

  console.log('Icon generation complete!');
}

generateIconFromSource().catch(err => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
