import { spawnSync } from 'child_process';
import { enterAltScreen, exitAltScreen, clearScreen, hideCursor, showCursor } from './render.js';
import { renderOverview } from './overview.js';
import { renderBrickDetail } from './brick-detail.js';
import { renderAssemblyView } from './assembly-view.js';
import type { AssemblyResult } from '../assembler.js';
import { assembleContext } from '../assembler.js';
import type { Brick } from '../types.js';
import type { ContextConfig } from '../config.js';
import { saveConfig } from '../config.js';
import { MODELS } from '../models.js';

const BUDGET = MODELS.sonnet.contextWindow;

type View =
  | { type: 'overview'; selectedIndex: number }
  | { type: 'detail'; brickIndex: number; scrollOffset: number }
  | { type: 'assembly'; scrollOffset: number };

function render(
  state: View,
  result: AssemblyResult,
  configFields: string[],
  selectedFieldIndex: number,
  editingField: string | null,
  editingValue: string,
  config?: ContextConfig,
): void {
  clearScreen();
  let output: string;
  if (state.type === 'overview') {
    output = renderOverview(result, state.selectedIndex, BUDGET, config);
  } else if (state.type === 'detail') {
    const brick = result.sections[state.brickIndex];
    const selectedField = configFields.length > 0
      ? configFields[selectedFieldIndex]
      : undefined;
    const evArg = (editingField !== null && editingField === selectedField)
      ? editingValue
      : undefined;
    output = renderBrickDetail(brick, BUDGET, state.scrollOffset, selectedField, evArg);
  } else {
    output = renderAssemblyView(result, state.scrollOffset);
  }
  process.stdout.write(output);
}

