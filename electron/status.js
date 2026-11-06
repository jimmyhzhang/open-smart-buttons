// Status page shown while the editor cannot load: starting, restarting, fatal and startup errors.
'use strict';
const root = document.getElementById('root');
const native = window.sdpNative;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'onclick') node.addEventListener('click', value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function button(label, command, primary) {
  return el('button', {
    class: primary ? 'primary' : '',
    onclick: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        const result = await native.command(command);
        if (result && typeof result.message === 'string' && result.message) note(result.message, !result.ok);
      } catch (error) {
        note(String(error && error.message || error), true);
      } finally { target.disabled = false; }
    },
  }, label);
}

let lastNote = null;
function note(text, isError) {
  lastNote?.remove();
  lastNote = el('p', { class: 'note', role: isError ? 'alert' : 'status' }, text);
  root.append(lastNote);
}

function render(state) {
  const s = state.service;
  root.replaceChildren();
  lastNote = null;
  if (s.phase === 'starting' || s.phase === 'ready' || s.phase === 'stopping') {
    root.append(el('div', { class: 'spinner', 'aria-hidden': 'true' }), el('h1', {}, s.phase === 'stopping' ? 'Quitting…' : 'Starting StreamDeckPlus…'));
    return;
  }
  if (s.phase === 'restarting') {
    root.append(el('div', { class: 'spinner', 'aria-hidden': 'true' }), el('h1', {}, 'Reconnecting…'));
    return;
  }
  const actions = el('div', { class: 'actions' });
  if (s.phase === 'fatal') {
    root.append(el('div', { class: 'glyph', 'aria-hidden': 'true' }, '!'), el('h1', {}, 'StreamDeckPlus stopped unexpectedly.'),
      el('p', {}, 'It restarted several times in a row. The log may say why.'));
    actions.append(button('Restart', 'service.restart', true), button('Show Log', 'logs.show'));
  } else if (s.kind === 'config-invalid') {
    root.append(el('div', { class: 'glyph', 'aria-hidden': 'true' }, '!'), el('h1', {}, "Your settings couldn't be read."),
      el('p', {}, 'Repair writes a fixed copy and keeps the original folder next to it. Nothing is deleted.'),
      el('p', { class: 'detail' }, s.message));
    actions.append(button('Repair', 'service.repair', true), button('Show in Finder', 'data.show'), button('Start Fresh', 'service.startFresh'));
  } else if (s.kind === 'locked') {
    root.append(el('div', { class: 'glyph', 'aria-hidden': 'true' }, '⌘'), el('h1', {}, 'StreamDeckPlus is already running from Terminal.'),
      el('p', {}, 'Quit it there, then try again.'));
    actions.append(button('Try Again', 'service.restart', true));
  } else {
    root.append(el('div', { class: 'glyph', 'aria-hidden': 'true' }, '!'), el('h1', {}, "StreamDeckPlus couldn't start."),
      el('p', { class: 'detail' }, s.message));
    actions.append(button('Try Again', 'service.restart', true), button('Show Log', 'logs.show'));
  }
  root.append(actions);
  actions.querySelector('button')?.focus();
}

if (native) {
  native.onState(render);
  native.getState().then(render, () => {});
}
