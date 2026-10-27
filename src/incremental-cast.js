import { initCastPanel } from './cast-panel.js';
import { initPosterRelay } from './poster-relay.js';

let bridge = null;

export function getBridge() {
  return bridge;
}

export function initIncrementalCast(deps = {}) {
  bridge = deps;

  try {
    initPosterRelay({ api: deps.api });
  } catch (error) {
    console.warn('[CineFlow] 海报兜底加载初始化失败，已跳过', error);
  }

  try {
    initCastPanel();
  } catch (error) {
    console.warn('[CineFlow] 投屏面板初始化失败，已跳过', error);
  }
}
