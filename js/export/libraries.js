// These releases expose classic-script globals. Share each load across concurrent
// imports and exports, and allow the next operation to retry a failed request.
const pending = new Map();

function loadClassic(name, filename) {
  if (window[name]) return Promise.resolve(window[name]);
  if (!pending.has(name)) {
    const result = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../../vendor/' + filename, import.meta.url).href;
      script.onload = () => window[name] ? resolve(window[name]) : reject(new Error('Missing ' + name + ' in ' + filename));
      script.onerror = () => reject(new Error('Could not load ' + filename));
      document.head.append(script);
    }).catch(error => {
      pending.delete(name);
      throw error;
    });
    pending.set(name, result);
  }
  return pending.get(name);
}

export const loadMp4Box = () => loadClassic('MP4Box', 'mp4box.all.min.js');
export const loadMp4Muxer = () => loadClassic('Mp4Muxer', 'mp4-muxer.min.js');
