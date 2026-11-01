// 从 .cwplugin（本质是 zip）里读出 cwplugin.json，拿到插件 id 和版本。
// 这样不管是本地上传的包还是从广场导入的包，后台都能知道「这一包是哪个插件、什么版本」，
// 从而在设备已装该插件时提示「升级」而不是「安装」。

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function findEocd(bytes) {
  const min = Math.max(0, bytes.length - 66 * 1024);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (u32(bytes, i) === EOCD_SIG) return i;
  }
  return -1;
}

async function extractEntry(bytes, localOffset, method, compSize) {
  if (u32(bytes, localOffset) !== 0x04034b50) return null;
  const nameLen = u16(bytes, localOffset + 26);
  const extraLen = u16(bytes, localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + compSize);
  if (method === 0) return raw;
  if (method !== 8) return null;
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @returns {Promise<{id?:string, version?:string, name?:string, api_version?:string}|null>}
 */
export async function readPluginManifest(bytes) {
  try {
    const eocd = findEocd(bytes);
    if (eocd < 0) return null;
    const total = u16(bytes, eocd + 10);
    let off = u32(bytes, eocd + 16);
    for (let i = 0; i < total; i += 1) {
      if (u32(bytes, off) !== CEN_SIG) return null;
      const method = u16(bytes, off + 10);
      const compSize = u32(bytes, off + 20);
      const nameLen = u16(bytes, off + 28);
      const extraLen = u16(bytes, off + 30);
      const commentLen = u16(bytes, off + 32);
      const localOffset = u32(bytes, off + 42);
      const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
      if (/(^|\/)cwplugin\.json$/i.test(name)) {
        const data = await extractEntry(bytes, localOffset, method, compSize);
        if (!data) return null;
        const json = JSON.parse(new TextDecoder().decode(data));
        return {
          id: json.id ? String(json.id) : undefined,
          version: json.version ? String(json.version) : undefined,
          name: json.name ? String(json.name) : undefined,
          api_version: json.api_version ? String(json.api_version) : undefined,
        };
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  }
}
