export const NOTIFY_CHUNK_LIMIT = 500;

function packChunks(message: string, body: number, wordAware: boolean): string[] {
  const chunks: string[] = [];
  let rest = message;
  while (rest.length > body) {
    let cut = body;
    if (wordAware) {
      const window = rest.slice(0, body + 1);
      const brk = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
      if (brk >= Math.floor(body * 0.6)) cut = brk;
    }
    chunks.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export function splitForNotify(message: string, limit = NOTIFY_CHUNK_LIMIT): string[] {
  if (message.length <= limit) return [message];

  let parts = Math.ceil(message.length / limit);
  for (;;) {
    const reserve = `(${parts}/${parts}) `.length;
    const needed = Math.ceil(message.length / Math.max(1, limit - reserve));
    if (needed <= parts) break;
    parts = needed;
  }

  const body = Math.max(1, limit - `(${parts}/${parts}) `.length);
  let chunks = packChunks(message, body, true);
  if (chunks.length > parts) chunks = packChunks(message, body, false);

  const total = chunks.length;
  return chunks.map((chunk, i) => `(${i + 1}/${total}) ${chunk}`);
}
