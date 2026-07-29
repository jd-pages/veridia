import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const source = path.join(projectRoot, "public", "favicon.svg");
const outputDir = path.join(projectRoot, "assets");
const output = path.join(outputDir, "veridia.ico");

await mkdir(outputDir, { recursive: true });
const svg = await readFile(source);
const png = await sharp(svg).resize(256, 256).png().toBuffer();

const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(0, 6);
header.writeUInt8(0, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);

await writeFile(output, Buffer.concat([header, png]));
console.log(output);
