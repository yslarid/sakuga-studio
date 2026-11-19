// Register caption faces when the text tools, a captioned project or a cover
// first needs them. CSS selects glyph subsets and the editor can draw offline.
const uiFace = 'Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;1,800';
const captionFaces = [
  'Anton', 'Bebas Neue', 'Cinzel:wght@700', 'DM Serif Display:ital@0;1',
  'Noto Sans JP:wght@900', 'Permanent Marker', 'Poppins:wght@600;700',
  'Oswald:wght@300;700', 'Bodoni Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..900',
  'UnifrakturMaguntia', 'Jost:wght@500;800', 'Playfair Display:ital,wght@0,700;1,700',
  'Cormorant SC:wght@700', 'Caveat:wght@700', 'Montserrat:wght@600;700',
];

function addStyles(families) {
  const url = new URL('https://fonts.googleapis.com/css2');
  for (const family of families) url.searchParams.append('family', family);
  url.searchParams.set('display', 'swap');
  return new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url.href;
    link.onload = () => resolve(true);
    link.onerror = () => resolve(false);
    document.head.append(link);
  });
}

export function loadUiFont() {
  return addStyles([uiFace]);
}

let captions;
export function loadCaptionStyles() {
  if (!captions) {
    captions = addStyles(captionFaces).then(loaded => {
      if (loaded) document.dispatchEvent(new Event('captionstylesready'));
      return loaded;
    });
  }
  return captions;
}