export async function launchTUI(
  initialResult: AssemblyResult,
  bricks?: Brick[],
  config?: ContextConfig,
): Promise<void> {
  let result = initialResult;
  let state: View = { type: 'overview', selectedIndex: 0 };

  // Config field navigation state
  let configFields: string[] = [];
  let selectedFieldIndex: number = 0;

  // Editing state
  let editingField: string | null = null;
  let editingValue: string = '';

  const doRender = (): void =>
    render(state, result, configFields, selectedFieldIndex, editingField, editingValue, config);

  // Populate configFields when entering detail view
  function enterDetail(brickIndex: number): void {
    state = { type: 'detail', brickIndex, scrollOffset: 0 };
    const brick = result.sections[brickIndex];
    const mc = brick.meta?.config;
    configFields = mc ? Object.keys(mc) : [];
    selectedFieldIndex = 0;
    editingField = null;
    editingValue = '';
  }

  enterAltScreen();
  hideCursor();
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Re-render on terminal resize
  const onResize = (): void => doRender();
  process.stdout.on('resize', onResize);

  const cleanup = (): void => {
    process.stdout.off('resize', onResize);
    showCursor();
    exitAltScreen();
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  doRender();

  // Re-assemble after editor/config change
  function reassemble(): void {
    if (bricks) {
      result = assembleContext(bricks, { config: config as unknown as Record<string, unknown> });
    }
  }

  // Open editor on a static brick's source file
  function openEditor(sourcePath: string): void {
    // Suspend TUI
    exitAltScreen();
    showCursor();
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);

    const editor = process.env.EDITOR ?? (process.platform === 'darwin' ? 'open' : 'vi');
    spawnSync(editor, [sourcePath], { stdio: 'inherit' });

    // Resume TUI
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    hideCursor();
    enterAltScreen();

    reassemble();
    doRender();
  }

  try {
    await new Promise<void>((resolve) => {
      const onData = (data: Buffer): void => {
        const bytes = data;

        // ── Editing mode ────────────────────────────────────────────
        if (editingField !== null) {
          if (bytes[0] === 0x1b) {
            // Escape — cancel editing
            editingField = null;
            editingValue = '';
          } else if (bytes[0] === 0x0d) {
            // Enter — save and re-assemble
            if (state.type === 'detail' && config) {
              const brick = result.sections[state.brickIndex];
              const brickKey = brick.name.toLowerCase() as keyof typeof config.bricks;
              const brickCfg = config.bricks[brickKey] as Record<string, unknown> | undefined;
              if (brickCfg && editingField in brickCfg) {
                const parsed = parseFloat(editingValue);
                if (!isNaN(parsed)) {
                  (brickCfg as Record<string, unknown>)[editingField] = parsed;
                  saveConfig(config);
                  reassemble();
                  // Refresh configFields from updated brick
                  const updatedBrick = result.sections[state.brickIndex];
                  const mc = updatedBrick.meta?.config;
                  configFields = mc ? Object.keys(mc) : [];
                }
              }
            }
            editingField = null;
            editingValue = '';
          } else if (bytes[0] === 0x7f || bytes[0] === 0x08) {
            // Backspace
            editingValue = editingValue.slice(0, -1);
          } else {
            // Digits and decimal point
            const ch = String.fromCharCode(bytes[0]);
            if (/[\d.]/.test(ch)) {
              editingValue += ch;
            }
          }
          doRender();
          return;
        }

        // ── Overview mode ───────────────────────────────────────────
        if (state.type === 'overview') {
          if (bytes[0] === 0x1b && bytes[1] === 0x5b) {
            if (bytes[2] === 0x41) {
              // Up arrow
              state = {
                type: 'overview',
                selectedIndex: Math.max(0, state.selectedIndex - 1),
              };
            } else if (bytes[2] === 0x42) {
              // Down arrow
              const max = Math.max(0, result.sections.length - 1);
              state = {
                type: 'overview',
                selectedIndex: Math.min(max, state.selectedIndex + 1),
              };
            }
          } else if (bytes[0] === 0x6b) {
            // k
            state = {
              type: 'overview',
              selectedIndex: Math.max(0, state.selectedIndex - 1),
            };
          } else if (bytes[0] === 0x6a) {
            // j
            const max = Math.max(0, result.sections.length - 1);
            state = {
              type: 'overview',
              selectedIndex: Math.min(max, state.selectedIndex + 1),
            };
          } else if (bytes[0] === 0x0d) {
            // Enter
            enterDetail(state.selectedIndex);
          } else if (bytes[0] === 0x61) {
            // a — view full assembly
            state = { type: 'assembly', scrollOffset: 0 };
          } else if (bytes[0] === 0x71 || bytes[0] === 0x03) {
            // q or Ctrl-C
            process.stdin.off('data', onData);
            resolve();
            return;
          }

        // ── Detail mode ─────────────────────────────────────────────
        } else if (state.type === 'detail') {
          if (bytes[0] === 0x03) {
            // Ctrl-C — exit entirely
            process.stdin.off('data', onData);
            resolve();
            return;
          } else if (bytes[0] === 0x71) {
            // q — back to overview
            configFields = [];
            selectedFieldIndex = 0;
            state = { type: 'overview', selectedIndex: state.brickIndex };
          } else if (bytes[0] === 0x1b && bytes[1] === 0x5b) {
            // Arrow keys
            if (bytes[2] === 0x41) {
              // Up — scroll
              state = { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) };
            } else if (bytes[2] === 0x42) {
              // Down — scroll
              state = { ...state, scrollOffset: state.scrollOffset + 1 };
            } else if (bytes[2] === 0x48) {
              // Home
              state = { ...state, scrollOffset: 0 };
            } else if (bytes[2] === 0x46) {
              // End
              state = { ...state, scrollOffset: 99999 };
            }
          } else if (bytes[0] === 0x6b) {
            // k — scroll up
            state = { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) };
          } else if (bytes[0] === 0x6a) {
            // j — scroll down
            state = { ...state, scrollOffset: state.scrollOffset + 1 };
          } else if (bytes[0] === 0x09) {
            // Tab — cycle config fields
            if (configFields.length > 0) {
              selectedFieldIndex = (selectedFieldIndex + 1) % configFields.length;
            }
          } else if (bytes[0] === 0x0d) {
            // Enter — start editing selected config field (for non-static bricks)
            const brick = result.sections[state.brickIndex];
            if (brick.type !== 'static' && configFields.length > 0) {
              const fieldName = configFields[selectedFieldIndex];
              const currentVal = brick.meta?.config?.[fieldName];
              editingField = fieldName;
              editingValue = currentVal !== undefined ? String(currentVal) : '';
            }
          } else if (bytes[0] === 0x65) {
            // e — open editor for static bricks with sourcePath
            const brick = result.sections[state.brickIndex];
            const sourcePath = brick.meta?.sourcePath;
            if (brick.type === 'static' && sourcePath) {
              openEditor(sourcePath);
              return; // openEditor already calls doRender
            }
          } else if (bytes[0] === 0x1b && bytes[1] !== 0x5b) {
            // Escape NOT followed by [ — back to overview
            configFields = [];
            selectedFieldIndex = 0;
            state = { type: 'overview', selectedIndex: state.brickIndex };
          }

        // ── Assembly mode ───────────────────────────────────────────
        } else if (state.type === 'assembly') {
          if (bytes[0] === 0x03) {
            // Ctrl-C — exit entirely
            process.stdin.off('data', onData);
            resolve();
            return;
          } else if (bytes[0] === 0x71) {
            // q — back to overview
            state = { type: 'overview', selectedIndex: 0 };
          } else if (bytes[0] === 0x1b && bytes[1] === 0x5b) {
            if (bytes[2] === 0x41) {
              state = { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) };
            } else if (bytes[2] === 0x42) {
              state = { ...state, scrollOffset: state.scrollOffset + 1 };
            } else if (bytes[2] === 0x48) {
              state = { ...state, scrollOffset: 0 };
            } else if (bytes[2] === 0x46) {
              state = { ...state, scrollOffset: 99999 };
            }
          } else if (bytes[0] === 0x6b) {
            state = { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) };
          } else if (bytes[0] === 0x6a) {
            state = { ...state, scrollOffset: state.scrollOffset + 1 };
          } else if (bytes[0] === 0x1b && bytes[1] !== 0x5b) {
            state = { type: 'overview', selectedIndex: 0 };
          }
        }

        doRender();
      };

      process.stdin.on('data', onData);
    });
  } finally {
    cleanup();
  }

  process.exit(0);
}
