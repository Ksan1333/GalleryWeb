import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(projectRoot, path), "utf8");
const configPath = resolve(projectRoot, "src-tauri", "tauri.conf.json");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const associations = config.bundle?.fileAssociations ?? [];
const installerHooksPath = config.bundle?.windows?.nsis?.installerHooks;
const installerHooks = typeof installerHooksPath === "string"
  ? read(`src-tauri/${installerHooksPath.replaceAll("\\", "/")}`)
  : "";

const expectedGroups = new Map([
  ["PixVault.Image", {
    description: "PixVault image",
    extensions: ["jpg", "jpeg", "png", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"],
  }],
  ["PixVault.GIF", {
    description: "PixVault GIF image",
    extensions: ["gif"],
  }],
  ["PixVault.Video", {
    description: "PixVault video",
    extensions: ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "mpeg", "mpg", "ts", "m2ts"],
  }],
  ["PixVault.BookArchive", {
    description: "PixVault ZIP or CBZ book",
    extensions: ["zip", "cbz"],
  }],
  ["PixVault.PDF", {
    description: "PixVault PDF book",
    extensions: ["pdf"],
  }],
]);

const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));

function classifiedExtensions() {
  const source = read("src-tauri/src/catalog.rs");
  const start = source.indexOf("pub(crate) fn classify_media");
  const kindStart = source.indexOf("let kind = match extension.as_str()", start);
  const mimeStart = source.indexOf("let mime_type =", kindStart);
  assert.ok(start >= 0 && kindStart >= 0 && mimeStart > kindStart, "catalog classifier was not found");

  const kindMatch = source.slice(kindStart, mimeStart);
  const extensions = [];
  const armPattern = /"[a-z0-9]+"(?:\s*\|\s*"[a-z0-9]+")*\s*=>/g;
  for (const arm of kindMatch.matchAll(armPattern)) {
    for (const quoted of arm[0].matchAll(/"([a-z0-9]+)"/g)) extensions.push(quoted[1]);
  }
  assert.ok(extensions.length > 0, "catalog classifier did not expose any extensions");
  return extensions;
}

function generatedNsisPaths() {
  const explicit = process.env.PIXVAULT_NSIS_SCRIPT;
  if (explicit) {
    const scriptPath = resolve(projectRoot, explicit);
    return {
      scriptPath,
      helperPath: resolve(dirname(scriptPath), "FileAssociation.nsh"),
    };
  }

  for (const architecture of ["x64", "x86", "arm64"]) {
    const directory = resolve(projectRoot, "src-tauri", "target", "release", "nsis", architecture);
    const scriptPath = resolve(directory, "installer.nsi");
    if (existsSync(scriptPath)) {
      return { scriptPath, helperPath: resolve(directory, "FileAssociation.nsh") };
    }
  }
  return null;
}

test("Tauri file associations use the intended Windows viewer classes", () => {
  assert.equal(config.bundle?.targets, "nsis");
  assert.equal(associations.length, expectedGroups.size);

  const actualNames = new Set();
  const actualExtensions = [];
  for (const association of associations) {
    assert.equal(typeof association.name, "string");
    assert.ok(!actualNames.has(association.name), `duplicate file class: ${association.name}`);
    actualNames.add(association.name);

    const expected = expectedGroups.get(association.name);
    assert.ok(expected, `unexpected file class: ${association.name}`);
    assert.equal(association.description, expected.description);
    assert.equal(association.role, "Viewer");
    assert.deepEqual(association.ext, expected.extensions);
    for (const extension of association.ext) {
      assert.match(extension, /^[a-z0-9]+$/, `invalid extension: ${extension}`);
      assert.ok(!actualExtensions.includes(extension), `duplicate extension: ${extension}`);
      actualExtensions.push(extension);
    }
  }

  assert.deepEqual(sorted(actualExtensions), sorted(classifiedExtensions()));
});

test("file association fields are accepted by the installed Tauri 2 schema", () => {
  const schema = JSON.parse(read("node_modules/@tauri-apps/cli/config.schema.json"));
  const bundleProperty = schema.definitions?.BundleConfig?.properties?.fileAssociations;
  const associationDefinition = schema.definitions?.FileAssociation;

  assert.ok(bundleProperty?.type?.includes("array"));
  assert.equal(bundleProperty.items?.$ref, "#/definitions/FileAssociation");
  assert.ok(associationDefinition?.required?.includes("ext"));
  assert.equal(associationDefinition?.additionalProperties, false);

  for (const association of associations) {
    for (const key of Object.keys(association)) {
      assert.ok(associationDefinition.properties?.[key], `unsupported Tauri association field: ${key}`);
    }
  }
});

