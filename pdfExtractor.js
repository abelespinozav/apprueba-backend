const { createCanvas } = require('canvas');

async function extraerTextoPDF(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array, useSystemFonts: true });
  const pdf = await loadingTask.promise;

  let todasLasLineas = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const itemsPorLinea = {};
    for (const item of textContent.items) {
      const y = Math.round(item.transform[5]);
      const x = Math.round(item.transform[4]);
      if (!itemsPorLinea[y]) itemsPorLinea[y] = [];
      itemsPorLinea[y].push({ x, texto: item.str });
    }
    const ysOrdenados = Object.keys(itemsPorLinea).map(Number).sort((a, b) => b - a);
    for (const y of ysOrdenados) {
      const items = itemsPorLinea[y].sort((a, b) => a.x - b.x);
      const linea = items.map(i => i.texto).join('  ');
      if (linea.trim()) todasLasLineas.push(linea);
    }
  }
  return todasLasLineas.join('\n');
}

async function pdfAImagenes(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array, useSystemFonts: true });
  const pdf = await loadingTask.promise;

  const imagenes = [];
  const SCALE = 2.0; // alta resolución

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    // Fondo blanco
    context.fillStyle = 'white';
    context.fillRect(0, 0, viewport.width, viewport.height);

    await page.render({ canvasContext: context, viewport }).promise;

    const base64 = canvas.toDataURL('image/png').split(',')[1];
    imagenes.push(base64);
  }

  return imagenes;
}

module.exports = { extraerTextoPDF, pdfAImagenes };
