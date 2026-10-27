'use strict';
/**
 * settings.json 备份（新增文件，零触碰架构基建）。
 * 职责：启动时滚动备份 settings.json（保留最近 5 份），存于 userData/settings-backups/。
 *
 * 重要教训（v1 撤回）：曾实现"凭证丢失自动找回"，但基线 clearCredential 是
 * `delete settings.tmdbCredential`（键整个移除），与竞态冲掉的形态无法区分——
 * 导致用户主动清除密钥后被备份复活（严重违背用户意图）。自动找回已彻底移除：
 * 用户清除语义神圣不可侵犯；备份仅供人工恢复（打开 settings-backups 目录复制）。
 */

const fs = require('node:fs');
const path = require('node:path');
const telemetry = require('./telemetry.cjs');

const BACKUP_KEEP = 5;

function listBackups(backupDir) {
  try {
    return fs.readdirSync(backupDir)
      .filter((name) => /^settings-.*\.json$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function backupSettings({ app, log = () => {} } = {}) {
  const result = { backedUp: false, backups: 0 };
  try {
    if (!app) return result;
    const dir = app.getPath('userData');
    const file = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'settings-backups');
    if (!fs.existsSync(file)) return result;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(backupDir, `settings-${stamp}.json`));
    result.backedUp = true;
    const files = listBackups(backupDir);
    result.backups = files.length;
    for (const stale of files.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(backupDir, stale)); } catch { /* ignore */ }
    }
    telemetry.record('settings.backup', { backups: result.backups });
    log(`settings.json 已备份（共 ${result.backups} 份滚动备份）`);
  } catch (error) {
    telemetry.record('settings.backup.error', { error: String(error?.message || error).slice(0, 80) });
  }
  return result;
}

module.exports = { backupSettings, BACKUP_KEEP, _internals: { listBackups } };
