const QWEN_CODE_TURN_KEY_PREFIX = "qwen-turn-";

export function qwenCodeTurnKey(ordinal: number): string {
  return `${QWEN_CODE_TURN_KEY_PREFIX}${ordinal}`;
}
