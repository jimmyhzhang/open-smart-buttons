// The hardware, drawn as a physical object. Shows exactly what the device shows (frames come
// from the HID stream) and, in Use mode, turns pointer gestures into real HID input reports.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { client, useFrames, usePressed, act } from '../api.ts';
import type { ActionInstance, ActionMeta, DeviceSummary, Page } from '../../../src/shared/types.ts';
import {
  encodeEncoderPressInput,
  encodeEncoderRotateInput,
  encodeKeysInput,
  encodeTouchInput,
} from '../../../src/protocol/reports.ts';
import { ButtonKeyboardInput, isButtonActivationKey } from '../lib/button-keyboard-input.ts';

export type Slot = { kind: 'key' | 'dial'; index: number };
export type Mode = 'edit' | 'use';

interface Props {
  device: DeviceSummary;
  page: Page | undefined;
  catalog: Map<string, ActionMeta>;
  mode: Mode;
  selected: Slot | null;
  onSelect(s: Slot | null): void;
  onConfigure?(s: Slot): void;
  onDropAction(s: Slot, type: string): void;
  onMoveSlot(from: Slot, to: Slot, copy: boolean): void;
  onContext(s: Slot, x: number, y: number): void;
  /** What the Neo's left and right touch points do. */
  touchLabels?: [string, string];
}

const K = 96; // key size (px)
const G = 22; // key gap
const send = (deviceId: string, report: Uint8Array) => act('devices.virtualInput', { deviceId, report: Array.from(report) });
const dialogOpen = () => document.querySelector('dialog[open]') !== null;

