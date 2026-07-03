import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cpuModel() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return "Unknown CPU";
  return `${cpus[0].model} (${cpus.length} cores)`;
}

function totalRamGb() {
  return Math.round(os.totalmem() / 1024 / 1024 / 1024);
}

function platformName() {
  const p = os.platform();
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}

async function detectGpu() {
  const platform = os.platform();
  try {
    if (platform === "linux" || platform === "win32") {
      const { stdout } = await execFileAsync("nvidia-smi", [
        "--query-gpu=name",
        "--format=csv,noheader",
      ]);
      const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0];
      if (line) return line;
    } else if (platform === "darwin") {
      const { stdout } = await execFileAsync("system_profiler", ["SPDisplaysDataType"]);
      const match = stdout.match(/Chipset Model:\s*(.+)/);
      if (match) return match[1].trim();
    }
  } catch {
    // nvidia-smi / system_profiler not available or no discrete GPU — this is
    // expected on many machines, not an error. We report honestly instead of
    // guessing.
  }
  return null;
}

export async function collectHardwareReport() {
  const gpu = await detectGpu();
  return {
    os: platformName(),
    cpu: cpuModel(),
    ramGb: totalRamGb(),
    gpu,
  };
}
