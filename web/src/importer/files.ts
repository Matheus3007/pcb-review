// Turning a drop / file picker / zip into a FileMap (path -> Blob). Nothing leaves the browser.
import { unzip } from "fflate";
import type { FileMap } from "./importer";

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";

async function addZip(map: FileMap, file: File, prefix = "") {
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((res, rej) =>
    // only what the importer reads: renders and gerbers can be large
    unzip(data, { filter: (f) => /\.(kicad_pcb|json|csv|md|yaml)$/i.test(f.name) }, (err, out) => (err ? rej(err) : res(out))));
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.endsWith("/")) map.set(prefix + path, new Blob([bytes as BlobPart]));
  }
}

/** <input type=file> (multiple, webkitdirectory, or a single .zip) */
export async function fromFileList(list: FileList | File[]): Promise<FileMap> {
  const map: FileMap = new Map();
  for (const f of Array.from(list)) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (isZip(f)) await addZip(map, f, path.replace(/[^/]*$/, ""));
    else map.set(path, f);
  }
  return map;
}

/** Drag-and-drop: folders are walked (FileSystemEntry API), zips expanded. */
export async function fromDataTransfer(dt: DataTransfer): Promise<FileMap> {
  const map: FileMap = new Map();
  const entries = Array.from(dt.items)
    .map((it) => (it.kind === "file" ? it.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return fromFileList(dt.files);
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const readAll = async (dir: FileSystemDirectoryEntry) => {
    const reader = dir.createReader();
    const out: FileSystemEntry[] = [];
    for (;;) {
      // readEntries returns batches (100 in Chrome) until it returns an empty one
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) return out;
      out.push(...batch);
    }
  };
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const f = await fileOf(e as FileSystemFileEntry);
      if (isZip(f)) await addZip(map, f, prefix);
      else map.set(prefix + e.name, f);
    } else if (e.isDirectory) {
      if (/^(\.git|node_modules|\.venv|__pycache__)$/.test(e.name)) return;
      for (const c of await readAll(e as FileSystemDirectoryEntry)) await walk(c, `${prefix}${e.name}/`);
    }
  };
  for (const e of entries) await walk(e, "");
  return map;
}