export function DeviceView(p: Props) {
  const { device } = p;
  const frames = useFrames(device.id);
  const pressed = usePressed(device.id);
  const cols = device.columns;
  const rows = device.rows;
  const gridW = cols * K + (cols - 1) * G;
  const hasStrip = !!device.lcd && device.encoders > 0;
  const stripH = hasStrip ? Math.round((gridW * device.lcd!.height) / device.lcd!.width) : 0;
  const keyStates = useMemo(() => new Array<boolean>(cols * rows + (device.touchPoints ?? 0)).fill(false),
    [device.id, cols, rows, device.touchPoints]);
  const keyboardButtons = useMemo(() => new ButtonKeyboardInput(keyStates, (states) => {
    void send(device.id, encodeKeysInput(states));
  }), [device.id, keyStates]);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const brightness = device.brightness;
  const asleep = device.sim?.asleep;

  useEffect(() => {
    const release = () => keyboardButtons.releaseAll();
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('blur', release);
      release();
    };
  }, [keyboardButtons, p.mode]);

  const keyboardProps = (index: number, enabled: boolean) => ({
    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!enabled || !isButtonActivationKey(e.key)) return;
      e.preventDefault(); // The raw down/up handlers own activation, not the browser's click.
      if (dialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.repeat) keyboardButtons.press(index);
    },
    onKeyUp: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!enabled || !isButtonActivationKey(e.key)) return;
      e.preventDefault();
      keyboardButtons.release(index);
    },
    onBlur: () => keyboardButtons.release(index),
  });

  // Keyboard: digits press keys in Use mode.
  useEffect(() => {
    if (p.mode !== 'use') return;
    const down = (e: KeyboardEvent, isDown: boolean) => {
      if (isDown && (dialogOpen() || (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > cols * rows || e.repeat) return;
      if (isDown) keyboardButtons.press(n - 1);
      else keyboardButtons.release(n - 1);
    };
    const d = (e: KeyboardEvent) => down(e, true);
    const u = (e: KeyboardEvent) => down(e, false);
    window.addEventListener('keydown', d);
    window.addEventListener('keyup', u);
    return () => {
      window.removeEventListener('keydown', d);
      window.removeEventListener('keyup', u);
    };
  }, [p.mode, cols, rows, keyboardButtons]);

  const dropProps = (s: Slot) => {
    const id = `${s.kind}${s.index}`;
    const meta = (type: string) => p.catalog.get(type);
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-sdp-action') || e.dataTransfer.types.includes('application/x-sdp-slot')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-sdp-slot') && !e.altKey ? 'move' : 'copy';
          setDragOver(id);
        }
      },
      onDragLeave: () => setDragOver((d) => (d === id ? null : d)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(null);
        const type = e.dataTransfer.getData('application/x-sdp-preset') || e.dataTransfer.getData('application/x-sdp-action');
        if (type) {
          void meta;
          p.onDropAction(s, type);
          return;
        }
        const from = e.dataTransfer.getData('application/x-sdp-slot');
        if (from) p.onMoveSlot(JSON.parse(from), s, e.altKey);
      },
    };
  };

  const dragSource = (s: Slot, inst: ActionInstance | null | undefined) =>
    p.mode === 'edit' && inst
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData('application/x-sdp-slot', JSON.stringify(s));
            e.dataTransfer.effectAllowed = 'copyMove';
          },
        }
      : {};

  const isSel = (s: Slot) => p.selected?.kind === s.kind && p.selected.index === s.index;

  return (
    <div className="device-wrap">
      <div
        className={`device ${p.mode}`}
        style={{ '--grid-w': `${gridW}px` } as CSSProperties}
        onClick={(e) => {
          if (e.target === e.currentTarget && p.mode === 'edit') p.onSelect(null);
        }}
      >
        <div className="device-glass" style={{ filter: asleep ? 'brightness(0.06)' : `brightness(${0.35 + 0.65 * (brightness / 100)})` }}>
          <div className="keys" style={{ gridTemplateColumns: `repeat(${cols}, ${K}px)`, gap: G }}>
            {Array.from({ length: cols * rows }, (_, i) => {
              const s: Slot = { kind: 'key', index: i };
              const inst = p.page?.keys[i];
              const img = frames?.keys[i];
              const isDown = pressed.has(`key:${i}`);
              return (
                <button
                  key={i}
                  id={`deck-key-${i}`}
                  className={`key ${isSel(s) ? 'sel' : ''} ${isDown ? 'down' : ''} ${dragOver === `key${i}` ? 'over' : ''} ${inst ? '' : 'empty'}`}
                  aria-pressed={p.mode === 'edit' ? isSel(s) : undefined}
                  aria-label={inst ? `Key ${i + 1}: ${inst.appearance.title?.replace(/\s+/g, ' ').trim() || p.catalog.get(inst.type)?.name}` : `Key ${i + 1}: empty`}
                  {...dropProps(s)}
                  {...dragSource(s, inst)}
                  {...keyboardProps(i, p.mode === 'use')}
                  onClick={(e) => {
                    if (p.mode === 'edit') p.onSelect(s);
                    else if (e.detail === 0 && !dialogOpen() && !e.metaKey && !e.ctrlKey && !e.altKey) keyboardButtons.activate(i);
                  }}
                  onDoubleClick={() => { if (p.mode === 'edit' && inst) p.onConfigure?.(s); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    p.onSelect(s);
                    p.onContext(s, e.clientX, e.clientY);
                  }}
                  onPointerDown={(e) => {
                    if (p.mode !== 'use' || e.button !== 0) return;
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    keyStates[i] = true;
                    void send(device.id, encodeKeysInput(keyStates));
                  }}
                  onPointerUp={() => {
                    if (p.mode !== 'use' || !keyStates[i]) return;
                    keyStates[i] = false;
                    void send(device.id, encodeKeysInput(keyStates));
                  }}
                  onPointerCancel={() => {
                    if (!keyStates[i]) return;
                    keyStates[i] = false;
                    void send(device.id, encodeKeysInput(keyStates));
                  }}
                >
                  {img ? <img src={`data:image/jpeg;base64,${img}`} alt="" draggable={false} /> : null}
                  {p.mode === 'edit' && !inst ? <span className="plus" aria-hidden>+</span> : null}
                </button>
              );
            })}
          </div>
          {device.infoBar ? (
            <div className="neo-bar" style={{ width: gridW }}>
              {Array.from({ length: device.touchPoints }, (_, t) => {
                const idx = cols * rows + t;
                const color = device.touchPointColors?.[t];
                const tp = (
                  <button
                    key={`tp${t}`}
                    className={`touchpoint ${pressed.has(`touchpoint:${t}`) ? 'down' : ''}`}
                    aria-label={`Touch point: ${(p.touchLabels?.[t] ?? (t === 0 ? 'Previous page' : 'Next page')).toLowerCase()}`}
                    title={p.touchLabels?.[t] ?? (t === 0 ? 'Previous page' : 'Next page')}
                    {...keyboardProps(idx, true)}
                    onClick={(e) => { if (e.detail === 0 && !dialogOpen() && !e.metaKey && !e.ctrlKey && !e.altKey) keyboardButtons.activate(idx); }}
                    style={color && color !== '#000000' ? { boxShadow: `0 0 10px ${color}, inset 0 0 0 1px ${color}` } : undefined}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      keyStates[idx] = true;
                      void send(device.id, encodeKeysInput(keyStates));
                    }}
                    onPointerUp={() => {
                      if (!keyStates[idx]) return;
                      keyStates[idx] = false;
                      void send(device.id, encodeKeysInput(keyStates));
                    }}
                    onPointerCancel={() => {
                      if (!keyStates[idx]) return;
                      keyStates[idx] = false;
                      void send(device.id, encodeKeysInput(keyStates));
                    }}
                  />
                );
                return t === 0 ? [tp, <div key="info" className="infobar" style={{ aspectRatio: `${device.infoBar!.width} / ${device.infoBar!.height}` }}>{frames?.infoBar ? <img src={`data:image/jpeg;base64,${frames.infoBar}`} alt="Info bar" /> : <span>Info bar</span>}</div>] : tp;
              })}
            </div>
          ) : null}
          {hasStrip ? (
            <TouchStrip
              device={device}
              frames={frames}
              width={gridW}
              height={stripH}
              mode={p.mode}
              page={p.page}
              selected={p.selected}
              onSelect={p.onSelect}
              dropProps={dropProps}
              dragOver={dragOver}
              onContext={p.onContext}
            />
          ) : null}
        </div>
        {device.encoders > 0 ? (
          <div className="knobs" style={{ width: gridW }}>
            {Array.from({ length: device.encoders }, (_, i) => {
              const s: Slot = { kind: 'dial', index: i };
              const inst = p.page?.dials[i];
              return (
                <Knob
                  key={i}
                  deviceId={device.id}
                  index={i}
                  label={inst ? inst.appearance.title || p.catalog.get(inst.type)?.name || '' : ''}
                  mode={p.mode}
                  selected={isSel(s)}
                  over={dragOver === `dial${i}`}
                  pressed={pressed.has(`dial:${i}`)}
                  dropProps={dropProps(s)}
                  dragSource={dragSource(s, inst)}
                  onSelect={() => p.onSelect(s)}
                  onContext={(x, y) => {
                    p.onSelect(s);
                    p.onContext(s, x, y);
                  }}
                />
              );
            })}
          </div>
        ) : null}
        <div className="device-badge">{device.modelName}</div>
      </div>
    </div>
  );
}

