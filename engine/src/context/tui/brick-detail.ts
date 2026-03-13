import type { BrickResult } from '../types.js';
import { renderStaticDetail } from './detail-static.js';
import { renderTreeDetail } from './detail-tree.js';
import { renderMatchedDetail } from './detail-matched.js';
import { renderFlexDetail } from './detail-flex.js';

/**
 * Dispatches to the appropriate type-aware detail renderer based on brick.type.
 * Pure function — no side effects.
 */
export function renderBrickDetail(
  brick: BrickResult,
  budget: number,
  scrollOffset: number,
  selectedField?: string,
  editingValue?: string,
): string {
  switch (brick.type) {
    case 'static':
      return renderStaticDetail(brick, budget, scrollOffset);
    case 'tree':
      return renderTreeDetail(brick, budget, scrollOffset, selectedField, editingValue);
    case 'matched':
      return renderMatchedDetail(brick, budget, scrollOffset, selectedField, editingValue);
    case 'flex':
      return renderFlexDetail(brick, budget, scrollOffset, selectedField, editingValue);
    default:
      return renderStaticDetail(brick, budget, scrollOffset);
  }
}
