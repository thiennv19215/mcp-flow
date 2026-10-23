import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeExtensionBuildRevision } from "./extension-build-revision.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const extensionSourceRoot = resolve(repoRoot, "extension");
export const extensionCodeRoot = resolve(extensionSourceRoot, "src");
export const extensionPackageRoot = resolve(repoRoot, "dist", "extension");

function assertInside(parent, target, label) {
  const rel = relative(resolve(parent), resolve(target));
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || resolve(rel) === resolve(target)) {
    throw new Error(`${label} must be a child of ${parent}.`);
  }
}

async function copyOptionalDirectory(source, destination) {
  try {
    const info = await lstat(source);
    if (info.isDirectory()) await cp(source, destination, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function copyCapabilitiesFile(stageRoot, fileName) {
  const candidates = [
    resolve(repoRoot, fileName),
    resolve(extensionSourceRoot, fileName),
  ];
  for (const candidate of candidates) {
    try {
      await cp(candidate, resolve(stageRoot, fileName));
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function copyCapabilities(stageRoot) {
  await copyCapabilitiesFile(stageRoot, "flow-model-capabilities.json");
  await copyCapabilitiesFile(stageRoot, "chatgpt-model-capabilities.json");
}

function manifestFileReferences(manifest) {
  const references = [];
  const add = value => {
    if (typeof value === "string" && value && !value.includes("://")) references.push(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.options_page);
  add(manifest.side_panel?.default_path);
  for (const iconPath of Object.values(manifest.icons || {})) add(iconPath);
  for (const iconPath of Object.values(manifest.action?.default_icon || {})) add(iconPath);
  for (const rules of manifest.declarative_net_request?.rule_resources || []) add(rules.path);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const resourceSet of manifest.web_accessible_resources || []) {
    for (const resource of resourceSet.resources || []) add(resource);
  }
  return [...new Set(references)];
}

async function assertManifestFilesPresent(packageRoot, manifest) {
  const missing = [];
  for (const path of manifestFileReferences(manifest)) {
    try {
      await lstat(resolve(packageRoot, path));
    } catch {
      missing.push(path);
    }
  }
  if (missing.length) {
    throw new Error(`Extension package is missing manifest files: ${missing.join(", ")}`);
  }
}

async function preparePackage(stageRoot) {
  const manifestPath = resolve(extensionSourceRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = await readdir(extensionCodeRoot, { withFileTypes: true });

  await cp(manifestPath, resolve(stageRoot, "manifest.json"));
  for (const entry of entries) {
    const sourcePath = resolve(extensionCodeRoot, entry.name);
    const destinationPath = resolve(stageRoot, entry.name);
    await cp(sourcePath, destinationPath, { recursive: entry.isDirectory() });
  }

  await Promise.all([
    copyOptionalDirectory(resolve(extensionSourceRoot, "icons"), resolve(stageRoot, "icons")),
    copyOptionalDirectory(resolve(extensionSourceRoot, "rules"), resolve(stageRoot, "rules")),
    copyCapabilities(stageRoot),
  ]);
  return manifest;
}

export async function buildExtension() {
  const distRoot = resolve(repoRoot, "dist");
  const manifestPath = resolve(extensionSourceRoot, "manifest.json");
  const sourceStat = await lstat(extensionCodeRoot).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error(`Extension source directory not found: ${extensionCodeRoot}`);
  await lstat(manifestPath);
  await mkdir(distRoot, { recursive: true });
  assertInside(distRoot, extensionPackageRoot, "Extension package directory");

  const stageRoot = await mkdtemp(join(distRoot, ".extension-stage-"));
  const backupRoot = `${extensionPackageRoot}.backup-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  let packageCommitted = false;
  try {
    const manifest = await preparePackage(stageRoot);
    const revision = await writeExtensionBuildRevision(stageRoot);
    await assertManifestFilesPresent(stageRoot, manifest);
    try {
      await rename(extensionPackageRoot, backupRoot);
      previousMoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stageRoot, extensionPackageRoot);
    packageCommitted = true;
    if (previousMoved) await rm(backupRoot, { recursive: true, force: true });
    return { packageRoot: extensionPackageRoot, revision };
  } catch (error) {
    if (previousMoved && !packageCommitted) {
      await rename(backupRoot, extensionPackageRoot).catch(() => {});
    }
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    if (packageCommitted && previousMoved) await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildExtension();
  console.log(`Built Chrome extension: ${result.packageRoot}`);
  console.log(`Build revision: ${result.revision}`);
}