function TouchStrip(props: {
  device: DeviceSummary;
  frames: ReturnType<typeof useFrames>;
  width: number;
  height: number;
  mode: Mode;
  page: Page | undefined;
  selected: Slot | null;
  onSelect(s: Slot | null): void;
  dropProps(s: Slot): Record<string, unknown>;
  dragOver: string | null;
  onContext(s: Slot, x: number, y: number): void;
}) {
  const { device, frames } = props;
  const lcd = device.lcd!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<{ x: number; y: number; x2: number; y2: number; t: number; long: boolean; timer: number } | null>(null);
  const [ripple, setRipple] = useState<{ x: number; y: number; k: number } | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !frames) return;
    const ctx = c.getContext('2d')!;
    let cancelled = false;
    void (async () => {
      const imgs = await Promise.all(
        frames.lcd.map(async (r) => {
          const blob = await (await fetch(`data:image/jpeg;base64,${r.jpeg}`)).blob();
          return { r, bmp: await createImageBitmap(blob) };
        }),
      );
      if (cancelled) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, lcd.width, lcd.height);
      for (const { r, bmp } of imgs) ctx.drawImage(bmp, r.x, r.y, r.width, r.height);
    })();
    return () => {
      cancelled = true;
    };
  }, [frames?.rev, frames, lcd.width, lcd.height]);

  const toLcd = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(lcd.width - 1, ((e.clientX - rect.left) / rect.width) * lcd.width)),
      y: Math.max(0, Math.min(lcd.height - 1, ((e.clientY - rect.top) / rect.height) * lcd.height)),
    };
  };
  const zoneW = lcd.width / device.encoders;

  return (
    <div
      className={`strip ${props.mode}`}
      style={{ width: props.width, height: props.height }}
      onPointerDown={(e) => {
        if (props.mode !== 'use' || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const pt = toLcd(e);
        const g = { x: pt.x, y: pt.y, x2: pt.x, y2: pt.y, t: Date.now(), long: false, timer: 0 };
        g.timer = window.setTimeout(() => {
          if (Math.hypot(g.x2 - g.x, g.y2 - g.y) < 30) {
            g.long = true;
            void send(device.id, encodeTouchInput('long', g.x, g.y));
          }
        }, 500);
        gesture.current = g;
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g) return;
        const pt = toLcd(e);
        g.x2 = pt.x;
        g.y2 = pt.y;
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        gesture.current = null;
        if (!g) return;
        clearTimeout(g.timer);
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setRipple({ x: (g.x / lcd.width) * rect.width, y: (g.y / lcd.height) * rect.height, k: Date.now() });
        if (g.long) return;
        if (Math.hypot(g.x2 - g.x, g.y2 - g.y) >= 30) void send(device.id, encodeTouchInput('swipe', g.x, g.y, g.x2, g.y2));
        else void send(device.id, encodeTouchInput('tap', g.x, g.y));
      }}
    >
      <canvas ref={canvas} width={lcd.width} height={lcd.height} />
      {ripple ? <span key={ripple.k} className="ripple" style={{ left: ripple.x, top: ripple.y }} /> : null}
      {props.mode === 'edit'
        ? Array.from({ length: device.encoders }, (_, i) => {
            const s: Slot = { kind: 'dial', index: i };
            const sel = props.selected?.kind === 'dial' && props.selected.index === i;
            return (
              <div
                key={i}
                className={`zone ${sel ? 'sel' : ''} ${props.dragOver === `dial${i}` ? 'over' : ''}`}
                style={{ left: `${((i * zoneW) / lcd.width) * 100}%`, width: `${(zoneW / lcd.width) * 100}%` }}
                onClick={() => props.onSelect(s)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onContext(s, e.clientX, e.clientY);
                }}
                {...props.dropProps(s)}
              >
                {!props.page?.dials[i] ? <span className="plus">+</span> : null}
              </div>
            );
          })
        : null}
    </div>
  );
}

