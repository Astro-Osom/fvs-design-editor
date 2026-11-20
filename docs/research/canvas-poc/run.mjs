// Proof of concept: Fabric.js 7 vs Konva 10 on the features the editor needs.
// Runs both libraries in headless Chrome at devicePixelRatio 2 and prints a JSON report.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FABRIC = path.join(here, 'node_modules/fabric/dist/index.min.js');
const KONVA = path.join(here, 'node_modules/konva/konva.min.js');

const helpers = `
window.makeTestImage = (w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const colors = ['#e63946', '#2a9d8f', '#e9c46a', '#264653'];
  [[0,0],[w/2,0],[0,h/2],[w/2,h/2]].forEach(([x,y],i) => { g.fillStyle = colors[i]; g.fillRect(x,y,w/2,h/2); });
  g.fillStyle = '#fff'; g.font = 'bold 60px Arial'; g.fillText('TEST', w/2-80, h/2+20);
  return c.toDataURL('image/png');
};
window.hashCanvas = async (canvas) => {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  // FNV-1a over every pixel byte (crypto.subtle is unavailable on about:blank).
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
};
window.pixelAt = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 900 } });
const report = {};

// ---------------------------------------------------------------- Fabric
{
  const page = await context.newPage();
  await page.setContent('<body style="margin:0;background:#333"><canvas id="c"></canvas></body>');
  await page.addScriptTag({ content: helpers });
  await page.addScriptTag({ path: FABRIC });
  const r = {};
  Object.assign(r, await page.evaluate(async () => {
    const out = {};
    out.version = fabric.version;
    out.dpr = window.devicePixelRatio;
    const canvas = new fabric.Canvas('c', { width: 1280, height: 720, backgroundColor: '#1d3557' });
    window.canvas = canvas;
    // Cropped image with a circular clip and a shadow.
    const img = await fabric.FabricImage.fromURL(makeTestImage(800, 600));
    img.set({ cropX: 200, cropY: 150, width: 400, height: 300, left: 300, top: 250, originX: 'center', originY: 'center' });
    img.clipPath = new fabric.Circle({ radius: 140, originX: 'center', originY: 'center', left: 0, top: 0 });
    img.shadow = new fabric.Shadow({ color: 'rgba(0,0,0,0.6)', blur: 20, offsetX: 10, offsetY: 10 });
    // Styled, wrapping, editable text with an outline and a per-range style.
    const text = new fabric.Textbox('Hello styled world, this line is long enough that it must wrap', {
      width: 500, fontSize: 48, fontFamily: 'Arial', fill: '#ffffff', stroke: '#000000', strokeWidth: 3,
      paintFirst: 'stroke', left: 900, top: 300, originX: 'center', originY: 'center', lineHeight: 1.1, charSpacing: 20,
    });
    text.setSelectionStyles({ fontWeight: 'bold', fill: '#ffd60a' }, 6, 12);
    // A rotated group.
    const group = new fabric.Group([
      new fabric.Rect({ width: 120, height: 80, fill: '#f1faee', left: 0, top: 0 }),
      new fabric.Circle({ radius: 40, fill: '#e63946', left: 100, top: 30 }),
    ], { left: 640, top: 600, angle: 15 });
    canvas.add(img, text, group);
    canvas.renderAll();
    window.text = text; window.img = img;
    out.croppedImage = { cropX: img.cropX, cropY: img.cropY, w: img.width, h: img.height };
    out.clipPath = !!img.clipPath;
    out.shadow = !!img.shadow;
    out.group = { children: group.getObjects().length, angle: group.angle };
    out.perRangeStyles = Object.keys(text.styles).length > 0;
    out.linesBeforeEdit = text.textLines.slice();
    // Start a real editing session; keystrokes come from the test driver.
    canvas.setActiveObject(text);
    text.enterEditing();
    text.setSelectionStart(text.text.length); text.setSelectionEnd(text.text.length);
    out.isEditing = text.isEditing;
    return out;
  }));
  await page.keyboard.type(' OK!');
  Object.assign(r, await page.evaluate(async () => {
    const out = {};
    text.exitEditing();
    canvas.discardActiveObject(); canvas.renderAll();
    out.textAfterTyping = text.text;
    out.linesAfterEdit = text.textLines.slice();
    // Backing store vs logical size at DPR 2.
    out.editorBackingStore = [canvas.lowerCanvasEl.width, canvas.lowerCanvasEl.height];
    // Export A: straight from the interactive canvas.
    const t0 = performance.now();
    const a = canvas.toCanvasElement(3);
    out.exportFromEditor = { size: [a.width, a.height], ms: Math.round(performance.now() - t0), hash: await hashCanvas(a) };
    // Does editor zoom leak into export?
    canvas.setZoom(0.37);
    const z = canvas.toCanvasElement(3);
    out.exportWhileZoomed = { size: [z.width, z.height], sameAsUnzoomed: (await hashCanvas(z)) === out.exportFromEditor.hash };
    canvas.setZoom(1);
    // Save / reopen through the library's own JSON.
    const json = canvas.toJSON();
    out.jsonBytes = JSON.stringify(json).length;
    out.jsonEmbedsImageAsDataUrl = JSON.stringify(json).includes('data:image/png');
    const el2 = document.createElement('canvas'); document.body.appendChild(el2);
    const c2 = new fabric.StaticCanvas(el2, { width: 1280, height: 720, enableRetinaScaling: false });
    await c2.loadFromJSON(json); c2.renderAll();
    const b = c2.toCanvasElement(3);
    out.reopenedExport = { size: [b.width, b.height], identicalPixels: (await hashCanvas(b)) === out.exportFromEditor.hash };
    const text2 = c2.getObjects().find(o => o.type === 'textbox');
    out.linesAfterReopen = text2.textLines.slice();
    out.linesStable = JSON.stringify(out.linesAfterReopen) === JSON.stringify(out.linesAfterEdit);
    // Clip check: a corner of the image frame must show the background (clipped by the circle),
    // the centre must show the image.
    out.cornerPixel = pixelAt(a, (300 - 195) * 3, (250 - 145) * 3);
    out.centrePixelOpaque = pixelAt(a, 300 * 3, 250 * 3)[3] === 255;
    return out;
  }));
  report.fabric = r;
  await page.close();
}

// ---------------------------------------------------------------- Konva
{
  const page = await context.newPage();
  await page.setContent('<body style="margin:0;background:#333"><div id="c"></div></body>');
  await page.addScriptTag({ content: helpers });
  await page.addScriptTag({ path: KONVA });
  const r = await page.evaluate(async () => {
    const out = {};
    out.version = Konva.version;
    out.dpr = window.devicePixelRatio;
    const build = async (container) => {
      const stage = new Konva.Stage({ container, width: 1280, height: 720 });
      const layer = new Konva.Layer(); stage.add(layer);
      layer.add(new Konva.Rect({ width: 1280, height: 720, fill: '#1d3557' }));
      const el = new Image(); el.src = makeTestImage(800, 600); await el.decode();
      // Clipping only exists on containers, so the image goes inside a clipped group.
      const clip = new Konva.Group({ x: 300, y: 250, clipFunc: (ctx) => ctx.arc(0, 0, 140, 0, Math.PI * 2) });
      const img = new Konva.Image({ image: el, x: -200, y: -150, width: 400, height: 300,
        crop: { x: 200, y: 150, width: 400, height: 300 },
        shadowColor: 'black', shadowBlur: 20, shadowOffset: { x: 10, y: 10 }, shadowOpacity: 0.6 });
      clip.add(img); layer.add(clip);
      const text = new Konva.Text({ text: 'Hello styled world, this line is long enough that it must wrap',
        x: 650, y: 220, width: 500, fontSize: 48, fontFamily: 'Arial', fill: '#ffffff', stroke: '#000000',
        strokeWidth: 3, fillAfterStrokeEnabled: true, lineHeight: 1.1, letterSpacing: 1 });
      layer.add(text);
      const group = new Konva.Group({ x: 640, y: 600, rotation: 15 });
      group.add(new Konva.Rect({ width: 120, height: 80, fill: '#f1faee' }));
      group.add(new Konva.Circle({ x: 140, y: 70, radius: 40, fill: '#e63946' }));
      layer.add(group);
      layer.draw();
      return { stage, layer, text, img, group };
    };
    const { stage, text, img, group } = await build('c');
    out.croppedImage = img.crop();
    out.clipPath = 'containers only (Group clipFunc)';
    out.shadow = img.shadowBlur() > 0;
    out.group = { children: group.getChildren().length, angle: group.rotation() };
    out.perRangeStyles = false; // Konva.Text has one style for the whole node
    out.builtInTextEditing = typeof text.enterEditing === 'function'; // no on-canvas editing API
    out.lines = text.textArr.map(l => l.text);
    const t0 = performance.now();
    const a = stage.toCanvas({ pixelRatio: 3 });
    out.exportFromEditor = { size: [a.width, a.height], ms: Math.round(performance.now() - t0), hash: await hashCanvas(a) };
    stage.scale({ x: 0.37, y: 0.37 });
    const z = stage.toCanvas({ pixelRatio: 3 });
    out.exportWhileZoomed = { size: [z.width, z.height], sameAsUnzoomed: (await hashCanvas(z)) === out.exportFromEditor.hash };
    stage.scale({ x: 1, y: 1 });
    const json = stage.toJSON();
    out.jsonBytes = json.length;
    out.jsonContainsImageData = json.includes('data:image/png');
    out.jsonContainsClipFunc = json.includes('clipFunc');
    const div = document.createElement('div'); document.body.appendChild(div);
    const stage2 = Konva.Node.create(json, div);
    stage2.draw();
    const b = stage2.toCanvas({ pixelRatio: 3 });
    out.reopenedExport = { size: [b.width, b.height], identicalPixels: (await hashCanvas(b)) === out.exportFromEditor.hash };
    const text2 = stage2.findOne('Text');
    out.linesStable = JSON.stringify(text2.textArr.map(l => l.text)) === JSON.stringify(out.lines);
    return out;
  });
  report.konva = r;
  await page.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