test("installer hooks register a Windows Open With candidate and quote both paths", () => {
  assert.equal(installerHooksPath, "windows/installer-hooks.nsh");
  assert.ok(installerHooks.includes("!macro NSIS_HOOK_PREINSTALL"));
  assert.ok(installerHooks.includes("!macro NSIS_HOOK_POSTINSTALL"));
  assert.ok(installerHooks.includes("!macro NSIS_HOOK_POSTUNINSTALL"));
  assert.ok(installerHooks.includes('"Software\\RegisteredApplications" "PixVault for Windows"'));
  assert.ok(installerHooks.includes('"Software\\PixVault\\Capabilities\\FileAssociations"'));
  assert.ok(installerHooks.includes('"Software\\Classes\\.${EXT}\\OpenWithProgids"'));
  assert.ok(installerHooks.includes('$\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\" $\\"%1$\\"'));

  const configured = associations.flatMap((association) =>
    association.ext.map((extension) => [extension, association.name]));
  const backupCalls = [...installerHooks.matchAll(
    /!insertmacro PIXVAULT_BACKUP_FILE_TYPE "([a-z0-9]+)" "([^"]+)"/g,
  )].map((match) => [match[1], match[2]]);
  const registerCalls = [...installerHooks.matchAll(
    /!insertmacro PIXVAULT_REGISTER_FILE_TYPE "([a-z0-9]+)" "([^"]+)"/g,
  )].map((match) => [match[1], match[2]]);
  const unregisterCalls = [...installerHooks.matchAll(
    /!insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "([a-z0-9]+)" "([^"]+)"/g,
  )].map((match) => [match[1], match[2]]);
  assert.deepEqual(backupCalls, configured);
  assert.deepEqual(registerCalls, configured);
  assert.deepEqual(unregisterCalls, configured);
  assert.equal((installerHooks.match(/!insertmacro PIXVAULT_QUOTE_OPEN_COMMAND/g) ?? []).length,
    expectedGroups.size);
  assert.equal((installerHooks.match(/!insertmacro UPDATEFILEASSOC/g) ?? []).length, 2);
  assert.ok(installerHooks.includes('"${PROGID}_backup" "$R8"'));
  assert.ok(installerHooks.includes('".${EXT}.captured" "1"'),
    "an explicit sentinel must preserve an originally empty default across updates");
  assert.ok(installerHooks.includes('DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.${EXT}" ""'),
    "an originally empty default must be restored after Tauri APP_ASSOCIATE runs");
  assert.ok(installerHooks.includes('WriteRegStr SHELL_CONTEXT "Software\\Classes\\.${EXT}" "" "$R8"'),
    "a previous non-empty default must be restored after Tauri APP_ASSOCIATE runs");
  assert.ok(installerHooks.includes('DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.${EXT}" "${PROGID}_backup"'),
    "an empty original default must not become a stale PixVault backup on repair installs");
  assert.ok(installerHooks.includes('DeleteRegKey SHELL_CONTEXT "Software\\PixVault\\AssociationBackups"'));
});

const requireGenerated = process.env.PIXVAULT_REQUIRE_GENERATED_NSIS === "1";
const generatedCandidate = generatedNsisPaths();
const generated = generatedCandidate
  && (requireGenerated || statSync(generatedCandidate.scriptPath).mtimeMs >= statSync(configPath).mtimeMs)
  ? generatedCandidate
  : null;

test("generated NSIS installs and removes every configured association", {
  skip: !generated && !requireGenerated,
}, () => {
  assert.ok(generated, "generated installer.nsi was not found; build the NSIS installer first");
  assert.ok(existsSync(generated.scriptPath), `missing generated NSIS script: ${generated.scriptPath}`);
  assert.ok(existsSync(generated.helperPath), `missing generated NSIS helper: ${generated.helperPath}`);

  const installer = readFileSync(generated.scriptPath, "utf8");
  const helper = readFileSync(generated.helperPath, "utf8");
  const installLines = installer.split(/\r?\n/).filter((line) => line.includes("!insertmacro APP_ASSOCIATE \""));
  const uninstallLines = installer.split(/\r?\n/).filter((line) => line.includes("!insertmacro APP_UNASSOCIATE \""));
  const extensionCount = associations.reduce((count, association) => count + association.ext.length, 0);

  assert.equal(installLines.length, extensionCount);
  assert.equal(uninstallLines.length, extensionCount);
  for (const association of associations) {
    for (const extension of association.ext) {
      const installPrefix = `!insertmacro APP_ASSOCIATE "${extension}" "${association.name}" "${association.description}"`;
      const uninstallMacro = `!insertmacro APP_UNASSOCIATE "${extension}" "${association.name}"`;
      const installLine = installLines.find((line) => line.includes(installPrefix));
      assert.ok(installLine, `missing NSIS install association for .${extension}`);
      assert.ok(installLine.includes("$INSTDIR\\${MAINBINARYNAME}.exe $\\\"%1$\\\""), `.${extension} does not forward the quoted file path`);
      assert.ok(uninstallLines.some((line) => line.includes(uninstallMacro)), `missing NSIS uninstall association for .${extension}`);
    }
  }

  assert.ok(helper.includes('WriteRegStr SHELL_CONTEXT "Software\\Classes\\.${EXT}" "" "${FILECLASS}"'));
  assert.ok(helper.includes('WriteRegStr SHELL_CONTEXT "Software\\Classes\\${FILECLASS}\\shell\\open\\command"'));
  assert.ok(helper.includes('WriteRegStr SHELL_CONTEXT "Software\\Classes\\.${EXT}" "${FILECLASS}_backup"'));
  assert.ok(helper.includes("!macro APP_UNASSOCIATE EXT FILECLASS"));
  assert.ok(installer.includes("installer-hooks.nsh"), "generated NSIS does not include the hardened association hooks");
  const preinstallHook = installer.indexOf("!insertmacro NSIS_HOOK_PREINSTALL");
  const firstAssociation = installer.indexOf('!insertmacro APP_ASSOCIATE "');
  const postinstallHook = installer.indexOf("!insertmacro NSIS_HOOK_POSTINSTALL");
  assert.ok(preinstallHook >= 0 && firstAssociation > preinstallHook,
    "the original default must be captured before Tauri associations are written");
  assert.ok(postinstallHook > firstAssociation,
    "the original default must be restored after Tauri associations are written");
});
