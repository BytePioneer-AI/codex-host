import { crc32, deflateRawSync } from "node:zlib";

type File = { name: string; data?: string | Buffer; deflate?: boolean; mode?: number };

export function makeZip(files: File[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data = "", deflate, mode } of files) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(typeof data === "string" ? Buffer.from(data) : data);
    const compressed = deflate ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 28);
    if (mode !== undefined) central.writeUInt32LE(mode * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function extensionZip({
  id = "sample",
  version = "1.0.0",
  wrapper = "",
  extras = [],
  manifest = {},
}: {
  id?: string;
  version?: string;
  wrapper?: string;
  extras?: File[];
  manifest?: Record<string, unknown>;
} = {}) {
  return makeZip([
    ...(wrapper ? [{ name: `${wrapper}/`, mode: 0x4000 }] : []),
    {
      name: `${wrapper ? `${wrapper}/` : ""}manifest.json`,
      data: JSON.stringify({
        manifestVersion: 1,
        desktopApi: 1,
        id,
        name: { en: "Example", "zh-CN": "示例" },
        description: { en: "An example", "zh-CN": "示例描述" },
        author: "codexhost",
        version,
        slots: [],
        desktop: { script: "desktop.js" },
        ...manifest,
      }),
    },
    {
      name: `${wrapper ? `${wrapper}/` : ""}desktop.js`,
      data: 'define({activate(){ throw new Error("Must not run during installation"); }});',
      deflate: true,
    },
    ...extras,
  ]);
}
