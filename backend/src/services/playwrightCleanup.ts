import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function parsePids(stdout: string): number[] {
  return String(stdout || '')
    .split(/\s+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * 仅清理 Playwright 缓存目录下的 Chromium，避免误杀本机日常 Chrome。
 */
export async function killOrphanPlaywrightChromium(): Promise<{
  killed: number;
  pids: number[];
  errors: string[];
}> {
  const errors: string[] = [];
  const pids = new Set<number>();

  const patterns = [
    'ms-playwright',
    'ms-playwright-old',
    'chrome-mac/Chromium',
    'chrome-linux/chrome',
    'chrome-linux64/chrome',
    'headless_shell',
  ];

  for (const pattern of patterns) {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', pattern], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      for (const pid of parsePids(stdout)) pids.add(pid);
    } catch (e: any) {
      // pgrep 无匹配时退出码为 1
      if (e?.code !== 1) {
        errors.push(`pgrep ${pattern}: ${e?.message || e}`);
      }
    }
  }

  // 排除当前 Node 后端自身
  pids.delete(process.pid);
  if (typeof process.ppid === 'number') pids.delete(process.ppid);

  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch (e: any) {
      errors.push(`SIGTERM ${pid}: ${e?.message || e}`);
    }
  }

  if (killed.length > 0) {
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of killed) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }
  }

  return { killed: killed.length, pids: killed, errors };
}
