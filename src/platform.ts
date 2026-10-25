import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// Everything that differs between macOS, Windows and Linux lives here, so the rest of the code stays the same on all
// three. macOS is the tested platform; the Windows and Linux branches are written to each system's own documented
// tools but have not been run on a real machine yet.
export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

// How the panel names this computer and its bin, so nothing says "Mac" on a PC.
export const COMPUTER = IS_MAC ? "this Mac" : IS_WIN ? "this PC" : "this computer";
export const BIN = IS_MAC ? "the Mac's Trash" : IS_WIN ? "the Recycle Bin" : "the Trash";

export const FFMPEG_HINT = IS_MAC ? "brew install ffmpeg" : IS_WIN ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

// PowerShell single-quoted string: the only character that needs escaping is the quote itself.
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function powershell(script: string, timeout = 120_000): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

// Puts a file or folder in the system's own bin so it can be restored: the Mac's Trash, Windows' Recycle Bin, or the
// freedesktop Trash on Linux. Never deletes anything outright.
export function moveToBin(target: string): string {
  if (IS_MAC) {
    const bin = join(homedir(), ".Trash");
    const name = basename(target);
    const ext = extname(name);
    const dest = existsSync(join(bin, name)) ? join(bin, `${name.slice(0, name.length - ext.length)}-${Date.now()}${ext}`) : join(bin, name);
    renameSync(target, dest);
    return dest;
  }
  if (IS_WIN) {
    const kind = statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
    powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    );
    return BIN;
  }
  try {
    execFileSync("gio", ["trash", target], { stdio: "ignore" });
    return BIN;
  } catch {
    const bin = join(homedir(), ".local", "share", "Trash", "files");
    mkdirSync(bin, { recursive: true });
    const dest = join(bin, `${basename(target)}-${Date.now()}`);
    renameSync(target, dest);
    return dest;
  }
}

// Unpacks a ZIP with the system's own tools: tar on macOS and Windows 10+ is bsdtar, which reads ZIPs; unzip is the
// fallback (Linux, older Windows). Returns every file inside, however deeply the archive nested them.
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    // bsdtar can reject an archive containing a symlink on Windows. List
    // those entries first, then retry while excluding only the links; this
    // preserves ordinary media instead of falling through to a Unix-only
    // `unzip` binary that may not exist on Windows.
    let symlinkNames: string[] = [];
    try {
      const listing = execFileSync("tar", ["-tvf", zip], { encoding: "utf8" });
      symlinkNames = listing.split(/\r?\n/).flatMap((line) => {
        const arrow = line.indexOf(" -> ");
        if (arrow < 0 || !/^\s*l/.test(line)) return [];
        const name = line.slice(0, arrow).trim().split(/\s+/).pop();
        return name ? [name] : [];
      });
    } catch {
      // If the archive cannot be listed, let the normal unzip fallback report
      // the original extraction failure.
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    try {
      execFileSync("tar", ["-xf", zip, "-C", dest, ...symlinkNames.flatMap((name) => ["--exclude", name])], { stdio: "ignore" });
    } catch {
      // tar may be unavailable or unable to read this ZIP; use unzip as the
      // portable fallback on systems that provide it.
      execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
    }
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      // lstat, not stat: a symlink entry in the archive must not be followed
      // (its target could be anywhere on disk) nor handed back as a "take".
      const info = lstatSync(p);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(p);
      else if (info.isFile()) files.push(p);
    }
  };
  walk(dest);
  return files;
}

