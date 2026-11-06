/** Keyboard ownership of a button press, sharing the raw state with pointer input. */
export class ButtonKeyboardInput {
  private held = new Set<number>();
  private states: boolean[];
  private emit: (states: boolean[]) => void;

  constructor(states: boolean[], emit: (states: boolean[]) => void) {
    this.states = states;
    this.emit = emit;
  }

  press(index: number): void {
    if (this.held.has(index) || this.states[index]) return;
    this.held.add(index);
    this.states[index] = true;
    this.emit(this.states);
  }

  release(index: number): void {
    if (!this.held.delete(index)) return;
    this.states[index] = false;
    this.emit(this.states);
  }

  releaseAll(): void {
    if (!this.held.size) return;
    for (const index of this.held) this.states[index] = false;
    this.held.clear();
    this.emit(this.states);
  }

  /** Assistive technologies can activate a button with a click and no key events. */
  activate(index: number): void {
    if (this.states[index]) return;
    this.press(index);
    this.release(index);
  }
}

export function isButtonActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}
