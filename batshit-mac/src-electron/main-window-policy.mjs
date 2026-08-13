const MAIN_CHAT_MIN_WIDTH = 480;
const PERSISTENT_RAIL_WIDTH = 48;

export function resolveMainWindowSizePolicy() {
  return Object.freeze({
    width: 1600,
    height: 1000,
    minWidth: MAIN_CHAT_MIN_WIDTH + (PERSISTENT_RAIL_WIDTH * 2),
    minHeight: 720
  });
}
