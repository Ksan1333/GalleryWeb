// Preserve and verify distributables before cargo clean. Never overwrite a release.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
const destination = join(root, "release", version);
const target = join(root, "src-tauri", "target");
const installer = `PixVault for Windows_${version}_x64-setup.exe`;
const entries = [
  [join(target, "release/bundle/nsis", installer), installer],
  [join(target, "release/bundle/nsis/release-manifest.json"), "release-manifest.json"],
  [join(target, "release/galleryweb.exe"), "native/galleryweb.exe"],
  [join(target, "release/galleryweb.pdb"), "native/galleryweb.pdb"],
  [join(target, "release/DirectML.dll"), "native/DirectML.dll"],
  [join(target, "libvlc/vlc-3.0.23"), "native/vlc"],
  [join(target, "libvlc/vlc-3.0.23.tar.xz"), "vlc-3.0.23.tar.xz"],
  [join(root, "src-tauri/resources/THIRD_PARTY_NOTICES.txt"), "native/resources/THIRD_PARTY_NOTICES.txt"],
  [join(root, "src-tauri/resources/THIRD_PARTY_AI_NOTICES.txt"), "native/resources/THIRD_PARTY_AI_NOTICES.txt"],
];
async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function files(path) {
  if (!(await stat(path)).isDirectory()) return [path];
  const children = await readdir(path);
  return (await Promise.all(children.map(child => files(join(path, child))))).flat();
}
// Check every input before creating an immutable version directory.
for (const [source] of entries) await stat(source);
await mkdir(destination); // EEXIST is intentional, including partially copied releases.
const checksums = [];
for (const [source, suffix] of entries) {
  const output = join(destination, suffix);
  await mkdir(resolve(output, ".."), { recursive: true });
  await cp(source, output, { recursive: true, errorOnExist: true, force: false });
  const isDirectory = (await stat(source)).isDirectory();
  for (const path of await files(source)) {
    const copy = isDirectory ? join(output, relative(source, path)) : output;
    const before = await hash(path), after = await hash(copy);
    if (before !== after) throw new Error(`Copy verification failed: ${copy}`);
    checksums.push(`${after}  ${relative(destination, copy).replaceAll("\\", "/")}`);
  }
}
await writeFile(join(destination, "SHA256SUMS"), checksums.sort().join("\n") + "\n", { flag: "wx" });
const published = [installer, "release-manifest.json", "vlc-3.0.23.tar.xz", "SHA256SUMS"];
const github = [];
for (const name of published) github.push(`${await hash(join(destination, name))}  ${name.replaceAll(" ", ".")}`);
await writeFile(join(destination, "SHA256SUMS.github"), github.join("\n") + "\n", { flag: "wx" });
console.log(`Preserved and SHA-256 verified ${checksums.length} files: ${destination}`);