function Knob(props: {
  deviceId: string;
  index: number;
  label: string;
  mode: Mode;
  selected: boolean;
  over: boolean;
  pressed: boolean;
  dropProps: Record<string, unknown>;
  dragSource: Record<string, unknown>;
  onSelect(): void;
  onContext(x: number, y: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const angle = useFramesAngle(props.deviceId, props.index);
  const wheelAcc = useRef(0);
  const drag = useRef<{ a: number; acc: number; moved: boolean; t: number; downSent: boolean; timer: number } | null>(null);
  const pressState = useRef([false, false, false, false]);

  const rotate = (ticks: number) => {
    const d = [0, 0, 0, 0];
    d[props.index] = ticks;
    void send(props.deviceId, encodeEncoderRotateInput(d));
  };
  const press = (down: boolean) => {
    pressState.current[props.index] = down;
    void send(props.deviceId, encodeEncoderPressInput(pressState.current));
  };

  // Wheel turns the knob in both modes (non-passive so the page doesn't scroll).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const ticks = Math.trunc(wheelAcc.current / 40);
      if (ticks) {
        wheelAcc.current -= ticks * 40;
        rotate(Math.max(-8, Math.min(8, -ticks)));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const angleAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };

  return (
    <div className={`knob-cell ${props.selected ? 'sel' : ''} ${props.over ? 'over' : ''}`} {...props.dropProps}>
      <div
        ref={ref}
        className={`knob ${props.pressed ? 'down' : ''}`}
        role="spinbutton"
        aria-roledescription="dial"
        aria-label={`Dial ${props.index + 1}${props.label ? `: ${props.label}` : ''}`}
        aria-description="Arrow keys turn it, Enter presses it"
        tabIndex={0}
        {...props.dragSource}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') rotate(1);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') rotate(-1);
          else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            press(true);
            setTimeout(() => press(false), 90);
          }
        }}
        onClick={() => props.mode === 'edit' && props.onSelect()}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onContext(e.clientX, e.clientY);
        }}
        onPointerDown={(e) => {
          if (props.mode !== 'use' || e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const d = { a: angleAt(e), acc: 0, moved: false, t: Date.now(), downSent: false, timer: 0 };
          // Holding without turning = a real press (so press-and-hold actions work).
          d.timer = window.setTimeout(() => {
            if (!d.moved) {
              d.downSent = true;
              press(true);
            }
          }, 250);
          drag.current = d;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const a = angleAt(e);
          let delta = a - d.a;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          d.a = a;
          d.acc += delta;
          const ticks = Math.trunc(d.acc / 15);
          if (ticks) {
            d.acc -= ticks * 15;
            d.moved = true;
            rotate(ticks);
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          clearTimeout(d.timer);
          if (d.downSent) press(false);
          else if (!d.moved) {
            press(true);
            setTimeout(() => press(false), 60);
          }
        }}
      >
        <div className="knob-cap" style={{ transform: `rotate(${angle}deg)` }}>
          <span className="knob-mark" />
        </div>
      </div>
      <div className="knob-label">{props.label || (props.mode === 'edit' ? 'Empty' : '')}</div>
    </div>
  );
}

function useFramesAngle(deviceId: string, index: number) {
  useFrames(deviceId); // re-render on input events
  return client.angles.get(deviceId)?.[index] ?? 0;
}
