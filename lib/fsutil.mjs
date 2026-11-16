// 原子写文件：随机临时文件名 + 排他创建（不跟随预先放好的软链接、不沿用旧文件的宽权限）+ 同一个文件描述符写入 + rename 替换。
import { randomBytes } from 'node:crypto';
import { closeSync, chmodSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(path, content, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // 已经没了
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 已经没了
    }
    throw err;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Windows 上忽略
  }
}
